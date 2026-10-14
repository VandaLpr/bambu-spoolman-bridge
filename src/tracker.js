// Per-printer job tracker. Watches the printer's entities, runs the lifecycle rules,
// snapshots and resolves sources at print start and records deductions at print end.
// All work for one printer runs through a serial queue, so handlers never interleave.
//
// Stale values at print start (seen in HA history): when "prepare" arrives, print_progress
// can still hold the previous print's 100 and print_weight the previous print's grams.
// Both printers update print_weight only with "running". Therefore:
//   - a fresh job ignores the current progress; only progress changes after the start count
//   - the snapshot waits for a print_weight updated after the job's "prepare" (jobs.started_at,
//     persisted so a restart in between waits too; fallback: the current value after weightWaitMs)
//   - a print cancelled before any progress gets no snapshot at all
//   - at bridge startup, progress counts only if HA changed it after the print's start_time
//
// Pair on insert: an RFID spool put into an AMS slot outside a print (or into a slot the
// running print doesn't use) is paired right away, the same way as at print start, and gets
// its location. No deduction.
//
// Failed prints: print_progress includes the start gcode (heating, leveling, calibration,
// purge). With current_stage, the progress at the first "printing" stage is persisted as the
// job's baseline and only progress beyond it is deducted; never printing means 0 g.

import { computeDeductions, round2 } from './deduction.js';
import { baselineFromHistory, decide, isSignificant, startTimeDiffers, TERMINAL } from './lifecycle.js';
import { choiceDecision, resolveSource } from './resolver.js';
import { activeTrayKey, formatLocation, identityFromTray, parsePrintWeight } from './sources.js';

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STALE_WINDOW_MS = 10 * 60 * 1000;
const known = (v) => v !== undefined && v !== null && v !== '' && v !== 'unknown' && v !== 'unavailable';

export class PrinterTracker {
  /**
   * @param {object} deps
   * @param {object} deps.printer   printer config
   * @param {object} deps.ids       from resolveEntities()
   * @param {Function} deps.loadedTrayUuids  () => tray_uuids loaded in any AMS of any printer
   */
  constructor({
    printer,
    ids,
    store,
    executor,
    notifier,
    ha,
    config,
    log,
    loadedTrayUuids = () => [],
    sleep = realSleep,
    debounceMs = 2000,
    weightWaitMs = 60_000,
    colorTable = () => null,
    insertSettleMs = 5000,
    insertMaxWaitMs = 60_000,
  }) {
    Object.assign(this, { printer, ids, store, executor, notifier, ha, config, log, loadedTrayUuids, sleep, debounceMs, weightWaitMs });
    Object.assign(this, { colorTable, insertSettleMs, insertMaxWaitMs });
    this.inserts = new Map(); // print_weight key -> { uuid, since, timer } while a new tray settles
    this.prefix = printer.prefix;
    this.entities = {};
    this.lastSignificant = null;
    this.started = false;
    this.queue = Promise.resolve();
    this.weightTimer = null;
    this.waitTimer = null; // fallback snapshot while waiting for this print's print_weight
    this.notified = new Map(); // pending id -> candidate signature already sent
  }

  // --- entity access ---------------------------------------------------------------

  state(key) {
    const id = this.ids[key];
    return id ? this.entities[id]?.state : undefined;
  }

  attrs(key) {
    const id = this.ids[key];
    return (id && this.entities[id]?.attributes) || {};
  }

  value(key) {
    const s = this.state(key);
    return known(s) ? s : null;
  }

  entity(key) {
    const id = this.ids[key];
    return id ? this.entities[id] : undefined;
  }

  progress() {
    const n = Number(this.state('progress'));
    return Number.isFinite(n) ? n : 0;
  }

  // Bridge startup only: the current progress, if it belongs to the running print, i.e.
  // HA changed it at or after the print's start_time. Otherwise 0.
  trustedStartupProgress() {
    if (this.state('status') !== 'running') return 0;
    const start = Date.parse(this.value('startTime'));
    const changed = Date.parse(this.entity('progress')?.last_changed);
    if (Number.isNaN(start) || Number.isNaN(changed)) return 0;
    return changed >= start ? this.progress() : 0;
  }

  // print_weight was updated at or after `since` (HA time). Without timestamps it can't be
  // judged and counts as fresh.
  weightIsFresh(since) {
    const pw = this.entity('printWeight');
    const updated = Date.parse(pw?.last_updated ?? pw?.last_changed);
    const start = Date.parse(since);
    if (Number.isNaN(updated) || Number.isNaN(start)) return true;
    return updated >= start;
  }

  trayAttributes() {
    return [...this.ids.trays.values()].map((id) => this.entities[id]?.attributes || {});
  }

  // --- event intake ----------------------------------------------------------------

  enqueue(label, fn) {
    this.queue = this.queue.then(fn).catch((e) => this.log.error(`${label} failed`, e));
    return this.queue;
  }

  /** Resolves once everything queued (including a pending debounce) has run. */
  async idle() {
    for (;;) {
      while (this.weightTimer || this.insertWaiting()) await new Promise((r) => setTimeout(r, 5));
      const q = this.queue;
      await q;
      if (q === this.queue && !this.weightTimer && !this.insertWaiting()) return;
    }
  }

  startup(entities) {
    this.entities = entities;
    this.started = true;
    const status = this.state('status');
    this.log.info(`startup: status ${status}, progress ${this.progress()}`);
    return this.enqueue('startup', () => this.handleStatus(status, { startup: true }));
  }

  /** Called with the full entity map on every Home Assistant update. */
  onEntities(entities) {
    const prev = this.entities;
    this.entities = entities;
    if (!this.started) return;
    this.watchTrays(prev, entities);
    const changed = (key) => {
      const id = this.ids[key];
      return id && prev[id] !== entities[id];
    };
    const stateChanged = (key) => changed(key) && prev[this.ids[key]]?.state !== entities[this.ids[key]]?.state;

    // Progress first: on finish both change in the same update.
    if (stateChanged('progress')) this.enqueue('progress', () => this.handleProgress());
    if (stateChanged('stage')) {
      const stage = this.state('stage');
      const progress = this.progress(); // the jump to the baseline comes in this same update
      this.enqueue('stage', () => this.handleStage(stage, progress));
    }
    if (stateChanged('status')) {
      const status = this.state('status');
      this.enqueue('status', () => this.handleStatus(status));
    }
    if (stateChanged('startTime') || stateChanged('taskName')) this.enqueue('meta', () => this.handleMeta());
    if (changed('printWeight')) this.scheduleWeightCheck();
    if (changed('activeTray')) this.enqueue('active tray', () => this.checkActiveTray());
  }

  scheduleWeightCheck() {
    clearTimeout(this.weightTimer);
    this.weightTimer = setTimeout(() => {
      this.weightTimer = null;
      this.enqueue('print_weight', () => this.handlePrintWeight());
    }, this.debounceMs);
  }

  stop() {
    clearTimeout(this.weightTimer);
    this.weightTimer = null;
    this.clearWait();
    for (const key of [...this.inserts.keys()]) this.cancelInsert(key);
  }

  clearWait() {
    clearTimeout(this.waitTimer);
    this.waitTimer = null;
  }

  // --- handlers --------------------------------------------------------------------

  activeJob() {
    return this.store.getActiveJob(this.prefix);
  }

  async handleStatus(status, { startup = false } = {}) {
    const job = this.activeJob();
    const startTime = this.value('startTime');
    const previous = this.lastSignificant;
    const action = decide({
      status,
      lastSignificant: previous,
      hasActiveJob: Boolean(job),
      startTimeChanged: job ? startTimeDiffers(job.start_time, startTime, this.config.jobStartToleranceSec) : false,
    });
    if (isSignificant(status)) this.lastSignificant = status;
    if (action !== 'none') this.log.info(`status ${status} -> ${action}${job ? ` (job ${job.id})` : ''}`);

    if (action === 'start') return this.startJob({ status, startup, previous });
    if (action === 'restart') {
      await this.missJob(job);
      return this.startJob({ status, startup, previous });
    }
    if (action === 'continue') {
      // At runtime, progress arrives through handleProgress(); the current value may be stale.
      if (startup) this.store.raiseMaxProgress(job.id, this.trustedStartupProgress());
      if (startup && job.stage_tracked && job.print_baseline === null) await this.restoreBaseline(job);
      if (this.store.getJobSources(job.id).length) return;
      // Jobs from before started_at was stored (null) count as fresh.
      if (this.weightIsFresh(job.started_at)) await this.snapshot(job.id);
      else if (startup) this.waitForWeight(job.id); // restarted between prepare and running
      return;
    }
    if (action === 'end') return this.endJob(job, status);
  }

  async handleProgress() {
    const job = this.activeJob();
    if (job) this.store.raiseMaxProgress(job.id, this.progress());
  }

  async handleStage(stage, progress) {
    if (stage !== 'printing') return;
    const job = this.activeJob();
    if (!job?.stage_tracked) return;
    if (this.store.setPrintBaseline(job.id, progress)) this.log.info(`job ${job.id}: printing started at ${progress}% (failed-print baseline)`);
  }

  // After a bridge restart the first "printing" may have happened while it was down. Rebuild
  // the baseline from HA's recorder; if that isn't possible, fall back to plain progress.
  async restoreBaseline(job) {
    const times = [job.start_time, job.started_at, job.created_at].map((t) => Date.parse(t)).filter(Number.isFinite);
    const since = Math.min(...times) - this.config.jobStartToleranceSec * 1000;
    try {
      const history = await this.ha.history([this.ids.stage, this.ids.progress], since);
      const { printing, baseline } = baselineFromHistory(history[this.ids.stage], history[this.ids.progress]);
      if (printing && baseline !== null) {
        this.store.setStageTracking(job.id, true, baseline);
        this.log.info(`job ${job.id}: baseline ${baseline}% restored from HA history`);
      } else if (!printing && this.state('stage') !== 'printing') {
        this.store.setStageTracking(job.id, true, null);
        this.log.info(`job ${job.id}: not printing yet according to HA history`);
      } else {
        this.store.setStageTracking(job.id, false);
        this.log.warn(`job ${job.id}: printing baseline not in HA history; a failure is deducted by plain progress`);
      }
    } catch (e) {
      this.store.setStageTracking(job.id, false);
      this.log.warn(`job ${job.id}: HA history unavailable (${e.message ?? e}); a failure is deducted by plain progress`);
    }
  }

  async handleMeta() {
    const job = this.activeJob();
    if (job) {
      this.store.updateJobMeta(job.id, { startTime: this.value('startTime'), taskName: this.value('taskName') });
      return;
    }
    // A start skipped as a duplicate is re-checked once start_time moves on.
    const status = this.state('status');
    if (status === 'running' || status === 'prepare') await this.handleStatus(status);
  }

  async handlePrintWeight() {
    const job = this.activeJob();
    if (!job) return;
    // print_weight is final once the print is under way; later changes belong to the next print.
    // max_progress only holds progress reported after the job started (or trusted at startup),
    // so a stale 100 from the previous print can't block this.
    if (this.store.getJob(job.id).max_progress > 0) return;
    const current = parsePrintWeight(this.attrs('printWeight')).sources.map((s) => `${s.sourceKey}=${s.grams}`).join(',');
    const stored = this.store.getJobSources(job.id).map((s) => `${s.source_key}=${s.grams}`).join(',');
    if (current === stored) return;
    this.log.info(`print_weight for job ${job.id}: ${stored || 'none yet'} -> ${current}; snapshot`);
    await this.snapshot(job.id);
  }

  async checkActiveTray() {
    const job = this.activeJob();
    const key = activeTrayKey(this.attrs('activeTray'));
    if (!job || !key || this.state('status') !== 'running') return;
    const keys = this.store.getJobSources(job.id).map((s) => s.source_key);
    if (keys.length && !keys.includes(key)) {
      this.log.warn(`active tray ${key} is not in this print's print_weight (${keys.join(', ')}); usage stays with the start snapshot`);
    }
  }

  // --- pair on insert --------------------------------------------------------------
  // The AMS reports tray_uuid first with remain = -1 and the remaining estimate about 10 s
  // later (seen in HA history), so pairing waits until the tray has been quiet for
  // insertSettleMs and remain is known, or insertMaxWaitMs has passed.

  watchTrays(prev, entities) {
    for (const [key, id] of this.ids.trays) {
      if (prev[id] === entities[id]) continue;
      const before = identityFromTray(prev[id]?.attributes).trayUuid;
      const after = identityFromTray(entities[id]?.attributes).trayUuid;
      if (after !== before) {
        this.cancelInsert(key);
        if (after) this.inserts.set(key, { uuid: after, since: Date.now(), timer: null });
      }
      if (this.inserts.has(key)) this.armInsert(key); // any change restarts the quiet period
    }
  }

  insertWaiting() {
    for (const p of this.inserts.values()) if (p.timer) return true;
    return false;
  }

  armInsert(key) {
    const p = this.inserts.get(key);
    clearTimeout(p.timer);
    p.timer = setTimeout(() => this.insertDue(key), this.insertSettleMs);
  }

  cancelInsert(key) {
    clearTimeout(this.inserts.get(key)?.timer);
    this.inserts.delete(key);
  }

  insertDue(key) {
    const p = this.inserts.get(key);
    if (!p) return;
    p.timer = null;
    const attrs = this.entities[this.ids.trays.get(key)]?.attributes || {};
    const remainUnknown = attrs.remain_enabled && !(Number(attrs.remain) >= 0);
    if (remainUnknown && Date.now() - p.since < this.insertMaxWaitMs) {
      this.armInsert(key);
      return;
    }
    this.inserts.delete(key);
    this.enqueue('insert', () => this.handleInsert(key, p.uuid));
  }

  async handleInsert(key, uuid) {
    const identity = identityFromTray(this.entities[this.ids.trays.get(key)]?.attributes);
    if (identity.trayUuid !== uuid) return; // changed again: that change has its own timer
    const job = this.activeJob();
    if (job && this.store.getJobSources(job.id).some((s) => s.source_key === key)) {
      this.log.info(`insert ${key}: tray_uuid ${uuid} is part of job ${job.id}; the print's own pairing applies`);
      return;
    }
    const [, unit, slot] = /^AMS (\d+) Tray (\d+)$/.exec(key).map(Number);
    const location = formatLocation(this.printer, { kind: 'ams', unit, slot });
    const inventory = await this.executor.loadInventory();
    const decision = resolveSource({
      identity,
      location,
      inventory,
      nearestMaxDeltaE: this.config.nearestColorMaxDeltaE,
      colorTable: this.colorTable(),
      estimatedSpoolIds: this.store.estimatedSpoolIds(),
    });
    const { spoolId } = await this.executor.applyDecision(decision);
    let asked = null;
    if (decision.status === 'pending') {
      // Ask now: whoever inserts the spool is standing at the printer. Once per tray_uuid.
      const { pending, created } = this.store.addInsertPending({
        printer: this.prefix,
        sourceKey: key,
        trayUuid: uuid,
        reason: decision.reason,
        candidates: decision.candidates,
        context: { identity, location },
      });
      asked = { id: pending.id, created };
      if (created) {
        const source = { material: identity.material, name: identity.name, color_hex: identity.colorHex };
        await this.notifier.pending({ pending, printerName: this.printer.name, taskName: null, source, inserted: true });
      }
    }
    this.log.info(this.describeInsert(key, identity, decision, spoolId, location, asked));
  }

  // One line per insert: tray, tray_uuid, remain%, the spool and why, and any weight correction.
  describeInsert(key, identity, decision, spoolId, location, asked = null) {
    const head = `${this.config.dryRun ? '[DRY RUN] ' : ''}insert ${key}: tray_uuid ${identity.trayUuid}, remain ${identity.remainPct ?? '?'}%`;
    if (decision.status === 'pending') {
      const ids = decision.candidates.map((c) => `#${c.spoolId}`).join(', ');
      const question = asked?.created ? `asked (pending ${asked.id})` : `already asked about this tray_uuid (pending ${asked?.id})`;
      return `${head} -> not paired: ${decision.reason}${ids ? ` (candidates ${ids})` : ''}; ${question}`;
    }
    if (decision.status === 'create') {
      return `${head} -> ${spoolId ? `new spool #${spoolId}` : 'new spool'} auto-created from RFID${decision.filamentId ? ` (filament #${decision.filamentId})` : ''}, location ${location}`;
    }
    const why = { tag: 'already tagged', rfid_uuid: 'rfid_uuid', paired: 'same filament and colour', paired_code: 'same colour code', paired_nearest: 'nearest colour, filament colour corrected' }[decision.via] ?? decision.via;
    const c = decision.correction;
    const correction = c ? `, remaining ${c.from} -> ${c.to} g (AMS ${c.remainPct}%)` : '';
    const moved = decision.writes.some((w) => w.op === 'patchSpool' && w.patch.location) ? `, location ${location}` : '';
    return `${head} -> spool #${decision.spoolId} (${why})${correction}${moved}`;
  }

  // --- job steps -------------------------------------------------------------------

  // A stale "running" right after a finish (seen on printer reconnects) must not become a
  // second job and a second deduction. A real new print passes through "prepare".
  isStaleRunning({ status, startup, previous }) {
    if (status !== 'running') return false;
    const startTime = this.value('startTime');
    if (startTime) {
      const seen = this.store.findJobByStart(this.prefix, startTime, this.config.jobStartToleranceSec);
      if (seen && seen.state !== 'active') return `start_time ${startTime} belongs to job ${seen.id}`;
    }
    if (startup || !TERMINAL.has(previous)) return false;
    const last = this.store.lastEndedJob(this.prefix);
    const recent = last?.ended_at && Date.now() - Date.parse(last.ended_at) < STALE_WINDOW_MS;
    if (recent && last.task_name === this.value('taskName')) return `job ${last.id} "${last.task_name}" just ended`;
    return false;
  }

  async startJob({ status, startup, previous = null }) {
    const stale = this.isStaleRunning({ status, startup, previous });
    if (stale) {
      this.log.info(`running without prepare ignored: ${stale}`);
      return;
    }
    // Only a print already running when the bridge starts is adopted. started_at is HA's
    // time of the status that started the job; print_weight must be newer to be this print's.
    const startedAt = this.entity('status')?.last_changed ?? null;
    // A fresh job starts before printing; if the stage already says "printing" the start was
    // missed and the baseline is unknown. An adopted job gets its tracking from history.
    const stageTracked = !startup && Boolean(this.ids.stage) && this.state('stage') !== 'printing';
    const jobId = this.store.createJob({
      printer: this.prefix,
      taskName: this.value('taskName'),
      startTime: this.value('startTime'),
      startedAt,
      adopted: startup,
      stageTracked,
      dryRun: this.config.dryRun,
    });
    if (startup) this.store.raiseMaxProgress(jobId, this.trustedStartupProgress());
    if (startup && this.ids.stage) await this.restoreBaseline(this.store.getJob(jobId));
    this.log.info(`job ${jobId} ${startup ? 'adopted' : 'started'}: "${this.value('taskName') ?? '?'}"`);

    if (this.ids.refreshButton) {
      try {
        await this.ha.pressButton(this.ids.refreshButton);
      } catch (e) {
        this.log.warn(`force refresh failed: ${e.message ?? e}`);
      }
    }
    // A print found running at startup already has its print_weight (set with "running").
    if ((startup && status === 'running') || this.weightIsFresh(startedAt)) {
      await this.sleep(this.printer.refreshDelayMs);
      await this.snapshot(jobId);
      return;
    }
    this.waitForWeight(jobId);
  }

  // print_weight still holds the previous print's values: handlePrintWeight() snapshots when
  // this print's arrive; the fallback covers a reprint whose values are identical.
  waitForWeight(jobId) {
    this.clearWait();
    this.log.info(`job ${jobId}: waiting for this print's print_weight`);
    this.waitTimer = setTimeout(() => {
      this.waitTimer = null;
      this.enqueue('print_weight fallback', async () => {
        const job = this.activeJob();
        if (job?.id !== jobId || this.store.getJobSources(jobId).length) return;
        this.log.info(`job ${jobId}: print_weight unchanged after ${this.weightWaitMs / 1000} s; using the current value`);
        await this.snapshot(jobId);
      });
    }, this.weightWaitMs);
    this.waitTimer.unref?.();
  }

  async missJob(job) {
    this.clearWait();
    this.store.endJob(job.id, 'missed_end');
    this.log.warn(`job ${job.id} closed as missed_end: a new print started before its end was seen`);
    await this.notifier.problem(
      `${this.printer.name}: print end missed`,
      `The end of "${job.task_name ?? 'unknown print'}" (job ${job.id}) was never seen, so nothing was deducted. Check those spools in Spoolman.`,
    );
  }

  async snapshot(jobId) {
    this.clearWait();
    const job = this.store.getJob(jobId);
    if (!job || job.state !== 'active') return;

    const { sources, unknown } = parsePrintWeight(this.attrs('printWeight'));
    if (unknown.length) this.log.warn(`unrecognised print_weight keys ignored: ${unknown.join(', ')}`);
    if (!sources.length) {
      this.log.warn(`job ${jobId}: print_weight has no sources yet`);
      this.store.replaceJobSources(jobId, []);
      return;
    }

    const inventory = await this.executor.loadInventory();
    const now = new Date().toISOString();
    const rows = [];
    const pendingRows = [];
    for (const source of sources) {
      const entityId = source.kind === 'external' ? this.ids.externalSpool : this.ids.trays.get(source.sourceKey);
      const identity = identityFromTray((entityId && this.entities[entityId]?.attributes) || {});
      const location = formatLocation(this.printer, source);
      const decision = resolveSource({
        identity,
        location,
        inventory,
        loadedTrayUuids: source.kind === 'external' ? this.loadedTrayUuids() : [],
        nearestMaxDeltaE: this.config.nearestColorMaxDeltaE,
        now,
        colorTable: this.colorTable(),
        estimatedSpoolIds: this.store.estimatedSpoolIds(),
      });
      let { spoolId, resolution } = await this.executor.applyDecision(decision);
      // An answer given before a re-snapshot stays in force.
      const answered = decision.status === 'pending' ? this.store.getPendingFor(jobId, source.sourceKey) : null;
      if (answered?.state === 'resolved') ({ spoolId, resolution } = { spoolId: answered.chosen_spool_id, resolution: 'chosen' });
      if (answered?.state === 'skipped') resolution = 'skipped';
      this.log.info(`job ${jobId} ${source.sourceKey} (${source.grams} g) -> ${spoolId ? `spool #${spoolId}` : resolution} [${decision.via ?? decision.reason}]`);
      this.logRemainGap(identity, inventory.spools.find((s) => s.id === spoolId));
      rows.push({ ...source, location, ...identity, spoolId, resolution, decision });
      if (decision.status === 'pending') pendingRows.push({ source, decision, trayUuid: identity.trayUuid });
    }
    this.store.replaceJobSources(jobId, rows);

    for (const { source, decision, trayUuid } of pendingRows) {
      const pending = this.store.upsertPending({
        jobId,
        sourceKey: source.sourceKey,
        reason: decision.reason,
        candidates: decision.candidates,
        printer: this.prefix,
        trayUuid,
      });
      const signature = `${pending.reason}:${pending.candidates.map((c) => c.spoolId).join(',')}`;
      if (pending.state !== 'open' || this.notified.get(pending.id) === signature) continue;
      // Same spool already asked about at insert and not answered yet: that answer covers this too.
      const inserted = trayUuid ? this.store.getInsertPending(trayUuid) : null;
      if (inserted?.state === 'open') {
        this.notified.set(pending.id, signature);
        this.log.info(`job ${jobId} ${source.sourceKey}: already asked when the spool was inserted (pending ${inserted.id}); not asking again`);
        continue;
      }
      this.notified.set(pending.id, signature);
      const sourceRow = this.store.getJobSources(jobId).find((s) => s.source_key === source.sourceKey);
      await this.notifier.pending({ pending, printerName: this.printer.name, taskName: job.task_name, source: sourceRow });
    }
  }

  logRemainGap(identity, spool) {
    if (!spool || identity.remainPct == null || !identity.trayWeight || spool.remaining_weight == null) return;
    const ams = Math.round((identity.trayWeight * identity.remainPct) / 100);
    this.log.debug(`spool #${spool.id}: AMS reports ~${ams} g (${identity.remainPct}%), Spoolman ${Math.round(spool.remaining_weight)} g`);
  }

  async endJob(job, status) {
    if (!TERMINAL.has(status)) return;
    this.clearWait();
    if (!this.store.getJobSources(job.id).length) {
      // Failed before printing anything (no progress, or the stage never reached "printing"):
      // print_weight may still be the previous print's and nothing was used, so no snapshot,
      // no resolution (no Spoolman writes), no usage rows.
      const before = this.store.getJob(job.id);
      const neverPrinted = !(before.max_progress > 0) || (before.stage_tracked && before.print_baseline === null);
      if (status === 'failed' && neverPrinted) {
        this.store.endJob(job.id, 'failed', 0);
        this.log.info(`job ${job.id} failed before printing anything: nothing to deduct`);
        return;
      }
      // finish, or failed after progress: "running" happened, so print_weight is this print's.
      await this.snapshot(job.id);
    }
    const fresh = this.store.getJob(job.id);
    const sources = this.store.getJobSources(job.id);
    const deductions = computeDeductions(
      sources.map((s) => ({ sourceKey: s.source_key, grams: s.grams })),
      status,
      fresh.max_progress,
      { tracked: Boolean(fresh.stage_tracked), baseline: fresh.print_baseline },
    );
    const bySource = new Map(sources.map((s) => [s.source_key, s]));
    // Rows first, then end the job: a crash in between is repaired by the next startup.
    for (const d of deductions) {
      const source = bySource.get(d.sourceKey);
      this.executor.recordDeduction({
        job: fresh,
        sourceKey: d.sourceKey,
        spoolId: source.spool_id,
        grams: d.grams,
        status,
        skipped: source.resolution === 'skipped',
      });
    }
    const total = round2(deductions.reduce((t, d) => t + d.grams, 0));
    this.store.endJob(job.id, status, total);
    const base = fresh.stage_tracked ? `, printing from ${fresh.print_baseline ?? 'never'}%` : '';
    this.log.info(`job ${job.id} ${status} at ${fresh.max_progress}%${base}: ${total} g over ${deductions.length} source(s)`);
    if (!sources.length) {
      await this.notifier.problem(
        `${this.printer.name}: nothing to deduct`,
        `"${fresh.task_name ?? 'unknown print'}" ended (${status}) but no print_weight sources were captured. Check Spoolman manually.`,
      );
    }
    await this.executor.processQueue();
  }
}

// Rebuilds the resolver identity from a stored job_sources row.
export function identityFromSourceRow(row) {
  return {
    trayUuid: row.tray_uuid,
    filamentId: row.filament_id,
    colorHex: row.color_hex,
    material: row.material,
    name: row.name,
  };
}

/**
 * Applies the user's answer to a pending source (notification button or bridge page).
 * spoolId null = skip: nothing is deducted for this source.
 * @returns {{ ok: boolean, message: string }}
 */
export async function resolvePending({ store, spoolman, executor, log, pendingId, spoolId }) {
  const pending = store.getPending(pendingId);
  if (!pending) return { ok: false, message: `pending ${pendingId} not found` };
  if (pending.state !== 'open') return { ok: false, message: `pending ${pendingId} is already ${pending.state}` };
  if (pending.kind === 'insert') return resolveInsertPending({ store, spoolman, executor, log, pending, spoolId });
  const usage = store.getUsageFor(pending.job_id, pending.source_key);

  if (spoolId == null) {
    store.closePending(pendingId, 'skipped');
    if (usage?.write_state === 'parked') store.setUsageState(usage.id, 'skipped');
    log.info(`pending ${pendingId} skipped`);
    return { ok: true, message: 'Skipped: nothing deducted for this source.' };
  }

  const source = store.getJobSources(pending.job_id).find((s) => s.source_key === pending.source_key);
  if (!source) return { ok: false, message: `source ${pending.source_key} of job ${pending.job_id} not found` };
  let spool;
  try {
    spool = await spoolman.getSpool(spoolId);
  } catch (e) {
    return { ok: false, message: `spool #${spoolId} not found in Spoolman (${e.message})` };
  }
  await executor.applyDecision(choiceDecision({ spool, identity: identityFromSourceRow(source), location: source.location }));
  store.setSourceResolution(pending.job_id, pending.source_key, { spoolId, resolution: 'chosen' });
  store.closePending(pendingId, 'resolved', spoolId);
  // The same spool may also have been asked about when it was inserted: that's answered now.
  const inserted = source.tray_uuid ? store.getInsertPending(source.tray_uuid) : null;
  if (inserted?.state === 'open') store.closePending(inserted.id, 'resolved', spoolId);
  if (usage?.write_state === 'parked') {
    store.setUsageState(usage.id, 'queued', { spoolId });
    await executor.processQueue();
  }
  log.info(`pending ${pendingId} resolved: ${pending.source_key} of job ${pending.job_id} -> spool #${spoolId}`);
  return { ok: true, message: usage ? `Spool #${spoolId} chosen; ${usage.grams} g deducted.` : `Spool #${spoolId} chosen; it will be deducted when the print ends.` };
}

// Answer to "which spool did you just insert?": pair the tray with it (no deduction), then
// answer any open print question about the same spool the same way.
async function resolveInsertPending({ store, spoolman, executor, log, pending, spoolId }) {
  if (spoolId == null) {
    store.closePending(pending.id, 'skipped');
    log.info(`pending ${pending.id} (insert ${pending.source_key}) skipped`);
    return { ok: true, message: 'Skipped: the spool stays unpaired.' };
  }
  let spool;
  try {
    spool = await spoolman.getSpool(spoolId);
  } catch (e) {
    return { ok: false, message: `spool #${spoolId} not found in Spoolman (${e.message})` };
  }
  const { identity, location } = pending.context;
  const decision = choiceDecision({ spool, identity, location, estimatedSpoolIds: store.estimatedSpoolIds() });
  await executor.applyDecision(decision);
  store.closePending(pending.id, 'resolved', spoolId);
  const c = decision.correction;
  log.info(`pending ${pending.id} resolved: ${pending.source_key} (tray_uuid ${pending.tray_uuid}) paired with spool #${spoolId}${c ? `, remaining ${c.from} -> ${c.to} g` : ''}`);
  for (const p of store.openPrintPendingsFor(pending.tray_uuid)) {
    await resolvePending({ store, spoolman, executor, log, pendingId: p.id, spoolId });
  }
  return { ok: true, message: `Spool #${spoolId} paired with ${pending.source_key}${c ? `; remaining set to ${c.to} g from the AMS estimate` : ''}.` };
}
