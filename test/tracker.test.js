import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createColorTable } from '../src/bambu/colors.js';
import { createExecutor } from '../src/executor.js';
import { resolveEntities } from '../src/ha/entities.js';
import { identityFromTray } from '../src/sources.js';
import { readExtra } from '../src/spoolman/extra.js';
import { openStore } from '../src/store.js';
import { PrinterTracker, resolvePending } from '../src/tracker.js';
import { createFakeSpoolman, createRecordingNotifier, createWorld, silentLog } from './fixtures/fakes.js';
import { a1External, activeTray, catalog, colorCodes, printWeight, tray } from './fixtures/ha.js';
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

function rig({
  printer = P2S,
  spools = p2sSpools(),
  filaments = [goldFilament, blackFil, matteRedFil],
  dryRun = false,
  initial = {},
  initialAt,
  weightWaitMs = 60_000,
  colorTable = null,
  insertSettleMs = 5,
  insertMaxWaitMs = 1000,
  history = async () => {
    throw new Error('no recorder in this test');
  },
} = {}) {
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
  const infos = [];
  const log = { ...silentLog, warn: (m) => warnings.push(m), info: (m) => infos.push(m) };
  const ha = { pressed: [], historyCalls: [], pressButton: async (id) => ha.pressed.push(id) };
  ha.history = async (ids, since) => {
    ha.historyCalls.push({ ids, since });
    return history(ids, since);
  };
  const config = { dryRun, jobStartToleranceSec: 120, nearestColorMaxDeltaE: 20 };
  const tracker = new PrinterTracker({ printer, ids, store, executor, notifier, ha, config, log, sleep: async () => {}, debounceMs: 0, weightWaitMs,
    colorTable: () => colorTable, insertSettleMs, insertMaxWaitMs });
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
  return { spoolman, notifier, executor, world, tracker, push, start, spoolById, usage, warnings, infos };
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

  test('failed print without current_stage deducts grams x max progress (real failure at 63%)', async () => {
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

// print_progress is gcode progress: the start sequence counts too. Replayed from the HA recorder.
describe('failed prints and current_stage', () => {
  const at = (day, time) => `2026-10-${day}T${time}Z`;
  const replay = async (r, day, steps) => {
    for (const [time, changes] of steps) await r.push(changes, at(day, time));
  };

  // P2S, 2026-10-12: failed at 63%, but the stage reached "printing" only at 60%.
  const p2s63 = [
    ['22:43:52.840', { progress: '0', status: 'prepare', startTime: '2026-10-12T22:43:00+00:00' }],
    ['22:43:55.405', { status: 'running', startTime: '2026-10-12T22:43:49+00:00', printWeight: pw(printWeight.failedAt63) }],
    ['22:44:02.671', { stage: 'cooling_chamber' }],
    ['22:44:05.898', { stage: 'homing_toolhead' }],
    ['22:45:07.396', { stage: 'identifying_build_plate_type' }],
    ['22:45:13.374', { stage: 'changing_filament' }],
    ['22:46:37.377', { stage: 'calibrating_extrusion' }],
    ['22:46:54.496', { stage: 'cleaning_nozzle_tip' }],
    ['22:48:03.358', { progress: '3' }],
    ['22:48:05.797', { stage: 'sweeping_xy_mech_mode', progress: '5' }],
    ['22:48:10.399', { stage: 'waiting_for_heatbed_temperature' }],
    ['22:49:17.301', { stage: 'print_calibration_lines' }],
    ['22:49:38.902', { stage: 'printing', progress: '60' }],
    ['22:49:42.325', { progress: '61' }],
    ['22:49:51.413', { progress: '62' }],
    ['22:49:57.018', { progress: '63' }],
    ['22:50:02.835', { stage: 'idle', status: 'failed' }],
    ['22:50:07.813', { progress: '0' }],
  ];
  const p2sBefore = {
    status: 'finish',
    progress: '100',
    stage: 'idle',
    startTime: '2026-10-12T22:18:59+00:00',
    taskName: 'Old print',
    printWeight: pw(printWeight.fourColor),
  };

  // The same window as HA's websocket history returns it (progress 60 stamped 47 microseconds later).
  const p2sHistory = (ids) => ({
    [ids[0]]: [
      { state: 'print_calibration_lines', time: Date.parse('2026-10-12T22:49:17.301Z') },
      { state: 'printing', time: 1791845378.902699 * 1000 },
    ],
    [ids[1]]: [
      { state: '5', time: Date.parse('2026-10-12T22:48:05.797Z') },
      { state: '60', time: 1791845378.902746 * 1000 },
      { state: '61', time: Date.parse('2026-10-12T22:49:42.325Z') },
    ],
  });

  test('A1 job 5: cancelled at 66% during bed leveling, never printed a layer -> 0 g', async () => {
    const r = rig({
      printer: A1,
      spools: [spool({ id: 20, filament: petgWhiteFil, remaining: 500, firstUsed: T1 })],
      filaments: [petgWhiteFil],
      initial: {
        'sensor.a1_external_spool_external_spool': { state: 'Bambu PETG Basic', attributes: a1External },
        status: 'finish',
        progress: '100',
        stage: 'idle',
        startTime: '2026-10-13T22:08:55+00:00',
        taskName: 'Old print',
        printWeight: pw({ 'External Spool': 0.1 }),
      },
      initialAt: '2026-10-14T07:00:00.000Z',
    });
    await r.start();
    await replay(r, '14', [
      ['08:16:44.915', { status: 'prepare', startTime: '2026-10-14T08:16:00+00:00' }],
      [
        '08:16:54.290',
        { stage: 'heatbed_preheating', progress: '0', status: 'running', startTime: '2026-10-14T08:16:41+00:00', printWeight: pw({ 'External Spool': 0.98 }) },
      ],
      ['08:17:25.963', { stage: 'homing_toolhead' }],
      ['08:17:34.168', { stage: 'filament_loading', progress: '1' }],
      ['08:18:54.256', { progress: '11' }],
      ['08:18:56.315', { progress: '12' }],
      ['08:19:04.576', { stage: 'calibrating_extrusion' }],
      ['08:20:06.668', { progress: '16' }],
      ['08:20:52.268', { stage: 'sweeping_xy_mech_mode' }],
      ['08:21:17.185', { progress: '17' }],
      ['08:21:27.559', { stage: 'cleaning_nozzle_tip' }],
      ['08:21:31.689', { progress: '64' }],
      ['08:21:54.284', { progress: '65' }],
      ['08:22:00.444', { progress: '66' }],
      ['08:22:23.010', { stage: 'auto_bed_leveling' }],
      ['08:22:47.169', { status: 'failed' }],
      ['08:22:52.230', { stage: 'idle', progress: '0' }],
    ]);
    const [job] = store.listJobs();
    assert.deepEqual([job.state, job.total_grams, job.max_progress, job.stage_tracked, job.print_baseline], ['failed', 0, 66, 1, null]);
    assert.deepEqual(r.usage(), []);
    assert.equal(r.spoolman.writes('useWeight').length, 0);
  });

  test('failed with progress but never printing, before any snapshot: no snapshot, no Spoolman calls', async () => {
    // As job 5, but print_weight never changes (identical reprint), so the 60 s wait is still open.
    const r = rig({
      printer: A1,
      spools: [spool({ id: 20, filament: petgWhiteFil, remaining: 500 })],
      filaments: [petgWhiteFil],
      initial: {
        'sensor.a1_external_spool_external_spool': { state: 'Bambu PETG Basic', attributes: a1External },
        status: 'finish',
        progress: '100',
        stage: 'idle',
        startTime: '2026-10-13T22:08:55+00:00',
        taskName: 'Old print',
        printWeight: pw({ 'External Spool': 0.98 }),
      },
      initialAt: '2026-10-14T07:00:00.000Z',
    });
    await r.start();
    await replay(r, '14', [
      ['08:16:44.915', { status: 'prepare', startTime: '2026-10-14T08:16:00+00:00' }],
      ['08:16:54.290', { stage: 'heatbed_preheating', progress: '0', status: 'running' }],
      ['08:21:31.689', { stage: 'cleaning_nozzle_tip', progress: '64' }],
      ['08:22:47.169', { status: 'failed' }],
    ]);
    const [job] = store.listJobs();
    assert.deepEqual([job.state, job.total_grams, job.max_progress], ['failed', 0, 64]);
    assert.deepEqual(store.getJobSources(job.id), []);
    assert.deepEqual(r.spoolman.calls, []); // no location patch or first_used from stale data
  });

  test('P2S 63% failure: baseline 60 from the "printing" update -> 3/40 of the grams', async () => {
    const r = rig({ initial: p2sBefore, initialAt: '2026-10-12T22:30:00.000Z' });
    await r.start();
    await replay(r, '12', p2s63);
    const [job] = store.listJobs();
    assert.deepEqual([job.stage_tracked, job.print_baseline, job.max_progress], [1, 60, 63]);
    assert.deepEqual(r.usage(), [['AMS 1 Tray 2', 2, 0.04, 'applied']]); // 0.56 g x 3/40
  });

  test('returning to printing after a pause or offline keeps the first baseline', async () => {
    const r = rig({ initial: p2sBefore, initialAt: '2026-10-12T22:30:00.000Z' });
    await r.start();
    await replay(r, '12', [
      ['22:43:52.840', { progress: '0', status: 'prepare', startTime: '2026-10-12T22:43:00+00:00' }],
      ['22:43:55.405', { status: 'running', startTime: '2026-10-12T22:43:49+00:00', printWeight: pw(printWeight.failedAt63) }],
      ['22:49:38.902', { stage: 'printing', progress: '40' }],
      ['22:52:00.000', { stage: 'paused_user', status: 'pause', progress: '55' }],
      ['22:55:00.000', { stage: 'printing', status: 'running' }],
      ['22:56:00.000', { progress: '70' }],
      ['22:57:00.000', { status: 'offline', stage: 'offline' }],
      ['22:57:30.000', { status: 'running', stage: 'printing', progress: '80' }],
      ['22:58:00.000', { status: 'failed', stage: 'idle' }],
    ]);
    assert.equal(store.listJobs()[0].print_baseline, 40);
    assert.deepEqual(r.usage(), [['AMS 1 Tray 2', 2, 0.37, 'applied']]); // 0.56 g x 40/60
  });

  test('a fresh job whose stage already says "printing" has an unknown baseline: plain progress', async () => {
    const r = rig({ initial: p2sBefore });
    await r.start();
    await r.push({ status: 'prepare', progress: '0', stage: 'printing', startTime: T1, printWeight: pw(printWeight.failedAt63) });
    assert.equal(store.listJobs()[0].stage_tracked, 0);
  });

  const adoptedMidPrint = {
    status: 'running',
    stage: 'printing',
    progress: '61',
    startTime: '2026-10-12T22:43:49+00:00',
    taskName: 'Test print',
    printWeight: pw(printWeight.failedAt63),
  };

  test('bridge starts mid-print: the baseline is rebuilt from HA history', async () => {
    const r = rig({ initial: adoptedMidPrint, initialAt: '2026-10-12T22:49:42.325Z', history: p2sHistory });
    await r.start();
    const [job] = store.listJobs();
    assert.deepEqual([job.adopted, job.stage_tracked, job.print_baseline, job.max_progress], [1, 1, 60, 61]);
    assert.deepEqual(r.tracker.ha.historyCalls[0].ids, ['sensor.p2s_current_stage', 'sensor.p2s_print_progress']);
    assert.ok(r.tracker.ha.historyCalls[0].since <= Date.parse('2026-10-12T22:43:49+00:00'));
    await r.push({ progress: '63' }, '2026-10-12T22:49:57.018Z');
    await r.push({ status: 'failed', stage: 'idle' }, '2026-10-12T22:50:02.835Z');
    assert.deepEqual(r.usage(), [['AMS 1 Tray 2', 2, 0.04, 'applied']]);
  });

  test('bridge starts mid-print and HA history fails: plain progress, as before', async () => {
    const r = rig({ initial: adoptedMidPrint, initialAt: '2026-10-12T22:49:42.325Z' }); // history throws
    await r.start();
    assert.equal(store.listJobs()[0].stage_tracked, 0);
    await r.push({ progress: '63' }, '2026-10-12T22:49:57.018Z');
    await r.push({ status: 'failed', stage: 'idle' }, '2026-10-12T22:50:02.835Z');
    assert.deepEqual(r.usage(), [['AMS 1 Tray 2', 2, 0.35, 'applied']]);
  });

  test('bridge starts before printing began: tracked, and the live "printing" sets the baseline', async () => {
    const r = rig({
      initial: { ...adoptedMidPrint, stage: 'cleaning_nozzle_tip', progress: '3' },
      initialAt: '2026-10-12T22:48:03.358Z',
      history: (ids) => ({ [ids[0]]: [{ state: 'cleaning_nozzle_tip', time: Date.parse('2026-10-12T22:46:54.496Z') }], [ids[1]]: [] }),
    });
    await r.start();
    assert.deepEqual([store.listJobs()[0].stage_tracked, store.listJobs()[0].print_baseline], [1, null]);
    await r.push({ stage: 'printing', progress: '60' }, '2026-10-12T22:49:38.902Z');
    assert.equal(store.listJobs()[0].print_baseline, 60);
  });

  test('bridge restart with an open tracked job: a "printing" missed while down comes from history', async () => {
    const r = rig({ initial: adoptedMidPrint, initialAt: '2026-10-12T22:49:42.325Z', history: p2sHistory });
    const jobId = store.createJob({ printer: 'p2s', taskName: 'Test print', startTime: '2026-10-12T22:43:49+00:00', stageTracked: true, dryRun: false });
    store.replaceJobSources(jobId, [{ sourceKey: 'AMS 1 Tray 2', grams: 0.56, kind: 'ams', unit: 1, slot: 2, spoolId: 2, resolution: 'tag' }]);
    await r.start();
    assert.equal(store.getJob(jobId).print_baseline, 60);
    await r.push({ progress: '63' }, '2026-10-12T22:49:57.018Z');
    await r.push({ status: 'failed', stage: 'idle' }, '2026-10-12T22:50:02.835Z');
    assert.deepEqual(r.usage(), [['AMS 1 Tray 2', 2, 0.04, 'applied']]);
  });
});

// An RFID spool put into an AMS slot outside a print is paired right away. No deduction.
describe('pair on insert', () => {
  const table = createColorTable(colorCodes);
  const NEW_UUID = 'C0FFEE00C0FFEE00C0FFEE00C0FFEE00';
  const emptyTray = (n) => ({
    state: 'Empty',
    attributes: { ...tray(n), tray_uuid: '00000000000000000000000000000000', tag_uid: '0000000000000000', remain: -1, empty: true, type: '', filament_id: '' },
  });
  // Tray 3 attributes (PLA Matte Dark Red) for a freshly inserted spool.
  const inserted = (remain, uuid = NEW_UUID) => ({ state: 'Bambu PLA Matte', attributes: { ...tray(3), tray_uuid: uuid, remain } });
  // Matte Dark Red imported via intake: hex from elsewhere, the right colour code.
  const intakeFil = { ...filament({ id: 40, name: 'Matte Dark Red', colorHex: 'B83C42', bambuId: 'GFA01' }), extra: { bambu_filament_id: '"GFA01"', bambu_color_code: '"11202"' } };

  function insertRig({ weighed = false, dryRun = false, initial = {} } = {}) {
    const blackTagged = spool({ id: 2, filament: blackFil, remaining: 600, firstUsed: T1, rfid: uuid(2), tags: [uuid(2)], location: 'P2S AMS1 Slot 2' });
    const r = rig({
      spools: [goldSpool, blackTagged, spool({ id: 41, filament: intakeFil, remaining: 1000, location: 'Shelf' })],
      filaments: [goldFilament, blackFil, intakeFil],
      colorTable: table,
      dryRun,
      initial: { 'sensor.p2s_ams_1_tray_3': emptyTray(3), ...initial },
    });
    store.beginIntakeBatch('order-1', 'hash');
    store.recordIntakeSpool({ batchId: 'order-1', itemIndex: 0, unitIndex: 0, spoolId: 41, weighed });
    return r;
  }

  test('an intake spool is paired by colour code, gets the AMS estimate and its slot', async () => {
    const r = insertRig();
    await r.start();
    r.tracker.onEntities(r.world.update({ 'sensor.p2s_ams_1_tray_3': inserted(-1) })); // the tag is read first ...
    await r.push({ 'sensor.p2s_ams_1_tray_3': inserted(77) }); // ... the estimate ~10 s later
    const s = r.spoolById(41);
    assert.equal(readExtra(s, 'rfid_uuid'), NEW_UUID);
    assert.deepEqual(s.tags.map((t) => t.uid), [NEW_UUID]);
    assert.equal(s.remaining_weight, 770);
    assert.equal(s.location, 'P2S AMS1 Slot 3');
    assert.ok(s.first_used);
    assert.equal(store.estimatedSpoolIds().has(41), false); // corrected once, never again
    assert.equal(store.listJobs().length, 0);
    assert.equal(r.spoolman.writes('useWeight').length, 0);
    const line = r.infos.find((m) => m.startsWith('insert '));
    assert.equal(
      line,
      `insert AMS 1 Tray 3: tray_uuid ${NEW_UUID}, remain 77% -> spool #41 (same colour code), remaining 1000 -> 770 g (AMS 77%), location P2S AMS1 Slot 3`,
    );
  });

  test('pairing waits until the AMS reports remain', async () => {
    const r = insertRig();
    await r.start();
    r.tracker.onEntities(r.world.update({ 'sensor.p2s_ams_1_tray_3': inserted(-1) }));
    await new Promise((resolve) => setTimeout(resolve, 40)); // several quiet periods
    assert.deepEqual(r.spoolman.calls, []);
    await r.push({ 'sensor.p2s_ams_1_tray_3': inserted(77) });
    assert.equal(r.spoolById(41).remaining_weight, 770);
  });

  test('a weighed intake spool is paired but keeps its weight', async () => {
    const r = insertRig({ weighed: true });
    await r.start();
    await r.push({ 'sensor.p2s_ams_1_tray_3': inserted(77) });
    assert.equal(readExtra(r.spoolById(41), 'rfid_uuid'), NEW_UUID);
    assert.equal(r.spoolById(41).remaining_weight, 1000);
  });

  test('an already tagged spool moved to another slot only gets the new location', async () => {
    const r = insertRig({ initial: { 'sensor.p2s_ams_1_tray_4': emptyTray(4) } });
    await r.start();
    await r.push({ 'sensor.p2s_ams_1_tray_2': emptyTray(2) });
    await r.push({ 'sensor.p2s_ams_1_tray_4': { state: 'Bambu PLA Basic', attributes: { ...tray(2) } } });
    assert.deepEqual(r.spoolman.calls, [['patchSpool', 2, { location: 'P2S AMS1 Slot 4' }, null]]);
    assert.match(r.infos.find((m) => m.startsWith('insert ')), /-> spool #2 \(already tagged\), location P2S AMS1 Slot 4$/);
  });

  test('during a print, an insert into an unused slot is paired without touching the job', async () => {
    const r = insertRig();
    await r.start();
    await r.push({ status: 'prepare', progress: '0', startTime: T1, taskName: 'Test print', printWeight: pw(printWeight.failedAt63) });
    await r.push({ status: 'running', progress: '10' });
    await r.push({ 'sensor.p2s_ams_1_tray_3': inserted(77) });
    assert.equal(readExtra(r.spoolById(41), 'rfid_uuid'), NEW_UUID);
    const [job] = store.listJobs();
    assert.deepEqual(store.getJobSources(job.id).map((s) => s.source_key), ['AMS 1 Tray 2']);
    await r.push({ status: 'finish', progress: '100' });
    assert.deepEqual(r.usage(), [['AMS 1 Tray 2', 2, 0.56, 'applied']]);
    assert.equal(r.spoolById(41).remaining_weight, 770); // nothing deducted from the inserted spool
  });

  test('a swap into a slot the running print uses is left to the print', async () => {
    const r = insertRig();
    await r.start();
    await r.push({ status: 'prepare', progress: '0', startTime: T1, taskName: 'Test print', printWeight: pw({ 'AMS 1 Tray 3': 5 }) });
    const callsBefore = r.spoolman.calls.length;
    await r.push({ 'sensor.p2s_ams_1_tray_3': inserted(77) });
    assert.equal(r.spoolman.calls.length, callsBefore);
    assert.match(r.infos.find((m) => m.startsWith('insert ')), /is part of job \d+; the print's own pairing applies/);
  });

  test('DRY_RUN: the insert is only logged', async () => {
    const r = insertRig({ dryRun: true });
    const before = structuredClone(r.spoolman.db.spools);
    await r.start();
    await r.push({ 'sensor.p2s_ams_1_tray_3': inserted(77) });
    assert.deepEqual(r.spoolman.db.spools, before);
    assert.ok(r.spoolman.writes('linkTag').length > 0); // the would-be writes are logged
    assert.equal(store.estimatedSpoolIds().has(41), true); // not marked: nothing was written
    assert.match(r.infos.find((m) => m.includes('insert ')), /^\[DRY RUN\] insert AMS 1 Tray 3: .* -> spool #41 \(same colour code\), remaining 1000 -> 770 g/);
  });

  test('an unknown spool is auto-created on insert', async () => {
    const r = insertRig();
    r.spoolman.db.spools = r.spoolman.db.spools.filter((s) => s.id !== 41);
    await r.start();
    await r.push({ 'sensor.p2s_ams_1_tray_3': inserted(77) });
    const created = r.spoolman.db.spools.find((s) => readExtra(s, 'rfid_uuid') === NEW_UUID);
    assert.equal(created.filament.id, 40); // the imported filament, found by colour code: no duplicate
    assert.match(r.infos.find((m) => m.startsWith('insert ')), /-> new spool #\d+ auto-created from RFID/);
  });
});

describe('questions at insert time', () => {
  const table = createColorTable(colorCodes);
  const NEW_UUID = 'BEEF0000BEEF0000BEEF0000BEEF0000';
  const emptyTray = { state: 'Empty', attributes: { ...tray(3), tray_uuid: '00000000000000000000000000000000', tag_uid: '0000000000000000', remain: -1, empty: true, type: '', filament_id: '' } };
  const inserted = { state: 'Bambu PLA Matte', attributes: { ...tray(3), tray_uuid: NEW_UUID, remain: 77 } };
  const fil = { ...filament({ id: 40, name: 'Matte Dark Red', colorHex: 'B83C42', bambuId: 'GFA01' }), extra: { bambu_filament_id: '"GFA01"', bambu_color_code: '"11202"' } };

  // Two opened spools of the same colour (and one unopened intake spool): the bridge must ask.
  function questionRig({ dryRun = false } = {}) {
    const r = rig({
      spools: [
        goldSpool,
        spool({ id: 2, filament: blackFil, remaining: 600, firstUsed: T1, rfid: uuid(2), tags: [uuid(2)], location: 'P2S AMS1 Slot 2' }),
        spool({ id: 41, filament: fil, remaining: 1000 }),
        spool({ id: 42, filament: fil, remaining: 500, firstUsed: T1 }),
        spool({ id: 43, filament: fil, remaining: 300, firstUsed: T1 }),
      ],
      filaments: [goldFilament, blackFil, fil],
      colorTable: table,
      dryRun,
      initial: { 'sensor.p2s_ams_1_tray_3': emptyTray },
    });
    store.beginIntakeBatch('order-1', 'hash');
    store.recordIntakeSpool({ batchId: 'order-1', itemIndex: 0, unitIndex: 0, spoolId: 41, weighed: false });
    return r;
  }
  const answer = (r, pendingId, spoolId) => resolvePending({ store, spoolman: r.spoolman, executor: r.executor, log: silentLog, pendingId, spoolId });

  test('an ambiguous insert is asked about right away, once per tray_uuid', async () => {
    const r = questionRig();
    await r.start();
    await r.push({ 'sensor.p2s_ams_1_tray_3': inserted });
    assert.equal(r.notifier.sent.pending.length, 1);
    const sent = r.notifier.sent.pending[0];
    assert.equal(sent.inserted, true);
    assert.deepEqual(sent.pending.candidates.map((c) => c.spoolId), [42, 43]);
    assert.match(r.infos.find((m) => m.startsWith('insert ')), /not paired: ambiguous_pairing \(candidates #42, #43\); asked \(pending \d+\)$/);

    // taken out and put back: not asked again
    await r.push({ 'sensor.p2s_ams_1_tray_3': emptyTray });
    await r.push({ 'sensor.p2s_ams_1_tray_3': { ...inserted, attributes: { ...inserted.attributes, remain: 76 } } });
    assert.equal(r.notifier.sent.pending.length, 1);
    assert.match(r.infos.filter((m) => m.startsWith('insert ')).at(-1), /already asked about this tray_uuid/);
  });

  test('answering it pairs the tray with the chosen spool, with the intake estimate, and no deduction', async () => {
    const r = questionRig();
    await r.start();
    await r.push({ 'sensor.p2s_ams_1_tray_3': inserted });
    const { pending } = r.notifier.sent.pending[0];
    const result = await answer(r, pending.id, 41); // the unopened intake spool, not one of the buttons
    assert.equal(result.ok, true);
    assert.match(result.message, /Spool #41 paired with AMS 1 Tray 3; remaining set to 770 g/);
    const s = r.spoolById(41);
    assert.deepEqual([readExtra(s, 'rfid_uuid'), s.tags.map((t) => t.uid), s.remaining_weight, s.location], [NEW_UUID, [NEW_UUID], 770, 'P2S AMS1 Slot 3']);
    assert.equal(store.getInsertPending(NEW_UUID).state, 'resolved');
    assert.equal(r.spoolman.writes('useWeight').length, 0);
  });

  test('a print using the spool while the insert question is open is not asked again; one answer covers both', async () => {
    const r = questionRig();
    await r.start();
    await r.push({ 'sensor.p2s_ams_1_tray_3': inserted });
    await r.push({ status: 'prepare', progress: '0', startTime: T1, taskName: 'Test print', printWeight: pw({ 'AMS 1 Tray 3': 5 }) });
    assert.equal(r.notifier.sent.pending.length, 1); // still only the insert question
    const [job] = store.listJobs();
    const printQuestion = store.getPendingFor(job.id, 'AMS 1 Tray 3');
    assert.deepEqual([printQuestion.kind, printQuestion.tray_uuid, printQuestion.state], ['print', NEW_UUID, 'open']);

    await answer(r, r.notifier.sent.pending[0].pending.id, 42);
    assert.equal(store.getPendingFor(job.id, 'AMS 1 Tray 3').state, 'resolved');
    await r.push({ status: 'running', progress: '10' });
    await r.push({ status: 'finish', progress: '100' });
    assert.deepEqual(r.usage(), [['AMS 1 Tray 3', 42, 5, 'applied']]);
  });

  test('answering the print question also closes the open insert question', async () => {
    const r = questionRig();
    await r.start();
    await r.push({ 'sensor.p2s_ams_1_tray_3': inserted });
    await r.push({ status: 'prepare', progress: '0', startTime: T1, taskName: 'Test print', printWeight: pw({ 'AMS 1 Tray 3': 5 }) });
    const [job] = store.listJobs();
    await answer(r, store.getPendingFor(job.id, 'AMS 1 Tray 3').id, 43);
    assert.deepEqual([store.getInsertPending(NEW_UUID).state, store.getInsertPending(NEW_UUID).chosen_spool_id], ['resolved', 43]);
  });

  test('DRY_RUN: the question is still sent (the notifier adds [DRY RUN])', async () => {
    const r = questionRig({ dryRun: true });
    await r.start();
    await r.push({ 'sensor.p2s_ams_1_tray_3': inserted });
    assert.equal(r.notifier.sent.pending.length, 1);
  });
});

describe('answers by filament and remembered external-spool answers', () => {
  // A1 reports Generic PETG black (GFG99 #000000); Spoolman has Acme PETG "Black" with a slightly
  // different hex under another id, and an Acme PETG Grey: nothing matches exactly or uniquely.
  const acmeBlack = { ...filament({ id: 70, name: 'Black', material: 'PETG', colorHex: '1C1C1C', bambuId: 'GFG98' }), vendor: { id: 7, name: 'Acme' } };
  const acmeGrey = { ...filament({ id: 71, name: 'Grey', material: 'PETG', colorHex: '7F7F7F', bambuId: 'GFG98' }), vendor: { id: 7, name: 'Acme' } };
  const genericPetgBlack = { ...a1External, filament_id: 'GFG99', name: 'Generic PETG', type: 'PETG', color: '#000000FF', cols: [] };
  const world = { 'sensor.a1_external_spool_external_spool': { state: 'Generic PETG', attributes: genericPetgBlack } };
  const a1Rig = (spools) => rig({ printer: A1, spools, filaments: [acmeBlack, acmeGrey], initial: world });
  const answer = (r, pendingId, given) => resolvePending({ store, spoolman: r.spoolman, executor: r.executor, log: silentLog, pendingId, ...given });
  const print = async (r, startTime) => {
    await r.push({ status: 'prepare', progress: '0', startTime, taskName: 'Test print', printWeight: pw({ 'External Spool': 4 }) });
    await r.push({ status: 'running', progress: '10' });
  };

  test('choosing a filament: its one opened spool is used, and the answer is remembered', async () => {
    const r = a1Rig([spool({ id: 72, filament: acmeBlack, firstUsed: T1 }), spool({ id: 73, filament: acmeBlack }), spool({ id: 74, filament: acmeGrey, firstUsed: T1 })]);
    await r.start();
    await print(r, T1);
    const { pending } = r.notifier.sent.pending[0];
    const result = await answer(r, pending.id, { filamentId: 70 });
    assert.equal(result.ok, true);
    assert.equal(store.getPending(pending.id).chosen_spool_id, 72);
    assert.deepEqual(store.listAliases().map((a) => [a.reported_filament_id, a.reported_color_hex, a.filament_id]), [['GFG99', '000000', 70]]);
    await r.push({ status: 'finish', progress: '100' });
    assert.deepEqual(r.usage(), [['External Spool', 72, 4, 'applied']]);

    // next print with the same printer selection: no question, the alias resolves it
    await print(r, '2026-10-12T23:30:00+00:00');
    assert.equal(r.notifier.sent.pending.length, 1);
    const job = store.listJobs()[0];
    assert.deepEqual(store.getJobSources(job.id).map((s) => [s.spool_id, s.resolution]), [[72, 'alias']]);
  });

  test('choosing a filament without an opened spool opens the oldest one (FIFO)', async () => {
    const r = a1Rig([spool({ id: 76, filament: acmeBlack }), spool({ id: 75, filament: acmeBlack }), spool({ id: 74, filament: acmeGrey, firstUsed: T1 })]);
    await r.start();
    await print(r, T1);
    await answer(r, r.notifier.sent.pending[0].pending.id, { filamentId: 70 });
    assert.ok(r.spoolById(75).first_used);
    assert.equal(r.spoolById(76).first_used, null);
  });

  test('a filament with several opened spools asks for the spool; nothing is decided yet', async () => {
    const r = a1Rig([spool({ id: 72, filament: acmeBlack, firstUsed: T1 }), spool({ id: 73, filament: acmeBlack, firstUsed: T1 })]);
    await r.start();
    await print(r, T1);
    const { pending } = r.notifier.sent.pending[0];
    const result = await answer(r, pending.id, { filamentId: 70 });
    assert.deepEqual([result.ok, result.chooseSpool], [false, [72, 73]]);
    assert.equal(store.getPending(pending.id).state, 'open');
    assert.deepEqual(store.listAliases(), []);
    await answer(r, pending.id, { spoolId: 73 }); // step 2
    assert.equal(store.listAliases()[0].filament_id, 70);
  });

  test('answering with a spool (notification button) also remembers; a new answer replaces it', async () => {
    const r = a1Rig([spool({ id: 72, filament: acmeBlack, firstUsed: T1 }), spool({ id: 74, filament: acmeGrey, firstUsed: T1 })]);
    await r.start();
    await print(r, T1);
    await answer(r, r.notifier.sent.pending[0].pending.id, { spoolId: 74 });
    assert.equal(store.aliasMap().get('GFG99|000000'), 71);
    await r.push({ status: 'finish', progress: '100' });

    // the user removes the alias (as on the page) and answers differently next time
    store.deleteAlias('GFG99', '000000');
    await print(r, '2026-10-12T23:30:00+00:00');
    await answer(r, r.notifier.sent.pending.at(-1).pending.id, { spoolId: 72 });
    assert.deepEqual(store.listAliases().map((a) => a.filament_id), [70]);
    store.setAlias({ reportedFilamentId: 'GFG99', reportedColorHex: '000000', filamentId: 71 }); // replace
    assert.deepEqual(store.listAliases().map((a) => a.filament_id), [71]);
  });

  test('RFID answers never create aliases', async () => {
    const r = rig({ printer: P2S }); // 63% fixture inventory
    await r.start();
    const { pending } = store.addInsertPending({
      printer: 'p2s', sourceKey: 'AMS 1 Tray 3', trayUuid: uuid(3), reason: 'ambiguous_pairing', candidates: [],
      context: { identity: identityFromTray(tray(3)), location: 'P2S AMS1 Slot 3' },
    });
    await answer(r, pending.id, { spoolId: 3 });
    assert.deepEqual(store.listAliases(), []);

    // a print question about an RFID tray: the tag pairs it, no alias either
    const jobId = store.createJob({ printer: 'p2s', taskName: 'Test print', dryRun: false });
    store.replaceJobSources(jobId, [
      { sourceKey: 'AMS 1 Tray 2', grams: 1, kind: 'ams', unit: 1, slot: 2, trayUuid: uuid(2), filamentId: 'GFA00', colorHex: '000000', location: 'P2S AMS1 Slot 2' },
    ]);
    const printQuestion = store.upsertPending({ jobId, sourceKey: 'AMS 1 Tray 2', reason: 'ambiguous_pairing', candidates: [], printer: 'p2s', trayUuid: uuid(2) });
    await answer(r, printQuestion.id, { spoolId: 2 });
    assert.equal(store.getPending(printQuestion.id).state, 'resolved');
    assert.deepEqual(store.listAliases(), []);
  });
});
