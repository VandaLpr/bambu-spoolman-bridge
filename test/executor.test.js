import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ATTEMPTS_BEFORE_NOTICE, createExecutor } from '../src/executor.js';
import { resolveSource } from '../src/resolver.js';
import { identityFromTray } from '../src/sources.js';
import { readExtra } from '../src/spoolman/extra.js';
import { openStore } from '../src/store.js';
import { createFakeSpoolman, createRecordingNotifier, httpError, silentLog } from './fixtures/fakes.js';
import { catalog, tray } from './fixtures/ha.js';
import { goldFilament, goldSpool } from './fixtures/spoolman.js';

let store;
beforeEach(() => {
  store = openStore(':memory:');
});
afterEach(() => store.close());

function setup({ dryRun = false, ...fake } = {}) {
  const spoolman = createFakeSpoolman({ spools: [goldSpool], filaments: [goldFilament], catalog, dryRun, ...fake });
  const notifier = createRecordingNotifier();
  const executor = createExecutor({ spoolman, store, notifier, dryRun, log: silentLog, now: () => '2026-10-13T12:00:00.000Z' });
  const job = store.getJob(store.createJob({ printer: 'p2s', taskName: 'Test print', dryRun }));
  return { spoolman, notifier, executor, job };
}

const deduct = (executor, job, grams = 1.02, spoolId = 1) =>
  executor.recordDeduction({ job, sourceKey: 'AMS 1 Tray 1', spoolId, grams, status: 'finish' });

test('a queued deduction persists remaining_before, calls use and ends applied', async () => {
  const { spoolman, executor, job } = setup();
  const id = deduct(executor, job);
  assert.equal(store.getUsage(id).write_state, 'queued');
  await executor.processQueue();
  const row = store.getUsage(id);
  assert.equal(row.write_state, 'applied');
  assert.equal(row.remaining_before, 850);
  assert.equal(spoolman.db.spools[0].remaining_weight, 848.98);
  assert.deepEqual(spoolman.writes('patchSpool').at(-1), ['patchSpool', 1, { last_used: '2026-10-13T12:00:00.000Z' }, null]);
});

test('a source is never deducted twice', async () => {
  const { spoolman, executor, job } = setup();
  deduct(executor, job);
  assert.equal(deduct(executor, job), null);
  await executor.processQueue();
  await executor.processQueue();
  assert.equal(spoolman.writes('useWeight').length, 1);
});

test('an error before anything was sent leaves the row failed, and the retry applies it', async () => {
  const { spoolman, executor, job } = setup();
  const id = deduct(executor, job);
  spoolman.failNext('getSpool');
  await executor.processQueue();
  assert.equal(store.getUsage(id).write_state, 'failed');
  await executor.processQueue();
  assert.equal(store.getUsage(id).write_state, 'applied');
  assert.equal(spoolman.db.spools[0].remaining_weight, 848.98);
});

test('recovery: use landed but the response was lost -> marked applied, not re-sent', async () => {
  const { spoolman, executor, job } = setup();
  const id = deduct(executor, job);
  spoolman.failNext('useWeight:after');
  await executor.processQueue();
  assert.equal(store.getUsage(id).write_state, 'planned');
  await executor.processQueue(); // e.g. the next retry tick or a restart
  assert.equal(store.getUsage(id).write_state, 'applied');
  assert.equal(spoolman.writes('useWeight').length, 1);
  assert.equal(spoolman.db.spools[0].remaining_weight, 848.98);
});

test('recovery: use never landed -> re-applied once', async () => {
  const { spoolman, executor, job } = setup();
  const id = deduct(executor, job);
  spoolman.failNext('useWeight:before');
  await executor.processQueue();
  assert.equal(store.getUsage(id).write_state, 'planned');
  assert.equal(spoolman.db.spools[0].remaining_weight, 850);
  await executor.processQueue();
  assert.equal(store.getUsage(id).write_state, 'applied');
  assert.equal(spoolman.db.spools[0].remaining_weight, 848.98);
});

test('recovery: the spool changed in between -> uncertain and a notification', async () => {
  const { spoolman, notifier, executor, job } = setup();
  const id = deduct(executor, job);
  spoolman.failNext('useWeight:before');
  await executor.processQueue();
  spoolman.db.spools[0].remaining_weight = 700; // weighed and corrected by hand
  await executor.processQueue();
  assert.equal(store.getUsage(id).write_state, 'uncertain');
  assert.equal(notifier.sent.problems.length, 1);
  assert.match(notifier.sent.problems[0].message, /spool #1/);
  assert.equal(spoolman.db.spools[0].remaining_weight, 700);
});

test('a source without a spool is parked and not sent', async () => {
  const { spoolman, executor, job } = setup();
  const id = deduct(executor, job, 1.02, null);
  await executor.processQueue();
  assert.equal(store.getUsage(id).write_state, 'parked');
  assert.equal(spoolman.writes('useWeight').length, 0);
});

test('DRY_RUN records dry_run rows and never deducts', async () => {
  const { spoolman, executor, job } = setup({ dryRun: true });
  const id = deduct(executor, job);
  await executor.processQueue();
  assert.equal(store.getUsage(id).write_state, 'dry_run');
  assert.equal(spoolman.calls.length, 0);
  assert.equal(spoolman.db.spools[0].remaining_weight, 850);
});

test('create: a filament created after the inventory snapshot is reused (fresh dedupe check)', async () => {
  const { spoolman, executor } = setup();
  const identity = identityFromTray(tray(3)); // PLA Matte #BB3D43, not in Spoolman yet
  const decision = resolveSource({ identity, location: 'P2S AMS1 Slot 3', inventory: { spools: [], filaments: [goldFilament] } });
  assert.equal(decision.filamentId, null);
  // Meanwhile another source created the same filament:
  await spoolman.createFilament({ name: 'Matte Dark Red', material: 'PLA', color_hex: 'BB3D43', weight: 1000, extra: { bambu_filament_id: 'GFA01' } });
  spoolman.calls.length = 0;

  const { spoolId, resolution } = await executor.applyDecision(decision);
  assert.equal(resolution, 'created');
  assert.equal(spoolman.writes('createFilament').length, 0);
  const created = spoolman.db.spools.find((s) => s.id === spoolId);
  assert.equal(created.filament.name, 'Matte Dark Red');
  assert.equal(created.remaining_weight, 770); // 77% of 1000 g
  assert.equal(readExtra(created, 'rfid_uuid'), identity.trayUuid);
  assert.deepEqual(created.tags.map((t) => t.uid), [identity.trayUuid]);
});

test('create: imports the SpoolmanDB entry when no local filament matches', async () => {
  const { spoolman, executor } = setup();
  const decision = resolveSource({ identity: identityFromTray(tray(4)), location: 'P2S AMS1 Slot 4', inventory: { spools: [], filaments: [] } });
  await executor.applyDecision(decision);
  const [[, params]] = spoolman.writes('createFilament');
  assert.equal(params.external_id, 'bambulab_pla_beige_1000_175_n');
  assert.equal(params.vendor_id, 1);
});

test('create in DRY_RUN logs the planned writes and returns no spool id', async () => {
  const { spoolman, executor } = setup({ dryRun: true });
  const decision = resolveSource({ identity: identityFromTray(tray(4)), location: 'P2S AMS1 Slot 4', inventory: { spools: [], filaments: [] } });
  assert.deepEqual(await executor.applyDecision(decision), { spoolId: null, resolution: 'created' });
  assert.deepEqual(spoolman.calls.map((c) => c[0]), ['createFilament', 'createSpool']);
  assert.equal(spoolman.db.spools.length, 1);
});

test('a tag conflict is reported, not thrown', async () => {
  const { spoolman, notifier, executor } = setup();
  spoolman.db.spools[0].tags = [{ uid: 'ABCD', format: 'bambu' }];
  spoolman.db.spools.push({ ...structuredClone(goldSpool), id: 2, extra: {}, tags: [] });
  await executor.runWrites([{ op: 'linkTag', spoolId: 2, uid: 'ABCD', format: 'bambu' }]);
  assert.equal(notifier.sent.problems.length, 1);
  assert.match(notifier.sent.problems[0].message, /spool #1/);
});

test('HTTP 404 (spool deleted): needs_attention, one notification, no automatic retry', async () => {
  const { spoolman, notifier, executor, job } = setup();
  const id = deduct(executor, job);
  spoolman.failNext('getSpool', httpError(404));
  await executor.processQueue();
  await executor.processQueue();
  const row = store.getUsage(id);
  assert.equal(row.write_state, 'needs_attention');
  assert.equal(row.attempts, 1);
  assert.equal(notifier.sent.problems.length, 1);
  const [n] = notifier.sent.problems;
  assert.match(n.message, /1\.02 g for spool #1 \(job \d+, AMS 1 Tray 1\)/);
  assert.equal(n.path, `/usage/${id}`);
  assert.equal(spoolman.writes('useWeight').length, 0);
});

test('HTTP 422 on the use call: it did not land, so needs_attention instead of planned', async () => {
  const { spoolman, executor, job } = setup();
  const id = deduct(executor, job);
  spoolman.failNext('useWeight:before', httpError(422));
  await executor.processQueue();
  assert.equal(store.getUsage(id).write_state, 'needs_attention');
  assert.equal(spoolman.db.spools[0].remaining_weight, 850);
});

test('HTTP 5xx on the use call: not landed, back to failed and retried', async () => {
  const { spoolman, notifier, executor, job } = setup();
  const id = deduct(executor, job);
  spoolman.failNext('useWeight:before', httpError(503));
  await executor.processQueue();
  assert.equal(store.getUsage(id).write_state, 'failed'); // not 'planned': no recovery guesswork
  assert.equal(store.getUsage(id).attempts, 1);
  await executor.processQueue();
  assert.equal(store.getUsage(id).write_state, 'applied');
  assert.equal(spoolman.db.spools[0].remaining_weight, 848.98);
  assert.equal(notifier.sent.problems.length, 0);
});

test(`transient failures notify once after ${ATTEMPTS_BEFORE_NOTICE} attempts, then keep retrying silently`, async () => {
  const { spoolman, notifier, executor, job } = setup();
  const id = deduct(executor, job);
  spoolman.failNext('getSpool', httpError(502), ATTEMPTS_BEFORE_NOTICE + 2);
  for (let i = 1; i <= ATTEMPTS_BEFORE_NOTICE - 1; i++) await executor.processQueue();
  assert.equal(notifier.sent.problems.length, 0);
  await executor.processQueue(); // attempt 12
  assert.equal(notifier.sent.problems.length, 1);
  assert.equal(notifier.sent.problems[0].title, 'Spoolman unreachable');
  await executor.processQueue(); // 13
  await executor.processQueue(); // 14
  assert.equal(notifier.sent.problems.length, 1);
  assert.equal(store.getUsage(id).attempts, ATTEMPTS_BEFORE_NOTICE + 2);
  await executor.processQueue(); // Spoolman is back
  assert.equal(store.getUsage(id).write_state, 'applied');
});

test('a network error during recovery keeps the row planned and counts the attempt', async () => {
  const { spoolman, executor, job } = setup();
  const id = deduct(executor, job);
  spoolman.failNext('useWeight:after'); // landed, response lost -> planned
  await executor.processQueue();
  spoolman.failNext('getSpool');
  await executor.processQueue();
  assert.equal(store.getUsage(id).write_state, 'planned');
  assert.equal(store.getUsage(id).attempts, 2);
  await executor.processQueue();
  assert.equal(store.getUsage(id).write_state, 'applied');
  assert.equal(spoolman.writes('useWeight').length, 1);
});

test('requeue: a rejected deduction can go to another spool, or be skipped', async () => {
  const { spoolman, executor, job } = setup();
  spoolman.db.spools.push({ ...structuredClone(goldSpool), id: 2, remaining_weight: 500, extra: {} });
  const id = deduct(executor, job);
  spoolman.failNext('getSpool', httpError(404));
  await executor.processQueue();

  assert.equal((await executor.requeue(id, 99)).ok, false); // unknown spool
  const result = await executor.requeue(id, 2);
  assert.equal(result.ok, true);
  const row = store.getUsage(id);
  assert.deepEqual([row.write_state, row.spool_id, row.attempts, row.error], ['applied', 2, 0, null]);
  assert.equal(spoolman.db.spools[1].remaining_weight, 498.98);

  assert.equal((await executor.requeue(id, 2)).ok, false); // only needs_attention rows

  const job2 = store.getJob(store.createJob({ printer: 'p2s', dryRun: false }));
  const id2 = deduct(executor, job2);
  spoolman.failNext('getSpool', httpError(404));
  await executor.processQueue();
  assert.equal((await executor.requeue(id2, null)).ok, true);
  assert.equal(store.getUsage(id2).write_state, 'skipped');
});
