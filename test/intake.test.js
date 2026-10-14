import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createColorTable } from '../src/bambu/colors.js';
import { contentHash, createIntake, IntakeError, unitMarker } from '../src/intake.js';
import { readExtra } from '../src/spoolman/extra.js';
import { openStore } from '../src/store.js';
import { createFakeSpoolman, silentLog } from './fixtures/fakes.js';
import { catalog, colorCodes } from './fixtures/ha.js';
import { goldFilament, goldSpool } from './fixtures/spoolman.js';

const NOW = '2026-10-14T12:00:00.000Z';
let store;
beforeEach(() => {
  store = openStore(':memory:');
});
afterEach(() => store.close());

function setup({ tableAvailable = true, config = { tareSpoolG: 250, tareRefillG: 210 } } = {}) {
  const spoolman = createFakeSpoolman({ spools: [goldSpool], filaments: [goldFilament], catalog });
  const table = tableAvailable ? createColorTable(colorCodes) : null;
  const intake = createIntake({ spoolman, store, colorTable: () => table, config, log: silentLog, now: () => NOW });
  return { spoolman, intake };
}

const gold = (extra = {}) => ({ product_line: 'PLA Basic', color_name: 'Gold', bambu_color_code: '10401', form: 'spool', count: 2, ...extra });
const matteRed = (extra = {}) => ({ product_line: 'PLA Matte', color_name: 'Dark Red', bambu_color_code: '11202', form: 'refill', count: 1, ...extra });
const rejects = async (promise, status, pattern) => {
  await assert.rejects(promise, (e) => e instanceof IntakeError && e.status === status && (!pattern || pattern.test(e.message)));
};

test('plan: a colour code already in Spoolman reuses that filament; tare by form', async () => {
  const { intake, spoolman } = setup();
  const plan = await intake.plan({ batch_id: 'order-1', items: [gold({ order_ref: 'A-123', location: 'Shelf 2', price: 24.99 })] });
  assert.equal(plan.status, 'ready');
  const [item] = plan.items;
  assert.deepEqual(item.target, { filament_id: 'GFA00', color_code: '10401', color_hex: 'E4BD68', line: 'PLA Basic', color: 'Gold' });
  assert.deepEqual([item.filament.action, item.filament.id, item.filament.update], ['reuse', 1, undefined]);
  assert.deepEqual(item.spools, {
    count: 2,
    weighed: false,
    params: { initial_weight: 1000, spool_weight: 250, location: 'Shelf 2', price: 24.99, comment: 'order A-123 [intake order-1 #0.<n>]' },
  });
  assert.deepEqual(plan.summary, { items: 1, spools: 2, filaments: { reuse: 1, import: 0, create: 0, same_as_earlier_item: 0 }, vendors_to_create: [] });
  assert.deepEqual(spoolman.calls, []); // planning writes nothing
});

test('plan: a new Bambu colour is imported from SpoolmanDB with the code, id and RFID colour', async () => {
  const { intake } = setup();
  const { items } = await intake.plan({ items: [matteRed()] });
  const f = items[0].filament;
  assert.equal(f.action, 'import');
  assert.equal(f.external_id, 'bambulab_pla_mattedarkred_1000_175_n');
  assert.equal(f.params.color_hex, 'BB3D43');
  assert.deepEqual(f.params.extra, { bambu_filament_id: 'GFA01', bambu_color_code: '11202' });
  assert.equal(items[0].spools.params.spool_weight, 210); // refill: reusable spool tare
});

test('plan: no SpoolmanDB match -> create in SpoolmanDB style with the profile density', async () => {
  const { intake } = setup();
  const { items } = await intake.plan({ items: [{ bambu_color_code: '30106', form: 'spool', count: 1 }] }); // PETG Basic White
  const f = items[0].filament;
  assert.equal(f.action, 'create');
  assert.deepEqual(f.params, {
    name: 'White',
    vendor_id: 1,
    material: 'PETG',
    density: 1.25,
    diameter: 1.75,
    weight: 1000,
    color_hex: 'FFFFFF',
    extra: { bambu_filament_id: 'GFG00', bambu_color_code: '30106' },
  });
});

test('plan: an existing filament found by id + colour gets the missing colour code', async () => {
  const { intake, spoolman } = setup();
  spoolman.db.filaments[0].extra = { bambu_filament_id: '"GFA00"' }; // Gold without bambu_color_code
  const { items } = await intake.plan({ items: [gold()] });
  assert.deepEqual(items[0].filament.update, { patch: {}, extra: { bambu_color_code: '10401' } });
});

test('needs input: unknown code, product line that contradicts the code, missing table; apply writes nothing', async () => {
  const { intake, spoolman } = setup();
  const plan = await intake.plan({
    items: [
      { bambu_color_code: '99999', product_line: 'PLA Basic', form: 'spool', count: 1 },
      gold({ product_line: 'PLA Matte' }),
      gold({ color_name: 'Golden' }),
    ],
  });
  assert.equal(plan.status, 'needs_input');
  assert.match(plan.items[0].problems[0], /99999 is not in BambuStudio's table: give color_hex/);
  assert.match(plan.items[1].problems[0], /10401 is PLA Basic Gold, not PLA Matte/);
  assert.equal(plan.items[2].status, 'ready');
  assert.match(plan.items[2].warnings[0], /called "Gold"/);

  await rejects(intake.apply({ batch_id: 'b', items: [gold({ product_line: 'PLA Matte' })] }), 422, /need input/);
  assert.deepEqual(spoolman.calls, []);
  assert.equal(store.getIntakeBatch('b'), undefined);

  const noTable = setup({ tableAvailable: false });
  assert.match((await noTable.intake.plan({ items: [gold()] })).items[0].problems[0], /colour code table is unavailable/);
});

test('a code missing from the table works with product line, color_hex and color_name', async () => {
  const { intake } = setup();
  const { items } = await intake.plan({
    items: [{ bambu_color_code: '11799', product_line: 'PLA Matte', color_name: 'Brand New', color_hex: '#123456', form: 'spool', count: 1 }],
  });
  assert.equal(items[0].status, 'ready');
  assert.deepEqual(items[0].target, { filament_id: 'GFA01', color_code: '11799', color_hex: '123456', line: 'PLA Matte', color: 'Brand New' });
  assert.equal(items[0].filament.params.name, 'Matte Brand New');
});

test('invalid fields are reported per item', async () => {
  const { intake } = setup();
  const { items } = await intake.plan({ items: [gold({ form: 'box', count: 0, remaining_weight: 1200 })] });
  assert.deepEqual(items[0].problems, ['form must be "spool" or "refill"', 'count must be an integer 1..100', 'remaining_weight must be between 0 and weight']);
  await rejects(intake.plan({ items: [] }), 400);
  await rejects(intake.plan({ batch_id: 'bad id!', items: [gold()] }), 400);
  await rejects(intake.apply({ items: [gold()] }), 400, /batch_id is required/);
});

test('apply: creates the spools, records them, and the marker, weighed flag and opened state', async () => {
  const { intake, spoolman } = setup();
  const result = await intake.apply({
    batch_id: 'order-1',
    items: [gold({ order_ref: 'A-123' }), matteRed({ remaining_weight: 640, opened: true })],
  });
  assert.equal(result.status, 'applied');
  assert.equal(result.spool_ids.length, 3);
  assert.deepEqual(result.items.map((i) => i.spool_ids.length), [2, 1]);
  const [first, , red] = result.spool_ids.map((id) => spoolman.db.spools.find((s) => s.id === id));
  assert.equal(first.comment, 'order A-123 [intake order-1 #0.0]');
  assert.equal(first.filament.id, 1);
  assert.equal(first.first_used, null);
  assert.equal(red.remaining_weight, 640);
  assert.equal(red.first_used, NOW);
  assert.equal(readExtra(red.filament, 'bambu_color_code'), '11202');
  assert.equal(spoolman.writes('createFilament').length, 1);
  // Only spools imported without a weighed remaining_weight may take the AMS estimate later.
  assert.deepEqual([...store.estimatedSpoolIds()].sort(), result.items[0].spool_ids.sort());
});

test('re-posting the same batch creates nothing; the same id with other items is a conflict', async () => {
  const { intake, spoolman } = setup();
  const request = { batch_id: 'order-1', items: [gold()] };
  const first = await intake.apply(request);
  const writes = spoolman.calls.length;
  const again = await intake.apply(structuredClone(request));
  assert.equal(again.status, 'already_applied');
  assert.deepEqual(again.spool_ids, first.spool_ids);
  assert.equal(spoolman.calls.length, writes);
  await rejects(intake.apply({ batch_id: 'order-1', items: [gold({ count: 3 })] }), 409);
  assert.equal(contentHash([{ a: 1, b: 2 }]), contentHash([{ b: 2, a: 1 }])); // key order doesn't matter
});

test('a failure mid-batch resumes on re-post: only missing units are created, a crashed one is adopted', async () => {
  const { intake, spoolman } = setup();
  const request = { batch_id: 'order-2', items: [gold({ count: 3 })] };
  spoolman.failNext('createSpool', new Error('Spoolman down'));
  // the first createSpool fails: nothing created yet
  await assert.rejects(intake.apply(request), /Spoolman down/);
  assert.equal(store.getIntakeBatch('order-2').state, 'applying');

  // simulate a crash right after Spoolman created unit 1 but before it was recorded
  spoolman.db.spools.push({ ...structuredClone(goldSpool), id: 77, extra: {}, comment: unitMarker('order-2', 0, 1) });
  const result = await intake.apply(request);
  assert.equal(result.status, 'applied');
  assert.equal(result.spool_ids.length, 3);
  assert.ok(result.spool_ids.includes(77));
  assert.equal(spoolman.writes('createSpool').length, 2); // units 0 and 2; the failed attempt never reached Spoolman
});

test('a filament created while the batch is being applied is reused, not duplicated', async () => {
  const { intake, spoolman } = setup();
  const request = { batch_id: 'order-3', items: [matteRed()] };
  // apply plans first (import), then writes. Simulate RFID pairing creating the same filament
  // right after that plan read the filament list:
  const list = spoolman.listFilaments;
  let reads = 0;
  spoolman.listFilaments = async () => {
    const result = await list();
    if (++reads === 1) await spoolman.createFilament({ name: 'PLA Matte #BB3D43', material: 'PLA', color_hex: 'BB3D43', extra: { bambu_filament_id: 'GFA01' } });
    return result;
  };
  const result = await intake.apply(request);
  assert.equal(spoolman.writes('createFilament').length, 1); // only the simulated RFID one
  const spoolFilament = spoolman.db.spools.find((x) => x.id === result.spool_ids[0]).filament;
  assert.equal(spoolFilament.name, 'PLA Matte #BB3D43');
});

test('two items of a new colour in one batch create the filament once', async () => {
  const { intake, spoolman } = setup();
  const request = { batch_id: 'order-4', items: [matteRed(), matteRed({ form: 'spool' })] };
  const { items } = await intake.plan(request);
  assert.deepEqual(items[1].filament, { action: 'same', as_item: 0, name: 'Matte Dark Red' });
  const result = await intake.apply(request);
  assert.equal(spoolman.writes('createFilament').length, 1);
  const filamentIds = result.spool_ids.map((id) => spoolman.db.spools.find((s) => s.id === id).filament.id);
  assert.equal(new Set(filamentIds).size, 1);
});

test('non-Bambu items: generic filament id from the profile, vendor created once', async () => {
  const { intake, spoolman } = setup();
  const acme = (extra = {}) => ({ vendor: 'Acme', material: 'PETG', color_name: 'Black', color_hex: '000000', form: 'spool', count: 1, ...extra });
  const request = { batch_id: 'order-5', items: [acme(), acme({ count: 2, remaining_weight: 400 })] };
  const plan = await intake.plan(request);
  assert.equal(plan.status, 'ready');
  assert.deepEqual(plan.items[0].target, { filament_id: 'GFG99', color_code: null, color_hex: '000000', line: 'Generic PETG', color: 'Black' });
  assert.deepEqual(plan.items[0].filament.vendor, { action: 'create', name: 'Acme' });
  assert.deepEqual(plan.items[0].filament.params, {
    name: 'Black', vendor_id: null, material: 'PETG', density: 1.27, diameter: 1.75, weight: 1000, color_hex: '000000',
    extra: { bambu_filament_id: 'GFG99' },
  });
  assert.equal(plan.items[1].filament.action, 'same');
  assert.deepEqual(plan.summary.vendors_to_create, ['Acme']);

  const result = await intake.apply(request);
  assert.equal(result.spool_ids.length, 3);
  assert.equal(spoolman.writes('createVendor').length, 1);
  assert.equal(spoolman.writes('createFilament').length, 1);
  const f = spoolman.db.spools.find((s) => s.id === result.spool_ids[0]).filament;
  assert.equal(f.vendor.name, 'Acme');
  assert.equal(readExtra(f, 'bambu_filament_id'), 'GFG99');

  // a second batch reuses vendor and filament
  const again = await intake.plan({ items: [acme()] });
  assert.deepEqual([again.items[0].filament.action, again.items[0].filament.vendor.action], ['reuse', 'reuse']);
});

test('non-Bambu items: profile variants, unknown materials and missing fields need input', async () => {
  const { intake } = setup();
  const plan = await intake.plan({
    items: [
      { vendor: 'Acme', material: 'PLA', profile: 'PLA Silk', color_name: 'Silver', color_hex: 'C0C0C0', form: 'spool', count: 1 },
      { vendor: 'Acme', material: 'Unobtainium', color_name: 'Grey', color_hex: '808080', form: 'spool', count: 1 },
      { material: 'PLA', color_name: 'Grey', form: 'spool', count: 1 },
    ],
  });
  assert.equal(plan.items[0].target.filament_id, 'GFL96');
  assert.match(plan.items[1].problems[0], /no Bambu generic profile "Generic Unobtainium".*PETG/);
  assert.deepEqual(plan.items[2].problems, ['vendor is required for non-Bambu items (or give bambu_color_code)', 'color_hex is required for non-Bambu items']);
});

test('a hand-made filament of the same vendor, material and colour is reused and gets its id', async () => {
  const { intake, spoolman } = setup();
  const vendor = await spoolman.createVendor({ name: 'Acme' });
  await spoolman.createFilament({ name: 'Black', vendor_id: vendor.id, material: 'PETG', color_hex: '000000', extra: {} });
  const { items } = await intake.plan({ items: [{ vendor: 'acme', material: 'PETG', color_name: 'Black', color_hex: '000000', form: 'spool', count: 1 }] });
  assert.equal(items[0].filament.action, 'reuse');
  assert.deepEqual(items[0].filament.update, { patch: {}, extra: { bambu_filament_id: 'GFG99' } });
});

// An invented two-colour entry (the fixture only holds the author's five real ones).
const duoTable = () =>
  createColorTable({
    data: [
      ...colorCodes.data,
      { fila_color_code: '99901', fila_id: 'GFA05', fila_type: 'PLA Silk', fila_color_type: '多拼色', fila_color_name: { en: 'Test Duo' }, fila_color: ['#1F3A93FF', '#C0392BFF'] },
    ],
  });

test('multi-colour Bambu filament: multi_color_hexes and direction, color_hex left empty', async () => {
  const spoolman = createFakeSpoolman({ spools: [], filaments: [goldFilament], catalog });
  const table = duoTable();
  const intake = createIntake({ spoolman, store, colorTable: () => table, config: {}, log: silentLog, now: () => NOW });
  const { items } = await intake.plan({ items: [{ bambu_color_code: '99901', form: 'spool', count: 1 }] });
  assert.deepEqual(items[0].warnings, []);
  assert.deepEqual(items[0].target.color_hexes, ['1F3A93', 'C0392B']);
  assert.equal(items[0].target.direction, 'coaxial');
  const p = items[0].filament.params;
  assert.deepEqual([p.color_hex, p.multi_color_hexes, p.multi_color_direction, p.name], [null, '1F3A93,C0392B', 'coaxial', 'Silk Test Duo']);
  const result = await intake.apply({ batch_id: 'duo', items: [{ bambu_color_code: '99901', form: 'spool', count: 1 }] });
  const f = spoolman.db.spools.find((s) => s.id === result.spool_ids[0]).filament;
  assert.deepEqual([f.color_hex, f.multi_color_hexes, f.multi_color_direction], [null, '1F3A93,C0392B', 'coaxial']);
});

test('multi-colour Bambu filament: imported from SpoolmanDB by its set of colours', async () => {
  const duoEntry = {
    id: 'bambulab_pla_testduo_1000_175_n', manufacturer: 'Bambu Lab', name: 'Test Duo', material: 'PLA', density: 1.26, weight: 1000,
    diameter: 1.75, color_hexes: ['C0392B', '1F3A93'], multi_color_direction: 'coaxial', translucent: false, glow: false,
  };
  const spoolman = createFakeSpoolman({ spools: [], filaments: [], catalog: [...catalog, duoEntry] });
  const table = duoTable();
  const intake = createIntake({ spoolman, store, colorTable: () => table, config: {}, log: silentLog });
  const { items } = await intake.plan({ items: [{ bambu_color_code: '99901', form: 'spool', count: 1 }] });
  assert.equal(items[0].filament.action, 'import');
  assert.equal(items[0].filament.external_id, 'bambulab_pla_testduo_1000_175_n');
  assert.deepEqual([items[0].filament.params.color_hex, items[0].filament.params.multi_color_hexes], [null, '1F3A93,C0392B']);
});

test('a single-colour filament whose colour is wrong is corrected; a multi-colour one gets its colours', async () => {
  const spoolman = createFakeSpoolman({ spools: [], filaments: [{ ...goldFilament, id: 5, color_hex: 'E4BD60' }], catalog });
  const table = duoTable();
  const intake = createIntake({ spoolman, store, colorTable: () => table, config: {}, log: silentLog });
  const { items } = await intake.plan({ items: [{ bambu_color_code: '10401', form: 'spool', count: 1 }] });
  assert.deepEqual(items[0].filament.update, { patch: { color_hex: 'E4BD68' }, extra: {} });

  spoolman.db.filaments.push({ ...goldFilament, id: 6, name: 'Test Duo', color_hex: '1F3A93', extra: { bambu_filament_id: '"GFA05"', bambu_color_code: '"99901"' } });
  const duo = await intake.plan({ items: [{ bambu_color_code: '99901', form: 'spool', count: 1 }] });
  assert.deepEqual(duo.items[0].filament.update.patch, { color_hex: null, multi_color_hexes: '1F3A93,C0392B', multi_color_direction: 'coaxial' });
});

test('Add from SpoolmanDB: imports the entry with the reported filament id and creates one spool', async () => {
  const entry = { id: 'acme_petg_black_1000_175_n', manufacturer: 'Acme', name: 'Black', material: 'PETG', density: 1.27, weight: 1000, spool_weight: 200, diameter: 1.75, color_hex: '111111' };
  const spoolman = createFakeSpoolman({ spools: [], filaments: [], catalog: [entry] });
  const intake = createIntake({ spoolman, store, colorTable: () => createColorTable(colorCodes), config: {}, log: silentLog });
  const first = await intake.addCatalogSpool({ query: 'acme petg', externalId: entry.id, bambuFilamentId: 'GFG99' });
  const s = spoolman.db.spools.find((x) => x.id === first.spoolId);
  assert.deepEqual([s.initial_weight, s.spool_weight, s.comment], [1000, 200, 'added from the bridge (SpoolmanDB acme_petg_black_1000_175_n)']);
  assert.deepEqual([s.filament.external_id, s.filament.vendor.name, readExtra(s.filament, 'bambu_filament_id')], [entry.id, 'Acme', 'GFG99']);
  assert.equal(spoolman.writes('createVendor').length, 1);

  // again: the filament is reused, only a spool is created
  const second = await intake.addCatalogSpool({ query: 'acme petg', externalId: entry.id, bambuFilamentId: 'GFG99' });
  assert.equal(second.filamentId, first.filamentId);
  assert.equal(spoolman.writes('createFilament').length, 1);
  assert.equal(spoolman.writes('createSpool').length, 2);
  await rejects(intake.addCatalogSpool({ query: 'acme petg', externalId: 'nope' }), 404);
});

test('Add from SpoolmanDB for a Bambu tray also stores the colour code', async () => {
  const spoolman = createFakeSpoolman({ spools: [], filaments: [], catalog });
  const intake = createIntake({ spoolman, store, colorTable: () => createColorTable(colorCodes), config: {}, log: silentLog });
  const { spoolId } = await intake.addCatalogSpool({ query: 'bambu lab pla', externalId: 'bambulab_pla_mattedarkred_1000_175_n', bambuFilamentId: 'GFA01' });
  const f = spoolman.db.spools.find((x) => x.id === spoolId).filament;
  assert.deepEqual([readExtra(f, 'bambu_filament_id'), readExtra(f, 'bambu_color_code')], ['GFA01', '11202']);
});

// Translucent entries (alpha 80 / 00), invented codes shaped like BambuStudio's.
const translucentTable = () =>
  createColorTable({
    data: [
      ...colorCodes.data,
      { fila_color_code: '99201', fila_id: 'GFG01', fila_type: 'PETG Translucent', fila_color_type: '单色', fila_color_name: { en: 'Clear' }, fila_color: ['#00000000'] },
      { fila_color_code: '99202', fila_id: 'GFG01', fila_type: 'PETG Translucent', fila_color_type: '单色', fila_color_name: { en: 'Translucent Brown' }, fila_color: ['#C9A38180'] },
    ],
  });

test('translucent colours are stored with their alpha; an existing opaque copy is corrected', async () => {
  const brown = { ...goldFilament, id: 8, name: 'Translucent Brown', material: 'PETG', color_hex: 'C9A381', extra: { bambu_filament_id: '"GFG01"', bambu_color_code: '"99202"' } };
  const spoolman = createFakeSpoolman({ spools: [], filaments: [brown], catalog: [] });
  const table = translucentTable();
  const intake = createIntake({ spoolman, store, colorTable: () => table, config: {}, log: silentLog });
  const { items } = await intake.plan({ items: [{ bambu_color_code: '99201', form: 'spool', count: 1 }, { bambu_color_code: '99202', form: 'spool', count: 1 }] });
  assert.equal(items[0].filament.action, 'create');
  assert.equal(items[0].filament.params.color_hex, '00000000');
  assert.deepEqual(items[0].target.color_stored, ['00000000']);
  assert.deepEqual([items[1].filament.action, items[1].filament.update.patch], ['reuse', { color_hex: 'C9A38180' }]);
});

test('"+ New spool": one more spool of an existing filament', async () => {
  const spoolman = createFakeSpoolman({ spools: [], filaments: [goldFilament], catalog });
  const intake = createIntake({ spoolman, store, colorTable: () => null, config: {}, log: silentLog });
  const { spoolId, filamentName } = await intake.addFilamentSpool({ filamentId: 1 });
  const s = spoolman.db.spools.find((x) => x.id === spoolId);
  assert.deepEqual([s.filament.id, s.initial_weight, s.spool_weight, s.comment, filamentName], [1, 1000, 250, 'added from the bridge', 'Gold']);
  await rejects(intake.addFilamentSpool({ filamentId: 999 }), 404);
});

test('localFilamentForEntry: by external_id, by colour code, by filament id + colour', async () => {
  const { localFilamentForEntry } = await import('../src/catalog.js');
  const table = createColorTable(colorCodes);
  const entry = { id: 'bambulab_pla_gold_1000_175_n', manufacturer: 'Bambu Lab', name: 'Gold', material: 'PLA', color_hex: 'E4BD68' };
  assert.equal(localFilamentForEntry([goldFilament], entry).filament.id, 1); // external_id
  const noExt = { ...goldFilament, external_id: null, color_hex: 'E4BD60' }; // other hex, right code
  assert.equal(localFilamentForEntry([noExt], { ...entry, id: 'x' }, { bambuFilamentId: 'GFA00', colorTable: table }).filament.id, 1);
  const byIdHex = { ...goldFilament, external_id: null, extra: { bambu_filament_id: '"GFA00"' } };
  assert.equal(localFilamentForEntry([byIdHex], { ...entry, id: 'x' }, { bambuFilamentId: 'GFA00' }).filament.id, 1);
  assert.equal(localFilamentForEntry([byIdHex], { ...entry, id: 'x' }).filament, null); // nothing to go on
  // a generic id + colour belongs to one vendor only
  const acme = { ...goldFilament, id: 9, external_id: null, vendor: { id: 7, name: 'Acme' }, color_hex: '000000', extra: { bambu_filament_id: '"GFG99"' } };
  const polymaker = { id: 'polymaker_petg_black', manufacturer: 'Polymaker', name: 'Black', material: 'PETG', color_hex: '000000' };
  assert.equal(localFilamentForEntry([acme], polymaker, { bambuFilamentId: 'GFG99' }).filament, null);
  assert.equal(localFilamentForEntry([acme], { ...polymaker, manufacturer: 'acme' }, { bambuFilamentId: 'GFG99' }).filament.id, 9);
});
