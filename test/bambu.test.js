import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { colorTableUrl, createColorTable, DEFAULT_COLOR_REF, loadColorTable } from '../src/bambu/colors.js';
import { bambuProfile, densityFor, genericProfile, genericProfileNames } from '../src/bambu/profiles.js';
import { silentLog } from './fixtures/fakes.js';
import { colorCodes } from './fixtures/ha.js';

const table = createColorTable(colorCodes);

test('colour codes resolve to filament id, product line, English name and hex (the RFID values)', () => {
  assert.equal(table.size, 5);
  assert.deepEqual(table.byCode('10401'), {
    code: '10401', filamentId: 'GFA00', line: 'PLA Basic', name: 'Gold', hex: 'E4BD68', hexes: ['E4BD68'], stored: ['E4BD68'], kind: 'single', direction: null,
  });
  assert.equal(table.byCode(11202).name, 'Dark Red'); // numbers work too
  assert.equal(table.byCode('99999'), null);
});

test('an RFID tray (filament id + colour) maps back to its colour code', () => {
  assert.equal(table.byFilamentAndHex('GFA01', '#BB3D43FF').code, '11202');
  assert.equal(table.byFilamentAndHex('GFA00', 'BB3D43'), null); // same colour, other product line
});

test('product lines map to filament ids, case-insensitively', () => {
  assert.deepEqual(table.line('pla matte'), { line: 'PLA Matte', filamentId: 'GFA01' });
  assert.equal(table.line('PLA Galaxy'), null); // not in this fixture
  assert.deepEqual(table.lineNames(), ['PETG Basic', 'PLA Basic', 'PLA Matte']);
});

test('gradient and multi-colour entries keep all colours', () => {
  const t = createColorTable({ data: [{ fila_color_code: '1', fila_id: 'GFA00', fila_type: 'PLA Basic', fila_color_type: '渐变色', fila_color_name: { en: 'X' }, fila_color: ['#111111FF', '#222222FF'] }] });
  assert.deepEqual([t.byCode('1').kind, t.byCode('1').hexes, t.byCode('1').direction], ['gradient', ['111111', '222222'], 'longitudinal']);
  assert.equal(t.byFilamentAndHex('GFA00', '111111'), null); // one colour never maps to a gradient
  assert.equal(t.byFilamentAndHex('GFA00', '111111', ['#222222FF', '#111111FF']).code, '1'); // all of a tray's colours do
});

test('the table is downloaded once per ref, cached in DATA_DIR, and missing means null', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bsb-'));
  const urls = [];
  const fetchOk = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify(colorCodes) };
  };
  const first = await loadColorTable({ ref: 'abc123', dataDir: dir, log: silentLog, fetchImpl: fetchOk });
  assert.equal(first.size, 5);
  assert.deepEqual(urls, [colorTableUrl('abc123')]);
  assert.match(urls[0], /bambulab\/BambuStudio\/abc123\/resources\/profiles\/BBL\/filament\/filaments_color_codes\.json$/);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'bambu-color-codes-abc123.json'), 'utf8')).data.length, 5);

  const again = await loadColorTable({ ref: 'abc123', dataDir: dir, log: silentLog, fetchImpl: async () => assert.fail('must use the cache') });
  assert.equal(again.size, 5);

  const failed = await loadColorTable({ ref: 'other', dataDir: dir, log: silentLog, fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.equal(failed, null);
  writeFileSync(path.join(dir, 'bambu-color-codes-broken.json'), '{"no":"data"}');
  assert.equal(await loadColorTable({ ref: 'broken', dataDir: dir, log: silentLog, fetchImpl: async () => ({ ok: false, status: 500 }) }), null);
  rmSync(dir, { recursive: true, force: true });
});

test('the default ref is the pinned commit', () => {
  assert.match(DEFAULT_COLOR_REF, /^804d93bb5d[0-9a-f]{30}$/);
});

test('generic profiles: what the printer reports for non-Bambu filament', () => {
  assert.deepEqual(genericProfile('PETG'), { profile: 'Generic PETG', name: 'PETG', filamentId: 'GFG99', material: 'PETG', density: 1.27 });
  assert.equal(genericProfile('Generic PLA').filamentId, 'GFL99');
  assert.equal(genericProfile('pla silk').filamentId, 'GFL96');
  assert.equal(genericProfile('PETG HF').material, 'PETG');
  assert.equal(genericProfile('Unobtainium'), null);
  assert.ok(genericProfileNames().includes('PCTG'));
});

test('Bambu profiles by filament id, with their own densities', () => {
  assert.equal(bambuProfile('GFA01').profile, 'Bambu PLA Matte');
  assert.equal(bambuProfile('GFA01').density, 1.32);
  assert.equal(densityFor('GFG99'), 1.27);
  assert.equal(densityFor('GFX42'), null);
});

test('stored colours keep a non-opaque alpha; matching stays RGB', async () => {
  const { storedHex, normalizeHex, filamentStoredColors, filamentColors } = await import('../src/color.js');
  assert.equal(storedHex('#C9A38180'), 'C9A38180');
  assert.equal(storedHex('#00000000'), '00000000');
  assert.equal(storedHex('#E4BD68FF'), 'E4BD68');
  assert.equal(storedHex('e4bd68'), 'E4BD68');
  assert.equal(storedHex('nope'), null);
  assert.equal(normalizeHex('C9A38180'), 'C9A381');
  const clear = { color_hex: '00000000' };
  assert.deepEqual([filamentStoredColors(clear), filamentColors(clear)], [['00000000'], ['000000']]);
  const t = createColorTable({ data: [{ fila_color_code: '32101', fila_id: 'GFG01', fila_type: 'PETG Translucent', fila_color_type: '单色', fila_color_name: { en: 'Clear' }, fila_color: ['#00000000'] }] });
  assert.deepEqual([t.byCode('32101').hex, t.byCode('32101').stored], ['000000', ['00000000']]);
});
