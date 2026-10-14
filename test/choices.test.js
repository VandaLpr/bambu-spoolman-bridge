import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filamentChoices, reportedFor, spoolChoices, stockLabel } from '../src/choices.js';
import { createColorTable } from '../src/bambu/colors.js';
import { openStore } from '../src/store.js';
import { colorCodes } from './fixtures/ha.js';
import { filament, spool } from './fixtures/spoolman.js';

const T = '2026-10-01T00:00:00Z';
const genericBlack = { ...filament({ id: 10, name: 'Black', material: 'PETG', colorHex: '000000', bambuId: 'GFG99' }), vendor: { id: 5, name: 'Acme' } };
const charcoal = filament({ id: 14, name: 'Charcoal', material: 'PETG', colorHex: '1A1A1A', bambuId: 'GFG00' });
const bambuWhite = filament({ id: 11, name: 'White', material: 'PETG', colorHex: 'FFFFFF', bambuId: 'GFG00' });
const otherBlack = filament({ id: 15, name: 'Black', material: 'PETG', colorHex: '000000', bambuId: 'GFG99' });
const gold = filament({ id: 12, name: 'Gold', material: 'PLA', colorHex: 'E4BD68', bambuId: 'GFA00' });
const empty = filament({ id: 16, name: 'Sold Out', material: 'ABS', colorHex: '808080' });
const filaments = [genericBlack, charcoal, bambuWhite, otherBlack, gold, empty];
const spools = [
  spool({ id: 20, filament: genericBlack, firstUsed: T }),
  spool({ id: 21, filament: genericBlack }),
  spool({ id: 22, filament: genericBlack }),
  spool({ id: 23, filament: charcoal, firstUsed: T }),
  spool({ id: 24, filament: bambuWhite }),
  spool({ id: 25, filament: otherBlack, firstUsed: T, rfid: 'AAAA', tags: ['AAAA'] }), // bound to an RFID tag
  spool({ id: 26, filament: gold }),
  spool({ id: 27, filament: empty, remaining: 0 }),
  spool({ id: 28, filament: gold, archived: true }),
];
const external = { filamentId: 'GFG99', colorHex: '000000', material: 'PETG', name: 'Generic PETG', trayUuid: null, colorCode: null };

test('stock labels', () => {
  assert.equal(stockLabel({ opened: 1, shelf: 2 }), '1 opened · 2 on shelf');
  assert.equal(stockLabel({ opened: 0, shelf: 3 }), '3 on shelf');
  assert.equal(stockLabel({ opened: 2, shelf: 0 }), '2 opened');
});

test('external spool: exact filaments first, then the alias, then close colours', () => {
  const aliases = [{ reported_filament_id: 'GFG99', reported_color_hex: '000000', filament_id: 14 }]; // Charcoal
  const { suggested, groups, hidden } = filamentChoices({ filaments, spools, reported: external, aliases });
  assert.deepEqual(suggested.map((v) => [v.id, v.exact, v.isAlias]), [
    [10, true, false], // same generic id and colour
    [15, true, false], // same; its spool is RFID-bound, but that's fine for an external spool
    [14, false, true], // remembered answer
  ]);
  assert.deepEqual(groups.map((g) => [g.material, g.filaments.map((v) => v.id)]), [['PETG', [11]], ['PLA', [12]]]);
  assert.equal(hidden, 1); // the ABS without stock
  const black = suggested.find((v) => v.id === 10);
  assert.deepEqual([black.vendor, black.opened, black.shelf, black.colors], ['Acme', 1, 2, ['000000']]);
  assert.deepEqual(suggested.find((v) => v.id === 14).aliases, aliases);
});

test('other colours of the same filament id are not "matches"; they stay in their material group', () => {
  const red = filament({ id: 17, name: 'Red', material: 'PETG', colorHex: 'C0392B', bambuId: 'GFG99' });
  const { suggested, groups } = filamentChoices({ filaments: [...filaments, red], spools: [...spools, spool({ id: 29, filament: red })], reported: external });
  assert.equal(suggested.some((v) => v.id === 17), false);
  assert.deepEqual(groups.find((g) => g.material === 'PETG').filaments.map((v) => v.id), [17, 11]);
});

test('RFID tray: only unbound spools count; the exact filament stays on top with no free spool', () => {
  const rfid = { ...external, trayUuid: 'BBBB' };
  const { suggested, hidden } = filamentChoices({ filaments, spools, reported: rfid });
  assert.deepEqual(suggested.slice(0, 2).map((v) => [v.id, v.exact, v.free, v.boundOnly]), [
    [10, true, 3, false],
    [15, true, 0, true], // its only spool is tied to another RFID tag: offered as "+ New spool"
  ]);
  assert.equal(hidden, 1); // the ABS without stock
});

test('the exact filament by colour code, even when its stored hex differs', () => {
  const darkRed = filament({ id: 30, name: 'Matte Dark Red', material: 'PLA', colorHex: 'B83C42', bambuId: 'GFA01' });
  darkRed.extra.bambu_color_code = '"11202"';
  const scarlet = filament({ id: 31, name: 'Matte Scarlet Red', material: 'PLA', colorHex: 'DE4343', bambuId: 'GFA01' });
  const reported = { filamentId: 'GFA01', colorHex: 'BB3D43', material: 'PLA', trayUuid: 'CCCC', colorCode: '11202' };
  const all = [spool({ id: 40, filament: darkRed, rfid: 'DDDD', tags: ['DDDD'], firstUsed: T }), spool({ id: 41, filament: scarlet })];
  const { suggested } = filamentChoices({ filaments: [scarlet, darkRed], spools: all, reported });
  assert.deepEqual(suggested.map((v) => [v.id, v.exact, v.free]), [[30, true, 0], [31, false, 1]]);
});

test('alsoShow lists a filament without a free spool (a search hit already in the inventory)', () => {
  const { groups, hidden } = filamentChoices({ filaments, spools, reported: external, alsoShow: new Set([16]) });
  assert.deepEqual(groups.find((g) => g.material === 'ABS').filaments.map((v) => [v.id, v.free]), [[16, 0]]);
  assert.equal(hidden, 0);
});

test('step 2 lists the filament\'s spools, opened first', () => {
  assert.deepEqual(spoolChoices({ spools, filamentId: 10, reported: external }).map((s) => s.id), [20, 21, 22]);
});

test('reportedFor: from the job source for a print question, from the context for an insert question', () => {
  const store = openStore(':memory:');
  const jobId = store.createJob({ printer: 'a1', dryRun: false });
  store.replaceJobSources(jobId, [{ sourceKey: 'External Spool', grams: 1, kind: 'external', filamentId: 'GFG99', colorHex: '000000', material: 'PETG', name: 'Generic PETG' }]);
  const print = store.upsertPending({ jobId, sourceKey: 'External Spool', reason: 'no_match', candidates: [] });
  assert.deepEqual(reportedFor(store, print), external);
  const { pending } = store.addInsertPending({
    printer: 'p2s', sourceKey: 'AMS 1 Tray 3', trayUuid: 'CCCC', reason: 'no_match', candidates: [],
    context: { identity: { filamentId: 'GFA01', colorHex: 'BB3D43', material: 'PLA', name: 'Bambu PLA Matte' }, location: 'x' },
  });
  assert.deepEqual(reportedFor(store, pending), { filamentId: 'GFA01', colorHex: 'BB3D43', material: 'PLA', name: 'Bambu PLA Matte', trayUuid: 'CCCC', colorCode: null });
  assert.equal(reportedFor(store, pending, createColorTable(colorCodes)).colorCode, '11202');
  store.close();
});
