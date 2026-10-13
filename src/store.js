// SQLite persistence. usage_log is the consumption history (Spoolman keeps none) and,
// through UNIQUE(job_id, source_key), the guarantee that a source is deducted at most once.
//
// usage_log.write_state:
//   parked    job ended but the source has no spool yet (pending answer)
//   queued    ready to send; nothing sent to Spoolman yet
//   failed    an attempt failed before anything was sent; retried like queued
//   planned   remaining_before persisted, use call issued; may or may not have landed
//   applied   Spoolman accepted the deduction
//   skipped   the user chose not to deduct this source
//   dry_run   DRY_RUN was on; logged only, never replayed
//   uncertain a planned row whose spool weight didn't tell whether the write landed;
//             needs a manual check
//   needs_attention  Spoolman rejected the call (HTTP 4xx, e.g. spool deleted); not retried
//             until a person re-queues it to a spool or skips it
//
// attempts counts failed tries (failed, ambiguous planned, rejected); reset on re-queue.
//
// remaining_before is the spool's remaining_weight read just before the Spoolman call,
// so a planned row found after a restart can be classified (see recovery.js).

import Database from 'better-sqlite3';

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE jobs (
  id           INTEGER PRIMARY KEY,
  printer      TEXT NOT NULL,
  task_name    TEXT,
  start_time   TEXT,
  state        TEXT NOT NULL CHECK (state IN ('active', 'finish', 'failed', 'missed_end')),
  max_progress REAL NOT NULL DEFAULT 0,
  total_grams  REAL,
  adopted      INTEGER NOT NULL DEFAULT 0,
  dry_run      INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  ended_at     TEXT
);
CREATE INDEX jobs_printer_state ON jobs (printer, state);

CREATE TABLE job_sources (
  job_id      INTEGER NOT NULL REFERENCES jobs (id),
  source_key  TEXT NOT NULL,
  grams       REAL NOT NULL,
  kind        TEXT NOT NULL,
  unit        INTEGER,
  slot        INTEGER,
  location    TEXT,
  tray_uuid   TEXT,
  filament_id TEXT,
  color_hex   TEXT,
  material    TEXT,
  name        TEXT,
  spool_id    INTEGER,
  resolution  TEXT,
  decision    TEXT,
  PRIMARY KEY (job_id, source_key)
);

CREATE TABLE usage_log (
  id           INTEGER PRIMARY KEY,
  job_id       INTEGER NOT NULL REFERENCES jobs (id),
  printer      TEXT NOT NULL,
  task_name    TEXT,
  source_key   TEXT NOT NULL,
  spool_id     INTEGER,
  grams        REAL NOT NULL,
  status       TEXT NOT NULL,
  max_progress REAL,
  remaining_before REAL,
  dry_run      INTEGER NOT NULL,
  write_state  TEXT NOT NULL,
  error        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (job_id, source_key)
);

CREATE TABLE pending (
  id              INTEGER PRIMARY KEY,
  job_id          INTEGER NOT NULL REFERENCES jobs (id),
  source_key      TEXT NOT NULL,
  reason          TEXT NOT NULL,
  candidates      TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved', 'skipped')),
  chosen_spool_id INTEGER,
  created_at      TEXT NOT NULL,
  resolved_at     TEXT,
  UNIQUE (job_id, source_key)
);
`;

const now = () => new Date().toISOString();
const bool = (v) => (v ? 1 : 0);

export function openStore(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const stmt = (sql) => db.prepare(sql);
  const parsePending = (row) => row && { ...row, candidates: JSON.parse(row.candidates) };

  const q = {
    insertJob: stmt(`INSERT INTO jobs (printer, task_name, start_time, state, adopted, dry_run, created_at)
                     VALUES (@printer, @taskName, @startTime, 'active', @adopted, @dryRun, @createdAt)`),
    activeJob: stmt(`SELECT * FROM jobs WHERE printer = ? AND state = 'active' ORDER BY id DESC LIMIT 1`),
    activeJobs: stmt(`SELECT * FROM jobs WHERE state = 'active' ORDER BY id`),
    job: stmt(`SELECT * FROM jobs WHERE id = ?`),
    jobMeta: stmt(`UPDATE jobs SET task_name = COALESCE(@taskName, task_name), start_time = COALESCE(@startTime, start_time)
                   WHERE id = @id`),
    raiseProgress: stmt(`UPDATE jobs SET max_progress = @progress WHERE id = @id AND max_progress < @progress`),
    endJob: stmt(`UPDATE jobs SET state = @state, total_grams = @totalGrams, ended_at = @endedAt
                  WHERE id = @id AND state = 'active'`),
    listJobs: stmt(`SELECT * FROM jobs ORDER BY id DESC LIMIT ?`),
    lastEndedJob: stmt(`SELECT * FROM jobs WHERE printer = ? AND state != 'active' ORDER BY id DESC LIMIT 1`),
    jobByStart: stmt(`SELECT * FROM jobs WHERE printer = @printer AND start_time IS NOT NULL
                      AND abs(julianday(start_time) - julianday(@startTime)) * 86400 <= @tolerance
                      ORDER BY id DESC LIMIT 1`),

    deleteSources: stmt(`DELETE FROM job_sources WHERE job_id = ?`),
    insertSource: stmt(`INSERT INTO job_sources
      (job_id, source_key, grams, kind, unit, slot, location, tray_uuid, filament_id, color_hex, material, name, spool_id, resolution, decision)
      VALUES (@jobId, @sourceKey, @grams, @kind, @unit, @slot, @location, @trayUuid, @filamentId, @colorHex, @material, @name,
              @spoolId, @resolution, @decision)`),
    sources: stmt(`SELECT * FROM job_sources WHERE job_id = ? ORDER BY source_key`),
    setSource: stmt(`UPDATE job_sources SET spool_id = @spoolId, resolution = @resolution, decision = COALESCE(@decision, decision)
                     WHERE job_id = @jobId AND source_key = @sourceKey`),

    insertUsage: stmt(`INSERT OR IGNORE INTO usage_log
      (job_id, printer, task_name, source_key, spool_id, grams, status, max_progress, remaining_before, dry_run, write_state, created_at, updated_at)
      VALUES (@jobId, @printer, @taskName, @sourceKey, @spoolId, @grams, @status, @maxProgress, @remainingBefore, @dryRun, @writeState, @ts, @ts)`),
    usage: stmt(`SELECT * FROM usage_log WHERE id = ?`),
    usageFor: stmt(`SELECT * FROM usage_log WHERE job_id = ? AND source_key = ?`),
    usageState: stmt(`UPDATE usage_log SET write_state = @state, error = @error, spool_id = COALESCE(@spoolId, spool_id),
                      remaining_before = COALESCE(@remainingBefore, remaining_before), updated_at = @ts WHERE id = @id`),
    usageByState: stmt(`SELECT * FROM usage_log WHERE write_state = ? ORDER BY id`),
    usageAttempt: stmt(`UPDATE usage_log SET attempts = attempts + 1, updated_at = @ts WHERE id = @id RETURNING attempts`),
    usageRequeue: stmt(`UPDATE usage_log SET write_state = 'queued', spool_id = @spoolId, attempts = 0, error = NULL,
                        remaining_before = NULL, updated_at = @ts WHERE id = @id`),
    listUsage: stmt(`SELECT * FROM usage_log ORDER BY id DESC LIMIT ?`),
    usageForJob: stmt(`SELECT * FROM usage_log WHERE job_id = ? ORDER BY source_key`),

    insertPending: stmt(`INSERT INTO pending (job_id, source_key, reason, candidates, created_at)
                         VALUES (@jobId, @sourceKey, @reason, @candidates, @ts)
                         ON CONFLICT (job_id, source_key) DO UPDATE SET reason = excluded.reason, candidates = excluded.candidates
                         WHERE pending.state = 'open'`),
    pendingFor: stmt(`SELECT * FROM pending WHERE job_id = ? AND source_key = ?`),
    pending: stmt(`SELECT * FROM pending WHERE id = ?`),
    listPending: stmt(`SELECT * FROM pending WHERE state = ? ORDER BY id DESC`),
    closePending: stmt(`UPDATE pending SET state = @state, chosen_spool_id = @spoolId, resolved_at = @ts
                        WHERE id = @id AND state = 'open'`),
    dropOpenPending: stmt(`DELETE FROM pending WHERE job_id = ? AND source_key = ? AND state = 'open'`),
  };

  return {
    db,
    close: () => db.close(),

    createJob({ printer, taskName = null, startTime = null, adopted = false, dryRun }) {
      return Number(q.insertJob.run({ printer, taskName, startTime, adopted: bool(adopted), dryRun: bool(dryRun), createdAt: now() }).lastInsertRowid);
    },
    getJob: (id) => q.job.get(id),
    getActiveJob: (printer) => q.activeJob.get(printer),
    listActiveJobs: () => q.activeJobs.all(),
    findJobByStart: (printer, startTime, toleranceSec) => q.jobByStart.get({ printer, startTime, tolerance: toleranceSec }),
    updateJobMeta: (id, { taskName = null, startTime = null }) => q.jobMeta.run({ id, taskName, startTime }),
    // Persisted on every increase so a failed print survives a restart with its real progress.
    raiseMaxProgress: (id, progress) => q.raiseProgress.run({ id, progress }).changes > 0,
    endJob: (id, state, totalGrams = null) => q.endJob.run({ id, state, totalGrams, endedAt: now() }).changes > 0,
    listJobs: (limit = 50) => q.listJobs.all(limit),
    lastEndedJob: (printer) => q.lastEndedJob.get(printer),

    // Replaces a job's sources after a (re-)snapshot. Open pending rows for sources that
    // disappeared from print_weight are dropped.
    replaceJobSources: db.transaction((jobId, sources) => {
      const before = q.sources.all(jobId).map((s) => s.source_key);
      q.deleteSources.run(jobId);
      for (const s of sources) {
        q.insertSource.run({
          jobId,
          sourceKey: s.sourceKey,
          grams: s.grams,
          kind: s.kind,
          unit: s.unit ?? null,
          slot: s.slot ?? null,
          location: s.location ?? null,
          trayUuid: s.trayUuid ?? null,
          filamentId: s.filamentId ?? null,
          colorHex: s.colorHex ?? null,
          material: s.material ?? null,
          name: s.name ?? null,
          spoolId: s.spoolId ?? null,
          resolution: s.resolution ?? null,
          decision: s.decision ? JSON.stringify(s.decision) : null,
        });
      }
      const keep = new Set(sources.map((s) => s.sourceKey));
      for (const key of before) if (!keep.has(key)) q.dropOpenPending.run(jobId, key);
    }),
    getJobSources: (jobId) => q.sources.all(jobId).map((s) => ({ ...s, decision: s.decision ? JSON.parse(s.decision) : null })),
    setSourceResolution: (jobId, sourceKey, { spoolId, resolution, decision = null }) =>
      q.setSource.run({ jobId, sourceKey, spoolId, resolution, decision: decision ? JSON.stringify(decision) : null }),

    // Returns the new usage row id, or null when this source was already recorded.
    recordUsage({ jobId, printer, taskName = null, sourceKey, spoolId = null, grams, status, maxProgress = null, remainingBefore = null, dryRun, writeState }) {
      const info = q.insertUsage.run({
        jobId, printer, taskName, sourceKey, spoolId, grams, status, maxProgress, remainingBefore, dryRun: bool(dryRun), writeState, ts: now(),
      });
      return info.changes ? Number(info.lastInsertRowid) : null;
    },
    getUsage: (id) => q.usage.get(id),
    getUsageFor: (jobId, sourceKey) => q.usageFor.get(jobId, sourceKey),
    setUsageState: (id, state, { error = null, spoolId = null, remainingBefore = null } = {}) =>
      q.usageState.run({ id, state, error, spoolId, remainingBefore, ts: now() }),
    usageByState: (state) => q.usageByState.all(state),
    // Returns the new attempt count.
    countUsageAttempt: (id) => q.usageAttempt.get({ id, ts: now() }).attempts,
    requeueUsage: (id, spoolId) => q.usageRequeue.run({ id, spoolId, ts: now() }),
    listUsage: (limit = 100) => q.listUsage.all(limit),
    usageForJob: (jobId) => q.usageForJob.all(jobId),

    upsertPending({ jobId, sourceKey, reason, candidates }) {
      q.insertPending.run({ jobId, sourceKey, reason, candidates: JSON.stringify(candidates), ts: now() });
      return parsePending(q.pendingFor.get(jobId, sourceKey));
    },
    getPending: (id) => parsePending(q.pending.get(id)),
    getPendingFor: (jobId, sourceKey) => parsePending(q.pendingFor.get(jobId, sourceKey)),
    listPending: (state = 'open') => q.listPending.all(state).map(parsePending),
    closePending: (id, state, spoolId = null) => q.closePending.run({ id, state, spoolId, ts: now() }).changes > 0,
  };
}

function migrate(db) {
  const version = db.pragma('user_version', { simple: true });
  if (version === SCHEMA_VERSION) return;
  if (version > SCHEMA_VERSION) throw new Error(`Database schema v${version} is newer than this bridge (v${SCHEMA_VERSION})`);
  db.transaction(() => {
    if (version < 1) db.exec(SCHEMA);
    if (version < 2) db.exec(`ALTER TABLE usage_log ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}
