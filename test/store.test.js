import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';

let store;
beforeEach(() => {
  store = openStore(':memory:');
});
afterEach(() => store.close());

const source = (sourceKey, grams, extra = {}) => ({ sourceKey, grams, kind: 'ams', unit: 1, slot: Number(sourceKey.at(-1)), ...extra });

test('a source is recorded in usage_log at most once', () => {
  const jobId = store.createJob({ printer: 'p2s', dryRun: true });
  const row = { jobId, printer: 'p2s', sourceKey: 'AMS 1 Tray 1', spoolId: 1, grams: 1.02, status: 'finish', dryRun: true, writeState: 'dry_run' };
  assert.ok(store.recordUsage(row));
  assert.equal(store.recordUsage({ ...row, grams: 99 }), null);
  assert.equal(store.listUsage().length, 1);
  assert.equal(store.listUsage()[0].grams, 1.02);
});

test('max progress only ever increases and is persisted', () => {
  const jobId = store.createJob({ printer: 'p2s', dryRun: true });
  assert.equal(store.raiseMaxProgress(jobId, 5), true);
  assert.equal(store.raiseMaxProgress(jobId, 63), true);
  assert.equal(store.raiseMaxProgress(jobId, 0), false); // progress drops to 0 after failed
  assert.equal(store.getJob(jobId).max_progress, 63);
});

test('a job ends once and is no longer active', () => {
  const jobId = store.createJob({ printer: 'p2s', dryRun: true });
  assert.equal(store.getActiveJob('p2s').id, jobId);
  assert.equal(store.endJob(jobId, 'failed', 0.35), true);
  assert.equal(store.endJob(jobId, 'finish', 0.56), false);
  assert.equal(store.getActiveJob('p2s'), undefined);
  assert.equal(store.getJob(jobId).state, 'failed');
});

test('re-snapshot replaces sources and drops open pending rows for vanished sources', () => {
  const jobId = store.createJob({ printer: 'p2s', dryRun: true });
  store.replaceJobSources(jobId, [source('AMS 1 Tray 1', 21.92)]);
  store.upsertPending({ jobId, sourceKey: 'AMS 1 Tray 1', reason: 'no_match', candidates: [] });
  store.replaceJobSources(jobId, [source('AMS 1 Tray 3', 21.92, { decision: { status: 'resolved' } })]);
  assert.deepEqual(store.getJobSources(jobId).map((s) => [s.source_key, s.decision]), [['AMS 1 Tray 3', { status: 'resolved' }]]);
  assert.equal(store.getPendingFor(jobId, 'AMS 1 Tray 1'), undefined);
});

test('pending upsert refreshes open rows but never reopens a resolved one', () => {
  const jobId = store.createJob({ printer: 'a1', dryRun: true });
  const p = store.upsertPending({ jobId, sourceKey: 'External Spool', reason: 'no_match', candidates: [{ spoolId: 1 }] });
  assert.equal(store.upsertPending({ jobId, sourceKey: 'External Spool', reason: 'ambiguous_opened', candidates: [] }).reason, 'ambiguous_opened');
  assert.equal(store.closePending(p.id, 'resolved', 20), true);
  const after = store.upsertPending({ jobId, sourceKey: 'External Spool', reason: 'no_match', candidates: [] });
  assert.equal(after.state, 'resolved');
  assert.equal(after.chosen_spool_id, 20);
  assert.equal(store.closePending(p.id, 'skipped'), false);
});

test('findJobByStart matches within the tolerance', () => {
  const jobId = store.createJob({ printer: 'p2s', startTime: '2026-10-12T22:19:00+00:00', dryRun: true });
  assert.equal(store.findJobByStart('p2s', '2026-10-12T22:18:59+00:00', 120)?.id, jobId);
  assert.equal(store.findJobByStart('p2s', '2026-10-12T22:43:49+00:00', 120), undefined);
  assert.equal(store.findJobByStart('a1', '2026-10-12T22:19:00+00:00', 120), undefined);
});

test('updateJobMeta keeps known values when HA reports unknown', () => {
  const jobId = store.createJob({ printer: 'p2s', taskName: 'Test print', startTime: '2026-10-12T22:19:00+00:00', dryRun: true });
  store.updateJobMeta(jobId, { startTime: '2026-10-12T22:18:59+00:00' });
  const job = store.getJob(jobId);
  assert.equal(job.task_name, 'Test print');
  assert.equal(job.start_time, '2026-10-12T22:18:59+00:00');
});

test('a v1 database is migrated to v6: attempts, started_at, stage tracking, intake, pending kinds', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'bsb-'));
  const file = join(dir, 'bridge.db');
  const v2 = openStore(file);
  v2.db.exec('ALTER TABLE usage_log DROP COLUMN attempts');
  v2.db.exec('ALTER TABLE jobs DROP COLUMN started_at');
  v2.db.exec('ALTER TABLE jobs DROP COLUMN stage_tracked');
  v2.db.exec('ALTER TABLE jobs DROP COLUMN print_baseline');
  v2.db.exec('DROP INDEX pending_insert_tray');
  for (const c of ['kind', 'printer', 'tray_uuid', 'context']) v2.db.exec(`ALTER TABLE pending DROP COLUMN ${c}`);
  v2.db.exec('DROP TABLE intake_spools');
  v2.db.exec('DROP TABLE intake_batches');
  v2.db.pragma('user_version = 1');
  v2.close();
  const migrated = openStore(file);
  assert.equal(migrated.db.pragma('user_version', { simple: true }), 6);
  assert.equal(migrated.beginIntakeBatch('b1', 'h'), true);
  const jobId = migrated.createJob({ printer: 'p2s', startedAt: '2026-10-13T21:10:59.844Z', dryRun: false });
  assert.equal(migrated.getJob(jobId).started_at, '2026-10-13T21:10:59.844Z');
  assert.equal(migrated.getJob(jobId).stage_tracked, 0);
  assert.equal(migrated.getJob(jobId).print_baseline, null);
  const id = migrated.recordUsage({ jobId, printer: 'p2s', sourceKey: 'AMS 1 Tray 1', spoolId: 1, grams: 1, status: 'finish', dryRun: false, writeState: 'queued' });
  assert.equal(migrated.countUsageAttempt(id), 1);
  migrated.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the printing baseline is written once and survives later returns to printing', () => {
  const jobId = store.createJob({ printer: 'p2s', stageTracked: true, dryRun: false });
  assert.equal(store.getJob(jobId).stage_tracked, 1);
  assert.equal(store.setPrintBaseline(jobId, 60), true);
  assert.equal(store.setPrintBaseline(jobId, 85), false); // e.g. printing again after a pause
  assert.equal(store.getJob(jobId).print_baseline, 60);
  store.setStageTracking(jobId, false);
  assert.deepEqual([store.getJob(jobId).stage_tracked, store.getJob(jobId).print_baseline], [0, null]);
});

test('intake spools: weighed ones never count as estimated; a correction is recorded once', () => {
  assert.equal(store.beginIntakeBatch('order-1', 'h1'), true);
  assert.equal(store.beginIntakeBatch('order-1', 'h1'), false); // already there
  store.recordIntakeSpool({ batchId: 'order-1', itemIndex: 0, unitIndex: 0, spoolId: 10, weighed: false });
  store.recordIntakeSpool({ batchId: 'order-1', itemIndex: 0, unitIndex: 1, spoolId: 11, weighed: true });
  store.recordIntakeSpool({ batchId: 'order-1', itemIndex: 0, unitIndex: 0, spoolId: 99, weighed: false }); // ignored: unit recorded
  assert.deepEqual(store.intakeSpools('order-1').map((r) => r.spool_id), [10, 11]);
  assert.deepEqual([...store.estimatedSpoolIds()], [10]);
  store.markRemainingCorrected(10);
  assert.deepEqual([...store.estimatedSpoolIds()], []);
  store.finishIntakeBatch('order-1');
  assert.equal(store.getIntakeBatch('order-1').state, 'applied');
});

test('v5 -> v6 keeps existing print questions and fills in printer and tray_uuid', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'bsb-'));
  const file = join(dir, 'bridge.db');
  const s = openStore(file);
  const jobId = s.createJob({ printer: 'p2s', dryRun: false });
  s.replaceJobSources(jobId, [{ sourceKey: 'AMS 1 Tray 3', grams: 1, kind: 'ams', unit: 1, slot: 3, trayUuid: 'ABCD' }]);
  s.upsertPending({ jobId, sourceKey: 'AMS 1 Tray 3', reason: 'ambiguous_pairing', candidates: [{ spoolId: 4 }] });
  s.db.exec('DROP INDEX pending_insert_tray');
  for (const c of ['kind', 'printer', 'tray_uuid', 'context']) s.db.exec(`ALTER TABLE pending DROP COLUMN ${c}`);
  s.db.pragma('user_version = 5');
  s.close();
  const migrated = openStore(file);
  const [p] = migrated.listPending();
  assert.deepEqual([p.kind, p.job_id, p.printer, p.tray_uuid, p.reason, p.candidates], ['print', jobId, 'p2s', 'ABCD', 'ambiguous_pairing', [{ spoolId: 4 }]]);
  migrated.close();
  rmSync(dir, { recursive: true, force: true });
});

test('an inserted spool is asked about once per tray_uuid, whatever the answer was', () => {
  const ask = () =>
    store.addInsertPending({ printer: 'p2s', sourceKey: 'AMS 1 Tray 3', trayUuid: 'ABCD', reason: 'ambiguous_pairing', candidates: [{ spoolId: 4 }], context: { location: 'x' } });
  const first = ask();
  assert.equal(first.created, true);
  assert.deepEqual([first.pending.kind, first.pending.job_id, first.pending.context], ['insert', null, { location: 'x' }]);
  assert.equal(ask().created, false);
  store.closePending(first.pending.id, 'skipped');
  assert.equal(ask().created, false);
  assert.equal(store.getInsertPending('ABCD').state, 'skipped');
});
