import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogSearchQuery,
  filamentFromCatalog,
  filamentFromRfid,
  findExistingFilament,
  pickCatalogEntry,
  planFilament,
  variantTokens,
} from '../src/catalog.js';
import { resolveSource } from '../src/resolver.js';
import { identityFromTray } from '../src/sources.js';
import { encodeExtra } from '../src/spoolman/extra.js';
import { catalog, tray } from './fixtures/ha.js';
import { filament, goldFilament } from './fixtures/spoolman.js';

// What Spoolman returns after POST /filament: an id, a vendor object, encoded extra.
const stored = (params, id) => ({ ...params, id, vendor: { id: params.vendor_id, name: 'Bambu Lab' }, extra: encodeExtra(params.extra) });

const query = (attrs) => {
  const { filamentId, colorHex, material, name, trayWeight } = identityFromTray(attrs);
  return { filamentId, colorHex, material, name, trayWeight };
};

test('variantTokens strips vendor, material and "Basic"', () => {
  assert.deepEqual(variantTokens('Bambu PLA Basic', 'PLA'), []);
  assert.deepEqual(variantTokens('Bambu PLA Matte', 'PLA'), ['matte']);
  assert.deepEqual(variantTokens('Bambu PLA Silk+', 'PLA'), ['silk']);
  assert.deepEqual(variantTokens('Bambu PETG HF', 'PETG'), ['hf']);
});

test('catalog search query is vendor + material', () => {
  assert.equal(catalogSearchQuery(query(tray(1))), 'Bambu Lab PLA');
});

test('PLA Basic picks the plain entry for the exact color (real SpoolmanDB data)', () => {
  assert.equal(pickCatalogEntry(catalog, query(tray(1)))?.id, 'bambulab_pla_gold_1000_175_n');
  assert.equal(pickCatalogEntry(catalog, query(tray(4)))?.id, 'bambulab_pla_beige_1000_175_n');
  // 000000 is shared by Aero, Lite, Matte Charcoal, Pure Absolute, Tough+ and Support Black
  assert.equal(pickCatalogEntry(catalog, query(tray(2)))?.id, 'bambulab_pla_black_1000_175_n');
});

test('PLA Matte picks the matte entry', () => {
  assert.equal(pickCatalogEntry(catalog, query(tray(3)))?.id, 'bambulab_pla_mattedarkred_1000_175_n');
});

test('no single match returns null so the filament is built from RFID data', () => {
  assert.equal(pickCatalogEntry(catalog, { ...query(tray(3)), name: 'Bambu PLA Basic' }), null);
  assert.equal(pickCatalogEntry(catalog, { ...query(tray(1)), colorHex: '123456' }), null);
});

test('filamentFromCatalog copies the entry and adds bambu_filament_id', () => {
  const entry = catalog.find((e) => e.id === 'bambulab_pla_gold_1000_175_n');
  assert.deepEqual(filamentFromCatalog(entry, { vendorId: 1, bambuFilamentId: 'GFA00' }), {
    name: 'Gold',
    vendor_id: 1,
    material: 'PLA',
    density: entry.density,
    diameter: 1.75,
    weight: 1000,
    spool_weight: entry.spool_weight,
    color_hex: 'E4BD68',
    settings_extruder_temp: entry.extruder_temp,
    settings_bed_temp: entry.bed_temp,
    external_id: 'bambulab_pla_gold_1000_175_n',
    extra: { bambu_filament_id: 'GFA00' },
  });
});

test('filamentFromRfid builds a usable filament from tray data', () => {
  const f = filamentFromRfid(query(tray(3)), { vendorId: 1 });
  assert.equal(f.name, 'PLA Matte #BB3D43');
  assert.equal(f.material, 'PLA');
  assert.equal(f.density, 1.24);
  assert.equal(f.weight, 1000);
  assert.equal(f.color_hex, 'BB3D43');
  assert.deepEqual(f.extra, { bambu_filament_id: 'GFA01' });
});

test('findExistingFilament matches bambu_filament_id + color, then external_id', () => {
  const lower = filament({ id: 7, name: 'Gold', colorHex: 'e4bd68', bambuId: 'GFA00' });
  assert.equal(findExistingFilament([goldFilament, lower], { filamentId: 'GFA00', colorHex: '#E4BD68FF' }).id, 1);
  assert.equal(findExistingFilament([lower], { filamentId: 'GFA00', colorHex: 'E4BD68' }).id, 7);
  assert.equal(findExistingFilament([goldFilament], { filamentId: 'GFA00', colorHex: '000000' }), null);
  assert.equal(findExistingFilament([goldFilament], { filamentId: 'GFA01', colorHex: 'E4BD68' }), null);
  assert.equal(findExistingFilament([goldFilament], { externalId: 'bambulab_pla_gold_1000_175_n' }).id, 1);
});

test('planFilament reuses a local filament before looking at the catalog', () => {
  assert.deepEqual(planFilament({ filaments: [goldFilament], catalogEntries: catalog, query: query(tray(1)), vendorId: 1 }), { use: goldFilament });
});

test('planFilament imports from SpoolmanDB when nothing local matches', () => {
  const plan = planFilament({ filaments: [], catalogEntries: catalog, query: query(tray(3)), vendorId: 1 });
  assert.equal(plan.entry.id, 'bambulab_pla_mattedarkred_1000_175_n');
  assert.equal(plan.import.external_id, 'bambulab_pla_mattedarkred_1000_175_n');
  assert.deepEqual(plan.import.extra, { bambu_filament_id: 'GFA01' });
});

test('planFilament reuses a hand-imported SpoolmanDB filament and fills in bambu_filament_id', () => {
  const handImported = { ...goldFilament, id: 3, extra: {} };
  assert.deepEqual(planFilament({ filaments: [handImported], catalogEntries: catalog, query: query(tray(1)), vendorId: 1 }), {
    use: handImported,
    patchExtra: { bambu_filament_id: 'GFA00' },
  });
});

test('an RFID-built filament is not duplicated by a later SpoolmanDB import', () => {
  const q = query(tray(3));
  // 1. SpoolmanDB has no entry yet: the filament is built from RFID data.
  const first = planFilament({ filaments: [], catalogEntries: [], query: q, vendorId: 1 });
  assert.ok(first.create);
  const rfidBuilt = stored(first.create, 50);

  // 2. Later the catalog does have it: the local RFID-built filament still wins.
  assert.deepEqual(planFilament({ filaments: [rfidBuilt], catalogEntries: catalog, query: q, vendorId: 1 }), { use: rfidBuilt });

  // 3. A second spool of the same filament (new tray_uuid) reuses it in the resolver too.
  const identity = { ...identityFromTray(tray(3)), trayUuid: '99999999999999999999999999999999' };
  const d = resolveSource({ identity, location: 'P2S AMS1 Slot 3', inventory: { spools: [], filaments: [rfidBuilt] } });
  assert.equal(d.status, 'create');
  assert.equal(d.filamentId, 50);
  assert.equal(d.filamentQuery, null);
});
