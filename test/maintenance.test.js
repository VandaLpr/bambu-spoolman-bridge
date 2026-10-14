import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createColorTable } from '../src/bambu/colors.js';
import { ALPHA_FIX, restoreAlpha } from '../src/maintenance.js';
import { openStore } from '../src/store.js';
import { createFakeSpoolman, silentLog } from './fixtures/fakes.js';
import { colorCodes } from './fixtures/ha.js';
import { filament } from './fixtures/spoolman.js';

let store;
beforeEach(() => {
  store = openStore(':memory:');
});
afterEach(() => store.close());

const table = createColorTable({
  data: [
    ...colorCodes.data,
    { fila_color_code: '99201', fila_id: 'GFG01', fila_type: 'PETG Translucent', fila_color_type: '单色', fila_color_name: { en: 'Clear' }, fila_color: ['#00000000'] },
    { fila_color_code: '99202', fila_id: 'GFG01', fila_type: 'PETG Translucent', fila_color_type: '单色', fila_color_name: { en: 'Translucent Brown' }, fila_color: ['#C9A38180'] },
  ],
});
const withCode = (f, code) => ({ ...f, extra: { ...f.extra, bambu_color_code: JSON.stringify(code) } });
const clear = withCode(filament({ id: 1, name: 'Clear', material: 'PETG', colorHex: '000000', bambuId: 'GFG01' }), '99201');
const brown = withCode(filament({ id: 2, name: 'Translucent Brown', material: 'PETG', colorHex: 'C9A381', bambuId: 'GFG01' }), '99202');
const handPainted = withCode(filament({ id: 3, name: 'Brown, recoloured', material: 'PETG', colorHex: '804020', bambuId: 'GFG01' }), '99202');
const gold = withCode(filament({ id: 4, name: 'Gold', colorHex: 'E4BD68', bambuId: 'GFA00' }), '10401');
const done = withCode(filament({ id: 5, name: 'Clear (fixed)', material: 'PETG', colorHex: '00000000', bambuId: 'GFG01' }), '99201');

test('restores the alpha of translucent colours once, leaving opaque and hand-changed colours alone', async () => {
  const spoolman = createFakeSpoolman({ filaments: [clear, brown, handPainted, gold, done] });
  const result = await restoreAlpha({ store, spoolman, colorTable: table, log: silentLog });
  assert.deepEqual(result.fixed, [1, 2]);
  assert.deepEqual(spoolman.writes('patchFilament'), [
    ['patchFilament', 1, { color_hex: '00000000' }],
    ['patchFilament', 2, { color_hex: 'C9A38180' }],
  ]);
  assert.ok(store.getMeta(ALPHA_FIX));
  const again = await restoreAlpha({ store, spoolman, colorTable: table, log: silentLog });
  assert.equal(again.skipped, true);
  assert.equal(spoolman.writes('patchFilament').length, 2);
});

test('without the colour table, or on a failure, it is retried at the next start', async () => {
  const spoolman = createFakeSpoolman({ filaments: [clear] });
  assert.equal((await restoreAlpha({ store, spoolman, colorTable: null, log: silentLog })).skipped, true);
  assert.equal(store.getMeta(ALPHA_FIX), null);
  spoolman.patchFilament = async () => {
    throw new Error('Spoolman down');
  };
  await assert.rejects(restoreAlpha({ store, spoolman, colorTable: table, log: silentLog }), /Spoolman down/);
  assert.equal(store.getMeta(ALPHA_FIX), null);
});
