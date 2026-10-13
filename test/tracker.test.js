import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createExecutor } from '../src/executor.js';
import { resolveEntities } from '../src/ha/entities.js';
import { readExtra } from '../src/spoolman/extra.js';
import { openStore } from '../src/store.js';
import { PrinterTracker, resolvePending } from '../src/tracker.js';
import { createFakeSpoolman, createRecordingNotifier, createWorld, silentLog } from './fixtures/fakes.js';
import { a1External, activeTray, catalog, printWeight, tray } from './fixtures/ha.js';
import { filament, goldFilament, goldSpool, spool } from './fixtures/spoolman.js';

const P2S = { prefix: 'p2s', name: 'P2S', amsLocation: 'P2S AMS{unit} Slot {n}', externalLocation: 'P2S External', refreshDelayMs: 0, entities: {} };
const A1 = { prefix: 'a1', name: 'A1', amsLocation: 'A1 AMS{unit} Slot {n}', externalLocation: 'A1', refreshDelayMs: 0, entities: {} };

const T1 = '2026-10-12T22:19:00+00:00';
const uuid = (n) => tray(n).tray_uuid;

const blackFil = filament({ id: 2, name: 'Black', colorHex: '000000', bambuId: 'GFA00' });
const matteRedFil = filament({ id: 3, name: 'Matte Dark Red', colorHex: 'BB3D43', bambuId: 'GFA01' });
const petgWhiteFil = filament({ id: 10, name: 'White', material: 'PETG', colorHex: 'FFFFFF', bambuId: 'GFG00' });

const p2sSpools = () => [
  goldSpool, // tray 1: paired before tags existed (rfid_uuid only)
  spool({ id: 2, filament: blackFil, remaining: 600, firstUsed: T1, rfid: uuid(2), tags: [uuid(2)], location: 'P2S AMS1 Slot 2' }),
  spool({ id: 3, filament: matteRedFil, remaining: 900, firstUsed: T1 }), // tray 3: unbound, gets paired
  // tray 4 (beige) is unknown: auto-created from SpoolmanDB
];

const pw = (attrs) => ({ state: 'x', attributes: attrs });
const trays = () => Object.fromEntries([1, 2, 3, 4].map((n) => [`sensor.p2s_ams_1_tray_${n}`, { state: tray(n).name, attributes: tray(n) }]));

let store;
afterEach(() => store?.close());

function rig({ printer = P2S, spools = p2sSpools(), filaments = [goldFilament, blackFil, matteRedFil], dryRun = false, initial = {}, initialAt, weightWaitMs = 60_000 } = {}) {
  store = openStore(':memory:');
  const spoolman = createFakeSpoolman({ spools, filaments, catalog, dryRun });
  const notifier = createRecordingNotifier();
  const executor = createExecutor({ spoolman, store, notifier, dryRun, log: silentLog });
  const world = createWorld(printer.prefix, {
    ...(printer === P2S ? trays() : {}),
    status: 'finish',
    progress: '100',
    startTime: '2026-10-12T20:00:00+00:00',
    taskName: 'Old print',
    printWeight: pw({ 'AMS 1 Tray 4': 54.44 }),
    ...initial,
  }, initialAt);
  const { ids } = resolveEntities(printer, world.get());
  const warnings = [];
  const log = { ...silentLog, warn: (m) => warnings.push(m) };
  const ha = { pressed: [], pressButton: async (id) => ha.pressed.push(id) };
  const config = { dryRun, jobStartToleranceSec: 120, nearestColorMaxDeltaE: 20 };
  const tracker = new PrinterTracker({ printer, ids, store, executor, notifier, ha, config, log, sleep: async () => {}, debounceMs: 0, weightWaitMs });
  const push = async (changes, at) => {
    tracker.onEntities(world.update(changes, at));
    await tracker.idle();
  };
  const start = async () => {
    tracker.startup(world.get());
    await tracker.idle();
  };
  const spoolById = (id) => spoolman.db.spools.find((s) => s.id === id);
  const usage = () => store.listUsage().map((u) => [u.source_key, u.spool_id, u.grams, u.write_state]).sort();
  return { spoolman, notifier, executor, world, tracker, push, start, spoolById, usage, warnings };
}

async function fourColorPrint(r) {
  await r.push({ status: 'prepare', progress: '0', startTime: T1, taskName: 'Test print', printWeight: pw(printWeight.fourColor) });
  await r.push({ startTime: '2026-10-12T22:18:59+00:00' }); // exact value follows the rounded one
  await r.push({ status: 'running' });
  await r.push({ progress: '50' });
  await r.push({ progress: '100', status: 'finish' });
}

describe('P2S with AMS', () => {
  test('multi-color print: every slot resolved, paired or created, and deducted on finish', async () => {
    const r = rig();
    await r.start();
    assert.equal(store.listJobs().length, 0); // startup on "finish" with no open job does nothing
    await fourColorPrint(r);

    const [job] = store.listJobs();
    assert.equal(store.listJobs().length, 1);
    assert.equal(job.state, 'finish');
    assert.equal(job.total_grams, 4.16);
    assert.equal(job.start_time, '2026-10-12T22:18:59+00:00');
    const created = r.spoolman.db.spools.find((s) => s.id >= 1000);
    assert.deepEqual(r.usage(), [
      ['AMS 1 Tray 1', 1, 1.02, 'applied'],
      ['AMS 1 Tray 2', 2, 1.05, 'applied'],
      ['AMS 1 Tray 3', 3, 0.64, 'applied'],
      ['AMS 1 Tray 4', created.id, 1.45, 'applied'],
    ]);
    assert.equal(r.spoolById(1).remaining_weight, 848.98);
    assert.equal(r.spoolById(2).remaining_weight, 598.95);
    assert.equal(r.spoolById(3).remaining_weight, 899.36);
    assert.equal(created.remaining_weight, 868.55); // 87% of 1000 g, then 1.45 g used

    // Spool #1 migrated to a native tag and got its slot location.
    assert.deepEqual(r.spoolById(1).tags.map((t) => t.uid), [uuid(1)]);
    assert.equal(r.spoolById(1).location, 'P2S AMS1 Slot 1');
    // Spool #3 was paired with tray 3's RFID.
    assert.equal(readExtra(r.spoolById(3), 'rfid_uuid'), uuid(3));
    assert.deepEqual(r.spoolById(3).tags.map((t) => t.uid), [uuid(3)]);
    // Tray 4's filament came from SpoolmanDB.
    assert.equal(created.filament.external_id, 'bambulab_pla_beige_1000_175_n');
    assert.equal(r.notifier.sent.pending.length, 0);
  });

  test('failed print deducts grams x max progress (real failure at 63%)', async () => {
    const r = rig();
    await r.start();
    await r.push({ status: 'prepare', progress: '0', startTime: T1, taskName: 'Test print', printWeight: pw(printWeight.failedAt63) });
    await r.push({ status: 'running' });
    for (const p of ['5', '60', '63']) await r.push({ progress: p });
    await r.push({ status: 'failed' });
    await r.push({ progress: '0' });
    assert.deepEqual(r.usage(), [['AMS 1 Tray 2', 2, 0.35, 'applied']]);
    assert.equal(r.spoolById(2).remaining_weight, 599.65);
    assert.equal(store.listJobs()[0].max_progress, 63);
  });

  test('running -> pause -> running -> finish is one job', async () => {
    const r = rig();
    await r.start();
    await r.push({ status: 'prepare', progress: '0', startTime: T1, taskName: 'Test print', printWeight: pw(printWeight.failedAt63) });
    await r.push({ status: 'running', progress: '30' });
    await r.push({ status: 'pause' });
    await r.push({ status: 'running' });
    await r.push({ status: 'finish', progress: '100' });
    assert.equal(store.listJobs().length, 1);
    assert.deepEqual(r.usage(), [['AMS 1 Tray 2', 2, 0.56, 'applied']]);
  });

  test('a stale "running" after finish does not create a second job (same start_time or start_time unknown)', async () => {
    const r = rig();
    await r.start();
    await fourColorPrint(r);
    await r.push({ status: 'offline' });
    await r.push({ status: 'running' });
    await r.push({ status: 'finish' });
    await r.push({ status: 'offline', startTime: 'unknown' });
    await r.push({ status: 'running' });
    await r.push({ status: 'finish' });
    assert.equal(store.listJobs().length, 1);
    assert.equal(r.spoolman.writes('useWeight').length, 4);
  });

  test('HA re-emitting the final status after its restart does nothing', async () => {
    const r = rig();
    await r.start();
    await fourColorPrint(r);
    await r.push({ status: 'unavailable', startTime: 'unknown' });
    await r.push({ status: 'finish' });
    assert.equal(store.listJobs().length, 1);
    assert.equal(r.spoolman.writes('useWeight').length, 4);
  });

  test('late print_weight correction before the print gets going re-snapshots', async () => {
    const r = rig();
    await r.start();
    await r.push({ status: 'prepare', progress: '0', startTime: T1, taskName: 'Test print', printWeight: pw(printWeight.lateFirst) });
    await r.push({ printWeight: pw(printWeight.lateCorrected) });
    await r.push({ status: 'running', progress: '10' });
    await r.push({ printWeight: pw({ 'AMS 1 Tray 1': 3 }) }); // after progress > 0: ignored
    await r.push({ status: 'finish', progress: '100' });
    assert.deepEqual(r.usage(), [['AMS 1 Tray 3', 3, 21.92, 'applied']]);
  });

  test('bridge starts mid-print with no open job: the print is adopted with its progress', async () => {
    // progress last changed after start_time: it belongs to this print
    const r = rig({ initial: { status: 'running', progress: '40', startTime: T1, taskName: 'Test print', printWeight: pw(printWeight.fourColor) }, initialAt: '2026-10-12T22:30:00.000Z' });
    await r.start();
    const [job] = store.listJobs();
    assert.equal(job.adopted, 1);
    assert.equal(job.max_progress, 40);
    assert.equal(store.getJobSources(job.id).length, 4);
    await r.push({ status: 'finish', progress: '100' });
    assert.equal(r.usage().length, 4);
  });

  test('bridge starts with an open job and status failed: closed with the persisted max progress', async () => {
    const r = rig({ initial: { status: 'failed', progress: '0', startTime: T1, taskName: 'Test print', printWeight: pw(printWeight.failedAt63) } });
    const jobId = store.createJob({ printer: 'p2s', taskName: 'Test print', startTime: T1, dryRun: false });
    store.replaceJobSources(jobId, [{ sourceKey: 'AMS 1 Tray 2', grams: 0.56, kind: 'ams', unit: 1, slot: 2, spoolId: 2, resolution: 'tag' }]);
    store.raiseMaxProgress(jobId, 63);
    await r.start();
    assert.equal(store.getJob(jobId).state, 'failed');
    assert.deepEqual(r.usage(), [['AMS 1 Tray 2', 2, 0.35, 'applied']]);
  });

  test('a new print while a job is still open closes the old one as missed_end and notifies', async () => {
    const r = rig();
    await r.start();
    await r.push({ status: 'prepare', progress: '0', startTime: T1, taskName: 'First', printWeight: pw(printWeight.failedAt63) });
    await r.push({ status: 'running', progress: '20' });
    await r.push({ status: 'idle' });
    await r.push({ status: 'prepare', progress: '0', startTime: '2026-10-12T23:30:00+00:00', taskName: 'Second' });
    const [second, first] = store.listJobs();
    assert.equal(first.state, 'missed_end');
    assert.equal(second.state, 'active');
    assert.equal(r.notifier.sent.problems.length, 1);
    assert.equal(r.usage().length, 0);
  });

  test('active tray outside the snapshot logs a warning; a slot change inside it does not', async () => {
    const r = rig({ initial: { activeTray: { state: 'x', attributes: { ...activeTray, ams_index: 0, tray_index: 0 } } } });
    await r.start();
    await r.push({ status: 'prepare', progress: '0', startTime: T1, taskName: 'Test print', printWeight: pw({ 'AMS 1 Tray 1': 1, 'AMS 1 Tray 2': 1 }) });
    await r.push({ status: 'running', progress: '5' });
    await r.push({ activeTray: { state: 'x', attributes: { ...activeTray, tray_index: 1 } } }); // tray 2: in snapshot
    assert.equal(r.warnings.length, 0);
    await r.push({ activeTray: { state: 'x', attributes: { ...activeTray, tray_index: 3 } } }); // tray 4: not
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /AMS 1 Tray 4/);
  });

  test('DRY_RUN: the whole print is logged, nothing in Spoolman changes', async () => {
    const r = rig({ dryRun: true });
    const before = structuredClone(r.spoolman.db.spools);
    await r.start();
    await fourColorPrint(r);
    assert.deepEqual(r.spoolman.db.spools, before);
    assert.equal(r.spoolman.writes('useWeight').length, 0);
    assert.ok(r.spoolman.writes('linkTag').length > 0); // would-be writes are visible in the log
    assert.deepEqual(r.usage().map((u) => u[3]), ['dry_run', 'dry_run', 'dry_run', 'dry_run']);
  });
});

describe('A1 external spool', () => {
  const a1World = { 'sensor.a1_external_spool_external_spool': { state: 'Bambu PETG Basic', attributes: a1External } };
  const twoOpened = () => [
    spool({ id: 20, filament: petgWhiteFil, remaining: 500, firstUsed: T1 }),
    spool({ id: 21, filament: petgWhiteFil, remaining: 800, firstUsed: T1 }),
  ];

  test('ambiguous external spool: notification, parked deduction, applied after the answer', async () => {
    const r = rig({ printer: A1, spools: twoOpened(), filaments: [petgWhiteFil], initial: a1World });
    await r.start();
    await r.push({ status: 'prepare', progress: '0', startTime: T1, taskName: 'Test print', printWeight: pw(printWeight.a1External) });
    assert.deepEqual(r.spoolman.writes('patchSpool'), []);
    assert.equal(r.notifier.sent.pending.length, 1);
    const { pending } = r.notifier.sent.pending[0];
    assert.equal(pending.reason, 'ambiguous_opened');
    assert.deepEqual(pending.candidates.map((c) => c.spoolId), [20, 21]);

    await r.push({ status: 'running', progress: '50' });
    await r.push({ status: 'finish', progress: '100' });
    assert.deepEqual(r.usage(), [['External Spool', null, 10.07, 'parked']]);

    const result = await resolvePending({ store, spoolman: r.spoolman, executor: r.executor, log: silentLog, pendingId: pending.id, spoolId: 21 });
    assert.equal(result.ok, true);
    assert.deepEqual(r.usage(), [['External Spool', 21, 10.07, 'applied']]);
    assert.equal(r.spoolById(21).remaining_weight, 789.93);
    assert.equal(r.spoolById(21).location, 'A1');
    assert.equal(store.getPending(pending.id).state, 'resolved');

    const again = await resolvePending({ store, spoolman: r.spoolman, executor: r.executor, log: silentLog, pendingId: pending.id, spoolId: 20 });
    assert.equal(again.ok, false);
    assert.equal(r.spoolman.writes('useWeight').length, 1);
  });

  test('an answer given during the print survives a re-snapshot', async () => {
    const r = rig({ printer: A1, spools: twoOpened(), filaments: [petgWhiteFil], initial: a1World });
    await r.start();
    await r.push({ status: 'prepare', progress: '0', startTime: T1, taskName: 'Test print', printWeight: pw({ 'External Spool': 9 }) });
    const { pending } = r.notifier.sent.pending[0];
    await resolvePending({ store, spoolman: r.spoolman, executor: r.executor, log: silentLog, pendingId: pending.id, spoolId: 20 });
    await r.push({ printWeight: pw(printWeight.a1External) }); // late update -> re-snapshot
    assert.equal(r.notifier.sent.pending.length, 1); // not asked again
    await r.push({ status: 'running', progress: '10' });
    await r.push({ status: 'finish', progress: '100' });
    assert.deepEqual(r.usage(), [['External Spool', 20, 10.07, 'applied']]);
  });

  test('skipping a pending source deducts nothing', async () => {
    const r = rig({ printer: A1, spools: twoOpened(), filaments: [petgWhiteFil], initial: a1World });
    await r.start();
    await r.push({ status: 'prepare', progress: '0', startTime: T1, taskName: 'Test print', printWeight: pw(printWeight.a1External) });
    await r.push({ status: 'running', progress: '10' });
    await r.push({ status: 'finish', progress: '100' });
    const { pending } = r.notifier.sent.pending[0];
    await resolvePending({ store, spoolman: r.spoolman, executor: r.executor, log: silentLog, pendingId: pending.id, spoolId: null });
    assert.deepEqual(r.usage(), [['External Spool', null, 10.07, 'skipped']]);
    assert.equal(r.spoolman.writes('useWeight').length, 0);
  });

  test('force refresh is pressed at print start when the printer has the button', async () => {
    const r = rig({ printer: A1, spools: [spool({ id: 20, filament: petgWhiteFil, firstUsed: T1 })], filaments: [petgWhiteFil], initial: { ...a1World, 'button.a1_force_refresh_data': { state: 'x' } } });
    await r.start();
    await r.push({ status: 'prepare', progress: '0', startTime: T1, taskName: 'Test print', printWeight: pw(printWeight.a1External) });
    assert.deepEqual(r.tracker.ha.pressed, ['button.a1_force_refresh_data']);
    await r.push({ status: 'running', progress: '10' });
    await r.push({ status: 'finish', progress: '100' });
    assert.deepEqual(r.usage(), [['External Spool', 20, 10.07, 'applied']]);
  });
});

// Event order and timestamps replayed from the HA recorder for two real prints on 2026-10-13.
// Both printers keep the previous print's print_progress and print_weight through "prepare";
// the A1 even keeps progress 100 until "running" arrives 10 s later.
describe('replayed from HA history', () => {
  const OLD = '2026-10-13T20:40:00.000Z'; // before the bridge started
  const a1World = { 'sensor.a1_external_spool_external_spool': { state: 'Bambu PETG Basic', attributes: a1External } };
  const a1Rig = () =>
    rig({
      printer: A1,
      spools: [spool({ id: 20, filament: petgWhiteFil, remaining: 500, firstUsed: T1 })],
      filaments: [petgWhiteFil],
      initial: { ...a1World, status: 'finish', progress: '100', startTime: 'unknown', taskName: 'Old print', printWeight: pw({ 'External Spool': 0.11 }) },
      initialAt: OLD,
    });

  async function a1Start(r) {
    await r.start();
    await r.push({ taskName: 'Test print' }, '2026-10-13T21:10:57.826Z');
    await r.push({ status: 'prepare', startTime: '2026-10-13T21:10:00+00:00' }, '2026-10-13T21:10:59.844Z');
  }

  async function a1Running(r) {
    await r.push(
      { progress: '0', status: 'running', startTime: '2026-10-13T21:10:55+00:00', printWeight: pw({ 'External Spool': 0.1 }) },
      '2026-10-13T21:11:09.882Z',
    );
    for (const [p, at] of [['1', '21:11:50.273'], ['13', '21:13:07.485'], ['20', '21:15:03.731']]) await r.push({ progress: p }, `2026-10-13T${at}Z`);
  }

  test('A1: stale progress 100 at prepare is ignored and the snapshot waits for this print\'s print_weight', async () => {
    const r = a1Rig();
    await a1Start(r);
    const [job] = store.listJobs();
    assert.equal(job.adopted, 0);
    assert.equal(job.max_progress, 0); // not the previous print's 100
    assert.deepEqual(store.getJobSources(job.id), []); // 0.11 g is the previous print's

    await a1Running(r);
    assert.deepEqual(store.getJobSources(job.id).map((s) => [s.source_key, s.grams, s.spool_id]), [['External Spool', 0.1, 20]]);
    for (const [p, at] of [['76', '21:15:45.254'], ['96', '21:18:43.100']]) await r.push({ progress: p }, `2026-10-13T${at}Z`);
    await r.push({ progress: '100', status: 'finish' }, '2026-10-13T21:18:58.448Z');

    assert.deepEqual(r.usage(), [['External Spool', 20, 0.1, 'applied']]);
    assert.equal(store.getJob(job.id).max_progress, 100);
    assert.equal(r.spoolman.writes('patchSpool').filter((w) => w[2].location).length, 1); // resolved once, from fresh data
    assert.equal(r.notifier.sent.pending.length, 0);
  });

  test('A1: the same print failing at 20% deducts 20%, not the full amount', async () => {
    const r = a1Rig();
    await a1Start(r);
    await a1Running(r);
    await r.push({ status: 'failed' }, '2026-10-13T21:15:10.000Z');
    await r.push({ progress: '0' }, '2026-10-13T21:15:15.000Z');
    assert.deepEqual(r.usage(), [['External Spool', 20, 0.02, 'applied']]);
  });

  test('P2S: progress 0 comes with prepare, print_weight with running 2.6 s later', async () => {
    const r = rig({
      initial: { status: 'finish', progress: '100', startTime: '2026-10-13T11:49:08+00:00', taskName: 'Old print', printWeight: pw({ 'AMS 1 Tray 1': 10.9 }) },
      initialAt: OLD,
    });
    await r.start();
    await r.push({ taskName: 'Test print' }, '2026-10-13T21:12:15.020Z');
    await r.push({ progress: '0', status: 'prepare', startTime: '2026-10-13T21:12:00+00:00' }, '2026-10-13T21:12:15.568Z');
    const [job] = store.listJobs();
    assert.deepEqual(store.getJobSources(job.id), []); // 10.9 g is the previous print's
    await r.push({ status: 'running', startTime: '2026-10-13T21:12:13+00:00', printWeight: pw({ 'AMS 1 Tray 1': 0.04 }) }, '2026-10-13T21:12:18.143Z');
    for (const [p, at] of [['5', '21:16:28.914'], ['8', '21:16:31.225'], ['91', '21:18:14.930'], ['98', '21:18:40.980']]) {
      await r.push({ progress: p }, `2026-10-13T${at}Z`);
    }
    await r.push({ progress: '100', status: 'finish' }, '2026-10-13T21:22:11.062Z');
    assert.equal(store.getJob(job.id).adopted, 0);
    assert.deepEqual(r.usage(), [['AMS 1 Tray 1', 1, 0.04, 'applied']]);
  });

  test('a reprint with identical print_weight is snapshotted by the fallback after the wait', async () => {
    const r = rig({
      printer: A1,
      spools: [spool({ id: 20, filament: petgWhiteFil, firstUsed: T1 })],
      filaments: [petgWhiteFil],
      initial: { ...a1World, status: 'finish', progress: '100', startTime: 'unknown', taskName: 'Test print', printWeight: pw({ 'External Spool': 0.1 }) },
      initialAt: OLD,
      weightWaitMs: 20,
    });
    await r.start();
    await r.push({ status: 'prepare', startTime: '2026-10-13T22:00:00+00:00' }, '2026-10-13T22:00:05.000Z');
    const [job] = store.listJobs();
    assert.deepEqual(store.getJobSources(job.id), []);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await r.tracker.idle();
    assert.deepEqual(store.getJobSources(job.id).map((s) => [s.source_key, s.grams]), [['External Spool', 0.1]]);
  });

  test('a print cancelled during prepare ends with 0 g and never resolves the stale print_weight', async () => {
    const r = a1Rig();
    await a1Start(r);
    await r.push({ status: 'failed' }, '2026-10-13T21:11:02.000Z'); // cancelled during prepare
    const [job] = store.listJobs();
    assert.equal(job.state, 'failed');
    assert.equal(job.total_grams, 0);
    assert.deepEqual(store.getJobSources(job.id), []);
    assert.deepEqual(r.usage(), []);
    assert.deepEqual(r.spoolman.calls, []); // no location patch, no first_used, no auto-create
    assert.deepEqual(r.notifier.sent.problems, []);
  });

  test('a print that failed after progress but has no snapshot yet takes print_weight at the end', async () => {
    const r = a1Rig();
    await a1Start(r);
    // "running" without a print_weight update (identical reprint), fails before the 60 s fallback
    await r.push({ status: 'running', progress: '0' }, '2026-10-13T21:11:09.882Z');
    await r.push({ progress: '50' }, '2026-10-13T21:11:40.000Z');
    await r.push({ status: 'failed' }, '2026-10-13T21:11:45.000Z');
    assert.deepEqual(r.usage(), [['External Spool', 20, 0.06, 'applied']]); // 0.11 g x 50%, rounded
  });

  test('bridge restart between prepare and running waits for the new print_weight', async () => {
    const r = a1Rig();
    await a1Start(r);
    const [job] = store.listJobs();
    assert.equal(job.started_at, '2026-10-13T21:10:59.844Z');
    // A new tracker (bridge restart) sees the open job while print_weight is still stale.
    const { ids } = resolveEntities(A1, r.world.get());
    const restarted = new PrinterTracker({
      printer: A1, ids, store, executor: r.executor, notifier: r.notifier, ha: r.tracker.ha,
      config: { dryRun: false, jobStartToleranceSec: 120, nearestColorMaxDeltaE: 20 },
      log: silentLog, sleep: async () => {}, debounceMs: 0, weightWaitMs: 60_000,
    });
    restarted.startup(r.world.get());
    await restarted.idle();
    assert.deepEqual(store.getJobSources(job.id), []); // did not snapshot the previous print's 0.11 g
    restarted.onEntities(r.world.update({ progress: '0', status: 'running', printWeight: pw({ 'External Spool': 0.1 }) }, '2026-10-13T21:11:09.882Z'));
    await restarted.idle();
    assert.deepEqual(store.getJobSources(job.id).map((s) => s.grams), [0.1]);
    restarted.stop();
  });

  test('bridge startup: progress older than start_time belongs to the previous print and is not trusted', async () => {
    const r = a1Rig();
    // Bridge (re)starts during the print: progress still carries the old print's timestamp.
    r.world.update({ status: 'running', startTime: '2026-10-13T21:10:55+00:00', printWeight: pw({ 'External Spool': 0.1 }) }, '2026-10-13T21:11:09.882Z');
    await r.start();
    const [job] = store.listJobs();
    assert.equal(job.adopted, 1);
    assert.equal(job.max_progress, 0);
    assert.deepEqual(store.getJobSources(job.id).map((s) => s.grams), [0.1]);
  });
});
