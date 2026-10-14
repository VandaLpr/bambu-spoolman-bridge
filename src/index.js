// Entry point: wires config, store, Spoolman, Home Assistant, trackers, notifier and HTTP.

import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createExecutor } from './executor.js';
import { connectHa } from './ha/client.js';
import { formatReport, missingRequired, resolveEntities } from './ha/entities.js';
import { addSecret, createLogger, setLogLevel } from './log.js';
import { createNotifier, parseAction } from './notifier.js';
import { createApp } from './server.js';
import { loadColorTable } from './bambu/colors.js';
import { restoreAlpha } from './maintenance.js';
import { createIntake } from './intake.js';
import { createSpoolmanClient } from './spoolman/client.js';
import { openStore } from './store.js';
import { PrinterTracker, resolvePending } from './tracker.js';
import { reportedFor } from './choices.js';

const REQUIRED_FIELDS = { spool: ['rfid_uuid'], filament: ['bambu_filament_id', 'bambu_color_code'] };
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const log = createLogger('bridge');

async function checkSpoolman(spoolman) {
  const info = await spoolman.info();
  log.info(`Spoolman ${info.version} reachable`);
  for (const [entity, keys] of Object.entries(REQUIRED_FIELDS)) {
    const existing = new Set((await spoolman.listFields(entity)).map((f) => f.key));
    for (const key of keys) {
      if (!existing.has(key)) log.error(`Spoolman is missing the ${entity} extra field "${key}"; create it under Settings > Extra fields`);
    }
  }
}

async function main() {
  const config = loadConfig();
  addSecret(config.haToken);
  setLogLevel(config.logLevel);
  log.info(`bambu-spoolman-bridge ${version} starting${config.dryRun ? ' in DRY_RUN mode (no Spoolman writes)' : ''}`);

  mkdirSync(config.dataDir, { recursive: true });
  const store = openStore(path.join(config.dataDir, 'bridge.db'));
  const spoolman = createSpoolmanClient({ baseUrl: config.spoolmanUrl, dryRun: config.dryRun, log: createLogger('spoolman') });
  // Intake is user-initiated: it always writes, whatever DRY_RUN says.
  const intakeSpoolman = createSpoolmanClient({ baseUrl: config.spoolmanUrl, dryRun: false, log: createLogger('intake') });
  const colorTable = await loadColorTable({ ref: config.bambuColorRef, dataDir: config.dataDir, log: createLogger('bambu') });
  // One-time: restore the alpha of translucent colours imported before it was kept.
  await restoreAlpha({ store, spoolman: intakeSpoolman, colorTable, log: createLogger('maintenance') }).catch((e) =>
    log.warn(`alpha correction failed, retried at the next start: ${e.message}`),
  );
  const status = { spoolmanOk: false, entitiesOk: false, startedAt: new Date().toISOString() };

  try {
    await checkSpoolman(spoolman);
    status.spoolmanOk = true;
  } catch (e) {
    log.error(`Spoolman check failed: ${e.message}; deductions will queue until it is reachable`);
  }

  const ha = await connectHa({ url: config.haUrl, token: config.haToken, log: createLogger('ha') });
  const notifier = createNotifier({
    ha,
    service: config.notifyService,
    dryRun: config.dryRun,
    bridgeUrl: config.bridgeUrl,
    log: createLogger('notify'),
  });
  const executor = createExecutor({ spoolman, store, notifier, dryRun: config.dryRun, log: createLogger('executor') });

  const services = await ha.getServices();
  const notifyName = config.notifyService.split('.')[1];
  if (!services.notify?.[notifyName]) log.error(`notify service ${config.notifyService} not found in Home Assistant`);
  if (!config.bridgeUrl) log.warn('BRIDGE_URL is not set; pending notifications get no "Open bridge" button');

  // answer: { spoolId } or { filamentId }; neither = skip
  const answer = (pendingId, { spoolId = null, filamentId = null } = {}) =>
    resolvePending({ store, spoolman, executor, log, pendingId, spoolId, filamentId });
  const trackers = [];
  const loadedTrayUuids = () => trackers.flatMap((t) => t.trayAttributes().map((a) => a.tray_uuid)).filter(Boolean);

  // First entity snapshot: entity check, then trackers start.
  let first = true;
  ha.subscribeEntities((entities) => {
    if (first) {
      first = false;
      const report = [];
      for (const printer of config.printers) {
        const { ids, report: r } = resolveEntities(printer, entities);
        report.push(...r);
        if (missingRequired(r).length) {
          log.error(`${printer.name}: required entities missing; this printer is not tracked`);
          continue;
        }
        const tracker = new PrinterTracker({
          printer,
          ids,
          store,
          executor,
          notifier,
          ha,
          config,
          loadedTrayUuids,
          colorTable: () => colorTable,
          log: createLogger(printer.name),
        });
        trackers.push(tracker);
      }
      log.info(`entity check:\n  ${formatReport(report).join('\n  ')}`);
      status.entitiesOk = trackers.length === config.printers.length;
      for (const t of trackers) t.startup(entities);
      executor.processQueue().catch((e) => log.error('queue processing failed', e));
      return;
    }
    for (const t of trackers) t.onEntities(entities);
  });

  ha.subscribeEvent('mobile_app_notification_action', async (event) => {
    const parsed = parseAction(event.data?.action);
    if (!parsed) return;
    if (config.dryRun) {
      log.info(`[DRY RUN] notification answer logged only: pending ${parsed.pendingId} -> spool #${parsed.spoolId}`);
      return;
    }
    const result = await answer(parsed.pendingId, { spoolId: parsed.spoolId });
    log.info(`notification answer: ${result.message}`);
  });

  const retry = setInterval(
    () => executor.processQueue().catch((e) => log.error('queue processing failed', e)),
    config.spoolmanRetryMinutes * 60_000,
  );

  const intake = createIntake({ spoolman: intakeSpoolman, store, colorTable: () => colorTable, config, log: createLogger('intake') });
  // Answers from the bridge page: logged only in DRY_RUN, like notification answers.
  const pageAnswer = async (pendingId, given) => {
    if (config.dryRun) {
      const what = given.spoolId != null ? `spool #${given.spoolId}` : given.filamentId != null ? `filament #${given.filamentId}` : 'skip';
      log.info(`[DRY RUN] bridge page answer logged only: pending ${pendingId} -> ${what}`);
      return { ok: true, message: 'DRY_RUN: answer logged only, nothing changed.' };
    }
    return answer(pendingId, given);
  };
  const app = createApp({
    intake,
    store,
    dryRun: config.dryRun,
    resolvePending: pageAnswer,
    choices: {
      inventory: async () => {
        const [filaments, spools] = await Promise.all([spoolman.listFilaments(), spoolman.listSpools()]);
        return { filaments, spools };
      },
      search: (q) => spoolman.searchCatalog(q, { max: 20 }),
      colorTable: () => colorTable,
      // User-initiated like intake: the spool is created even in DRY_RUN; the answer follows the usual rule.
      addFromCatalog: async ({ pendingId, externalId, q }) => {
        const pending = store.getPending(pendingId);
        if (!pending || pending.state !== 'open') return { ok: false, message: `Question ${pendingId} is not open.` };
        const added = await intake.addCatalogSpool({ query: q, externalId, bambuFilamentId: reportedFor(store, pending, colorTable).filamentId });
        const result = await pageAnswer(pendingId, { spoolId: added.spoolId });
        return { ok: result.ok, message: `Spool #${added.spoolId} (${added.filamentName}) added to Spoolman. ${result.message}` };
      },
      // "+ New spool" of a filament without a free spool; created even in DRY_RUN, like intake.
      newSpool: async ({ pendingId, filamentId }) => {
        const pending = store.getPending(pendingId);
        if (!pending || pending.state !== 'open') return { ok: false, message: `Question ${pendingId} is not open.` };
        const added = await intake.addFilamentSpool({ filamentId });
        const result = await pageAnswer(pendingId, { spoolId: added.spoolId });
        return { ok: result.ok, message: `New spool #${added.spoolId} of ${added.filamentName} added to Spoolman. ${result.message}` };
      },
    },
    nearestMaxDeltaE: config.nearestColorMaxDeltaE,
    requeueUsage: async (usageId, spoolId) => {
      if (config.dryRun) {
        log.info(`[DRY RUN] re-queue answer logged only: deduction ${usageId} -> ${spoolId == null ? 'skip' : `spool #${spoolId}`}`);
        return { ok: true, message: 'DRY_RUN: answer logged only, nothing changed.' };
      }
      return executor.requeue(usageId, spoolId);
    },
    health: () => ({
      ok: ha.isConnected() && status.entitiesOk,
      version,
      dryRun: config.dryRun,
      homeAssistant: ha.isConnected(),
      spoolmanCheckedOk: status.spoolmanOk,
      printersTracked: trackers.map((t) => t.printer.name),
      activeJobs: store.listActiveJobs().map((j) => ({ id: j.id, printer: j.printer, task: j.task_name, maxProgress: j.max_progress })),
      openPending: store.listPending('open').length,
      needsAttention: store.usageByState('needs_attention').length,
      startedAt: status.startedAt,
    }),
  });
  const server = app.listen(config.port, () => log.info(`HTTP on :${config.port}`));

  const shutdown = (signal) => {
    log.info(`${signal}: shutting down`);
    clearInterval(retry);
    for (const t of trackers) t.stop();
    server.close();
    ha.close();
    Promise.allSettled(trackers.map((t) => t.idle())).finally(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  log.error(e.message);
  process.exit(1);
});
