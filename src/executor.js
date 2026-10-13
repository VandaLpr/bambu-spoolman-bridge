// Carries out resolver decisions and deductions against Spoolman.
//
// Deduction write path (crash-safe, see store.js for the states):
//   recordDeduction()  usage row inserted as queued / parked / dry_run (UNIQUE per job+source)
//   processQueue()     queued|failed: GET spool -> persist remaining_before as planned -> PUT use -> applied
//                      planned (crash, or network error/timeout on the use call): classifyRecovery()
//   errors             HTTP 4xx -> needs_attention (no retry; requeue() or skip by a person)
//                      HTTP 5xx, network, timeout -> retried; one notification after 12 attempts

import { catalogSearchQuery, planFilament } from './catalog.js';
import { classifyRecovery } from './recovery.js';
import { TagConflictError } from './spoolman/client.js';

// With the default 5-minute retry interval, 12 attempts is about an hour.
export const ATTEMPTS_BEFORE_NOTICE = 12;
const isHttpError = (e) => Number.isInteger(e?.status);
const isClientError = (e) => isHttpError(e) && e.status >= 400 && e.status < 500;

export function createExecutor({ spoolman, store, notifier, dryRun, log, now = () => new Date().toISOString() }) {
  async function loadInventory() {
    const [spools, filaments] = await Promise.all([spoolman.listSpools(), spoolman.listFilaments()]);
    return { spools, filaments };
  }

  async function runWrites(writes) {
    for (const w of writes) {
      if (w.op === 'patchSpool') {
        await spoolman.patchSpool(w.spoolId, w.patch, w.extra ?? null);
      } else if (w.op === 'linkTag') {
        try {
          await spoolman.linkTag(w.spoolId, w.uid, w.format);
        } catch (e) {
          if (!(e instanceof TagConflictError)) throw e;
          log.warn(`could not link tag to spool #${w.spoolId}: ${e.message}`);
          await notifier.problem('RFID tag conflict', `Tag ${w.uid} could not be linked to spool #${w.spoolId}: ${e.message}. Check both spools in Spoolman.`);
        }
      } else {
        throw new Error(`unknown write op ${w.op}`);
      }
    }
  }

  async function ensureVendorId() {
    const vendors = await spoolman.listVendors();
    const found = vendors.find((v) => v.name?.toLowerCase() === 'bambu lab');
    if (found) return found.id;
    return (await spoolman.createVendor({ name: 'Bambu Lab' }))?.id ?? null;
  }

  async function createFromDecision(decision) {
    let filamentId = decision.filamentId;
    if (filamentId == null) {
      const query = decision.filamentQuery;
      const vendorId = await ensureVendorId();
      const catalogEntries = await spoolman.searchCatalog(catalogSearchQuery(query));
      // Fresh filament list: the dedupe gate must see anything created since the inventory snapshot.
      const plan = planFilament({ filaments: await spoolman.listFilaments(), catalogEntries, query, vendorId });
      if (plan.use) {
        filamentId = plan.use.id;
        if (plan.patchExtra) await spoolman.patchFilamentExtra(filamentId, plan.patchExtra);
      } else {
        if (plan.entry) log.info(`importing ${plan.entry.id} from SpoolmanDB`);
        else log.info(`no single SpoolmanDB match for ${query.name} #${query.colorHex}; creating filament from RFID data`);
        filamentId = (await spoolman.createFilament(plan.import ?? plan.create))?.id ?? null;
      }
    }
    const created = await spoolman.createSpool({ ...decision.spool, filament_id: filamentId ?? 'dry-run:new-filament' });
    if (created) await runWrites([{ op: 'linkTag', spoolId: created.id, uid: decision.tagUid, format: 'bambu' }]);
    return created?.id ?? null;
  }

  /** @returns {{ spoolId: number|null, resolution: string }} */
  async function applyDecision(decision) {
    if (decision.status === 'resolved') {
      await runWrites(decision.writes);
      return { spoolId: decision.spoolId, resolution: decision.via };
    }
    if (decision.status === 'create') return { spoolId: await createFromDecision(decision), resolution: 'created' };
    return { spoolId: null, resolution: 'pending' };
  }

  // Synchronous on purpose: the row exists before the job is marked ended.
  function recordDeduction({ job, sourceKey, spoolId, grams, status, skipped = false }) {
    const writeState = skipped ? 'skipped' : dryRun ? 'dry_run' : spoolId == null ? 'parked' : 'queued';
    const id = store.recordUsage({
      jobId: job.id,
      printer: job.printer,
      taskName: job.task_name,
      sourceKey,
      spoolId,
      grams,
      status,
      maxProgress: job.max_progress,
      dryRun,
      writeState,
    });
    if (id && dryRun) log.info(`[DRY RUN] would deduct ${grams} g from spool #${spoolId ?? '?'} (${sourceKey}, job ${job.id})`);
    return id;
  }

  async function send(row) {
    let planned = false;
    try {
      const spool = await spoolman.getSpool(row.spool_id);
      store.setUsageState(row.id, 'planned', { remainingBefore: spool.remaining_weight });
      planned = true;
      await spoolman.useWeight(row.spool_id, row.grams);
    } catch (e) {
      // An HTTP response means Spoolman did not apply the call. Only a network error or
      // timeout after 'planned' leaves it open whether the deduction landed.
      const ambiguous = planned && !isHttpError(e);
      await failed(row, e, ambiguous ? 'planned' : 'failed');
      return;
    }
    store.setUsageState(row.id, 'applied');
    log.info(`deducted ${row.grams} g from spool #${row.spool_id} (${row.source_key}, job ${row.job_id})`);
    try {
      await spoolman.patchSpool(row.spool_id, { last_used: now() });
    } catch (e) {
      log.warn(`last_used not updated on spool #${row.spool_id}: ${e.message}`);
    }
  }

  // 4xx: the request itself is wrong (spool deleted, validation); retrying can't help, so
  // the row waits for a person (re-queue to another spool or skip). Anything else is
  // transient: retried forever, with one notification once ATTEMPTS_BEFORE_NOTICE is reached.
  async function failed(row, e, retryState) {
    const what = `${row.grams} g for spool #${row.spool_id} (job ${row.job_id}, ${row.source_key})`;
    const attempts = store.countUsageAttempt(row.id);
    if (isClientError(e)) {
      store.setUsageState(row.id, 'needs_attention', { error: e.message });
      log.error(`deduction ${row.id} rejected: ${what}: ${e.message}`);
      await notifier.problem('Deduction rejected by Spoolman', `${what} was rejected: ${e.message}. Re-queue it to another spool or skip it in the bridge.`, {
        path: `/usage/${row.id}`,
      });
      return;
    }
    store.setUsageState(row.id, retryState, { error: e.message });
    log.warn(`deduction ${row.id} not confirmed (attempt ${attempts}): ${what}: ${e.message}`);
    if (attempts === ATTEMPTS_BEFORE_NOTICE) {
      await notifier.problem(
        'Spoolman unreachable',
        `${what} is still not written after ${attempts} attempts (${e.message}). The bridge keeps retrying.`,
        { path: `/usage/${row.id}` },
      );
    }
  }

  async function recover(row) {
    let current;
    try {
      current = await spoolman.getSpool(row.spool_id);
    } catch (e) {
      // Still unknown whether the use call landed: stay 'planned' unless the spool is gone (4xx).
      await failed(row, e, 'planned');
      return;
    }
    const outcome = classifyRecovery({ remainingBefore: row.remaining_before, grams: row.grams, currentRemaining: current.remaining_weight });
    log.info(`recovery of deduction ${row.id}: before ${row.remaining_before} g, now ${current.remaining_weight} g, ${row.grams} g -> ${outcome}`);
    if (outcome === 'applied') {
      store.setUsageState(row.id, 'applied');
    } else if (outcome === 'reapply') {
      await send(row);
    } else {
      store.setUsageState(row.id, 'uncertain', { error: `remaining was ${row.remaining_before} g, now ${current.remaining_weight} g` });
      await notifier.problem(
        'Deduction needs a check',
        `Could not tell whether ${row.grams} g was deducted from spool #${row.spool_id} (job ${row.job_id}, ${row.source_key}). ` +
          `Remaining was ${row.remaining_before} g before, now ${current.remaining_weight} g.`,
      );
    }
  }

  // Single-flight: concurrent callers share one run; a call during a run triggers one more pass.
  let running = null;
  let again = false;
  async function processQueue() {
    if (dryRun) return;
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        for (const row of store.usageByState('planned')) await recover(row);
        for (const row of [...store.usageByState('queued'), ...store.usageByState('failed')]) await send(row);
      } while (again);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  /**
   * A person's answer for a needs_attention row: re-queue it (same or another spool) or skip it.
   * @param {number|null} spoolId  null = skip, nothing is deducted
   * @returns {Promise<{ ok: boolean, message: string }>}
   */
  async function requeue(usageId, spoolId) {
    const row = store.getUsage(usageId);
    if (!row) return { ok: false, message: `deduction ${usageId} not found` };
    if (row.write_state !== 'needs_attention') return { ok: false, message: `deduction ${usageId} is ${row.write_state}, not needs_attention` };
    if (spoolId == null) {
      store.setUsageState(usageId, 'skipped');
      log.info(`deduction ${usageId} skipped by user`);
      return { ok: true, message: 'Skipped: nothing deducted.' };
    }
    try {
      await spoolman.getSpool(spoolId);
    } catch (e) {
      return { ok: false, message: `spool #${spoolId} not usable: ${e.message}` };
    }
    store.requeueUsage(usageId, spoolId);
    store.setSourceResolution(row.job_id, row.source_key, { spoolId, resolution: 'chosen' });
    log.info(`deduction ${usageId} re-queued to spool #${spoolId}`);
    await processQueue();
    const state = store.getUsage(usageId).write_state;
    return { ok: true, message: state === 'applied' ? `${row.grams} g deducted from spool #${spoolId}.` : `Re-queued to spool #${spoolId} (${state}).` };
  }

  return { loadInventory, runWrites, applyDecision, recordDeduction, processQueue, requeue };
}
