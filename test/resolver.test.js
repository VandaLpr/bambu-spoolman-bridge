import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CREATED_COMMENT, filamentFromRfid } from '../src/catalog.js';
import { choiceWrites, resolveSource } from '../src/resolver.js';
import { identityFromTray } from '../src/sources.js';
import { createColorTable } from '../src/bambu/colors.js';
import { a1External, colorCodes, p2sExternal, tray } from './fixtures/ha.js';
import { filament, goldFilament, goldSpool, spool } from './fixtures/spoolman.js';

const NOW = '2026-10-13T10:00:00.000Z';
const GOLD_UUID = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
const resolve = (identity, spools, filaments = [], extra = {}) =>
  resolveSource({ identity, location: extra.location ?? 'P2S AMS1 Slot 1', inventory: { spools, filaments }, now: NOW, ...extra });

const gold = identityFromTray(tray(1));
const black = identityFromTray(tray(2));
const petgWhite = identityFromTray(a1External);

const blackFil = filament({ id: 2, name: 'Black', colorHex: '000000', bambuId: 'GFA00' });
const petgWhiteFil = filament({ id: 10, name: 'White', material: 'PETG', colorHex: 'FFFFFF', bambuId: 'GFG00' });
const petgIvoryFil = filament({ id: 11, name: 'Ivory', material: 'PETG', colorHex: 'F5F2EA', bambuId: 'GFG00' });
const petgCreamFil = filament({ id: 12, name: 'Cream', material: 'PETG', colorHex: 'F8F0E0', bambuId: 'GFG00' });
const petgBlackFil = filament({ id: 13, name: 'Black', material: 'PETG', colorHex: '000000', bambuId: 'GFG00' });

describe('AMS tray with RFID', () => {
  test('a spool paired before tags existed matches by rfid_uuid; gets the tag linked and its slot location', () => {
    const d = resolve(gold, [goldSpool], [goldFilament]);
    assert.equal(d.status, 'resolved');
    assert.equal(d.via, 'rfid_uuid');
    assert.equal(d.spoolId, 1);
    assert.deepEqual(d.writes, [
      { op: 'patchSpool', spoolId: 1, patch: { location: 'P2S AMS1 Slot 1' } },
      { op: 'linkTag', spoolId: 1, uid: GOLD_UUID, format: 'bambu' },
    ]);
  });

  test('a native tag wins and needs no writes when everything is current', () => {
    const s = spool({ id: 5, filament: goldFilament, firstUsed: NOW, rfid: GOLD_UUID, tags: [GOLD_UUID], location: 'P2S AMS1 Slot 1' });
    const decoy = spool({ id: 6, filament: goldFilament, firstUsed: NOW, rfid: GOLD_UUID });
    assert.deepEqual(resolve(gold, [decoy, s]), { status: 'resolved', via: 'tag', spoolId: 5, writes: [] });
  });

  test('a tagged spool without rfid_uuid gets rfid_uuid written (HA sensor depends on it)', () => {
    const s = spool({ id: 5, filament: goldFilament, firstUsed: NOW, tags: [GOLD_UUID.toLowerCase()], location: 'P2S AMS1 Slot 1' });
    assert.deepEqual(resolve(gold, [s]).writes, [{ op: 'patchSpool', spoolId: 5, patch: {}, extra: { rfid_uuid: GOLD_UUID } }]);
  });

  test('an archived spool holding the tag or rfid_uuid goes to pending', () => {
    const tagged = spool({ id: 5, filament: goldFilament, tags: [GOLD_UUID], archived: true });
    assert.equal(resolve(gold, [tagged]).reason, 'rfid_spool_archived');
    const byField = spool({ id: 6, filament: goldFilament, rfid: GOLD_UUID, archived: true });
    assert.equal(resolve(gold, [byField]).reason, 'rfid_spool_archived');
  });

  test('two spools with the same rfid_uuid go to pending', () => {
    const d = resolve(gold, [goldSpool, spool({ id: 7, filament: goldFilament, rfid: GOLD_UUID })]);
    assert.equal(d.status, 'pending');
    assert.equal(d.reason, 'duplicate_rfid_uuid');
    assert.deepEqual(d.candidates.map((c) => c.spoolId), [1, 7]);
  });

  test('first-time pairing prefers the opened spool of the same filament and color', () => {
    const unopened = spool({ id: 3, filament: blackFil });
    const opened = spool({ id: 4, filament: blackFil, firstUsed: '2026-10-01T00:00:00Z', remaining: 600, location: 'Shelf' });
    const d = resolve(black, [unopened, opened], [], { location: 'P2S AMS1 Slot 2' });
    assert.equal(d.via, 'paired');
    assert.equal(d.spoolId, 4);
    assert.deepEqual(d.writes, [
      { op: 'patchSpool', spoolId: 4, patch: { location: 'P2S AMS1 Slot 2' }, extra: { rfid_uuid: black.trayUuid } },
      { op: 'linkTag', spoolId: 4, uid: black.trayUuid, format: 'bambu' },
    ]);
  });

  test('pairing falls back to the lowest-id unopened spool and sets first_used', () => {
    const d = resolve(black, [spool({ id: 9, filament: blackFil }), spool({ id: 3, filament: blackFil })]);
    assert.equal(d.via, 'paired');
    assert.equal(d.spoolId, 3);
    assert.equal(d.writes[0].patch.first_used, NOW);
  });

  test('pairing with several opened candidates goes to pending', () => {
    const a = spool({ id: 3, filament: blackFil, firstUsed: NOW });
    const b = spool({ id: 4, filament: blackFil, firstUsed: NOW });
    const d = resolve(black, [a, b]);
    assert.equal(d.reason, 'ambiguous_pairing');
    assert.deepEqual(d.candidates.map((c) => c.spoolId), [3, 4]);
  });

  test('spools bound to another RFID, archived, empty or of another color are never paired', () => {
    const spools = [
      spool({ id: 3, filament: blackFil, rfid: 'AAAA' }),
      spool({ id: 4, filament: blackFil, tags: ['BBBB'] }),
      spool({ id: 5, filament: blackFil, archived: true }),
      spool({ id: 6, filament: blackFil, remaining: 0, firstUsed: NOW }),
      spool({ id: 7, filament: goldFilament }),
    ];
    const d = resolve(black, spools, [goldFilament, blackFil]);
    assert.equal(d.status, 'create');
    assert.equal(d.filamentId, 2); // existing Black filament is reused
    assert.equal(d.filamentQuery, null);
  });

  test('an unknown spool is auto-created with remain% x tray_weight', () => {
    const d = resolve(black, [], [], { location: 'P2S AMS1 Slot 2' });
    assert.deepEqual(d, {
      status: 'create',
      via: 'created',
      filamentId: null,
      filamentQuery: {
        filamentId: 'GFA00', colorHex: '000000', colorStore: '000000', material: 'PLA', name: 'Bambu PLA Basic',
        trayWeight: 1000, nozzleTempMin: 190, nozzleTempMax: 230, colorCode: null,
      },
      spool: {
        initial_weight: 1000,
        remaining_weight: 820,
        location: 'P2S AMS1 Slot 2',
        first_used: NOW,
        comment: CREATED_COMMENT,
        extra: { rfid_uuid: '0F1E2D3C4B5A69788796A5B4C3D2E1F0' },
      },
      tagUid: '0F1E2D3C4B5A69788796A5B4C3D2E1F0',
    });
  });
});

describe('external spool (no RFID)', () => {
  const ext = (spools, extra = {}) => resolve(petgWhite, spools, [], { location: 'A1', ...extra });

  test('exactly one opened spool of the filament is used', () => {
    const d = ext([spool({ id: 20, filament: petgWhiteFil, firstUsed: NOW }), spool({ id: 21, filament: petgWhiteFil })]);
    assert.deepEqual(d, {
      status: 'resolved', via: 'matched', spoolId: 20,
      writes: [{ op: 'patchSpool', spoolId: 20, patch: { location: 'A1' } }],
    });
  });

  test('without an opened spool the lowest-id unopened one is opened', () => {
    const d = ext([spool({ id: 22, filament: petgWhiteFil }), spool({ id: 21, filament: petgWhiteFil })]);
    assert.equal(d.via, 'matched_unopened');
    assert.equal(d.spoolId, 21);
    assert.deepEqual(d.writes[0].patch, { location: 'A1', first_used: NOW });
  });

  test('several opened spools go to pending instead of guessing', () => {
    const d = ext([spool({ id: 20, filament: petgWhiteFil, firstUsed: NOW }), spool({ id: 23, filament: petgWhiteFil, firstUsed: NOW })]);
    assert.equal(d.status, 'pending');
    assert.equal(d.reason, 'ambiguous_opened');
    assert.deepEqual(d.candidates.map((c) => c.spoolId), [20, 23]);
    assert.match(d.candidates[0].label, /^#20 · PETG White · 1000 g/);
  });

  test('a spool currently loaded in an AMS is not a candidate for the external holder', () => {
    const inAms = spool({ id: 20, filament: petgWhiteFil, firstUsed: NOW, rfid: 'ABCD' });
    const d = ext([inAms, spool({ id: 24, filament: petgWhiteFil, firstUsed: NOW })], { loadedTrayUuids: ['abcd'] });
    assert.equal(d.spoolId, 24);
  });

  test('nearest color within the same filament id is used when it is unambiguous', () => {
    const d = ext([spool({ id: 30, filament: petgIvoryFil, firstUsed: NOW }), spool({ id: 31, filament: petgBlackFil, firstUsed: NOW })]);
    assert.equal(d.status, 'resolved');
    assert.equal(d.via, 'nearest');
    assert.equal(d.spoolId, 30);
  });

  test('two filaments within the color threshold go to pending', () => {
    const d = ext([spool({ id: 30, filament: petgIvoryFil }), spool({ id: 32, filament: petgCreamFil })]);
    assert.equal(d.reason, 'ambiguous_color');
    assert.deepEqual(d.candidates.map((c) => c.spoolId), [30, 32]);
  });

  test('no match offers same-filament spools ordered by color distance', () => {
    const d = ext([spool({ id: 31, filament: petgBlackFil, firstUsed: NOW })]);
    assert.equal(d.reason, 'no_match');
    assert.deepEqual(d.candidates.map((c) => c.spoolId), [31]);
  });

  test('no match on the filament id falls back to same-material candidates', () => {
    const otherPetg = filament({ id: 14, name: 'HF White', material: 'PETG', colorHex: 'FFFFFF', bambuId: 'GFG02' });
    const d = ext([spool({ id: 40, filament: otherPetg }), goldSpool]);
    assert.equal(d.reason, 'no_match');
    assert.deepEqual(d.candidates.map((c) => c.spoolId), [40]);
  });

  test('an empty external spool goes to pending with no candidates', () => {
    const d = resolve(identityFromTray(p2sExternal), [goldSpool]);
    assert.deepEqual(d, { status: 'pending', reason: 'no_spool_info', candidates: [] });
  });
});

describe('choiceWrites (user picked a spool for a pending source)', () => {
  test('external spool: location, and first_used when it was unopened', () => {
    const s = spool({ id: 21, filament: petgWhiteFil });
    assert.deepEqual(choiceWrites({ spool: s, identity: petgWhite, location: 'A1', now: NOW }), [
      { op: 'patchSpool', spoolId: 21, patch: { location: 'A1', first_used: NOW } },
    ]);
    const opened = spool({ id: 22, filament: petgWhiteFil, firstUsed: NOW, location: 'A1' });
    assert.deepEqual(choiceWrites({ spool: opened, identity: petgWhite, location: 'A1', now: NOW }), []);
  });

  test('RFID tray: the chosen spool is paired so it resolves itself next time', () => {
    const s = spool({ id: 4, filament: blackFil, firstUsed: NOW });
    assert.deepEqual(choiceWrites({ spool: s, identity: black, location: 'P2S AMS1 Slot 2', now: NOW }), [
      { op: 'patchSpool', spoolId: 4, patch: { location: 'P2S AMS1 Slot 2' }, extra: { rfid_uuid: black.trayUuid } },
      { op: 'linkTag', spoolId: 4, uid: black.trayUuid, format: 'bambu' },
    ]);
  });
});

describe('pairing imported spools (colour code, nearest colour, remaining estimate)', () => {
  const table = createColorTable(colorCodes);
  const matte = identityFromTray(tray(3)); // GFA01 #BB3D43, remain 77 % of 1000 g -> code 11202
  // Matte Dark Red imported from elsewhere with a slightly different hex but the right code.
  const importedFil = (extra = {}) =>
    filament({ id: 30, name: 'Matte Dark Red', colorHex: 'B83C42', bambuId: 'GFA01', ...extra });
  const withCode = (f, code) => ({ ...f, extra: { ...f.extra, bambu_color_code: JSON.stringify(code) } });
  const resolveRfid = (spools, extra = {}) =>
    resolveSource({ identity: matte, location: 'P2S AMS1 Slot 3', inventory: { spools, filaments: [] }, now: NOW, colorTable: table, ...extra });

  test('same colour code pairs an imported spool whose hex differs', () => {
    const s = spool({ id: 31, filament: withCode(importedFil(), '11202') });
    const d = resolveRfid([s]);
    assert.equal(d.status, 'resolved');
    assert.equal(d.via, 'paired_code');
    assert.equal(d.spoolId, 31);
    assert.deepEqual(d.writes.map((w) => w.op), ['patchSpool', 'linkTag']);
  });

  test('without the colour table the code step is skipped and the nearest colour still pairs', () => {
    const s = spool({ id: 31, filament: withCode(importedFil(), '11202') });
    const d = resolveRfid([s], { colorTable: null });
    assert.equal(d.via, 'paired_nearest');
  });

  test('nearest colour pairs exactly one close filament and corrects its colour to the RFID value', () => {
    const d = resolveRfid([spool({ id: 31, filament: importedFil() })]);
    assert.equal(d.via, 'paired_nearest');
    assert.deepEqual(d.writes.at(-1), { op: 'patchFilament', filamentId: 30, patch: { color_hex: 'BB3D43' } });
  });

  test('two close filaments are ambiguous: ask instead of guessing or auto-creating', () => {
    const other = filament({ id: 32, name: 'Matte Crimson', colorHex: 'BE3F46', bambuId: 'GFA01' });
    const d = resolveRfid([spool({ id: 31, filament: importedFil() }), spool({ id: 33, filament: other })]);
    assert.equal(d.status, 'pending');
    assert.equal(d.reason, 'ambiguous_pairing_color');
    assert.deepEqual(d.candidates.map((c) => c.spoolId), [31, 33]);
  });

  test('a close filament with a different known colour code is another colour: auto-create instead', () => {
    const d = resolveRfid([spool({ id: 31, filament: withCode(importedFil(), '11299') })]);
    assert.equal(d.status, 'create');
  });

  test('several opened spools of the matched filament: ask', () => {
    const f = withCode(importedFil(), '11202');
    const d = resolveRfid([spool({ id: 31, filament: f, firstUsed: NOW }), spool({ id: 34, filament: f, firstUsed: NOW })]);
    assert.equal(d.reason, 'ambiguous_pairing');
  });

  test('an imported shelf spool is paired, never duplicated by an RFID auto-create', () => {
    const shelf = spool({ id: 31, filament: importedFil(), location: 'Shelf' });
    const d = resolveRfid([shelf]);
    assert.equal(d.status, 'resolved');
    assert.equal(d.spoolId, 31);
    assert.deepEqual(d.writes[0].extra, { rfid_uuid: matte.trayUuid });
  });

  test('intake spool without a weighed weight takes the AMS estimate when paired', () => {
    const s = spool({ id: 31, filament: withCode(importedFil(), '11202'), remaining: 1000 });
    const d = resolveRfid([s], { estimatedSpoolIds: new Set([31]) });
    assert.deepEqual(d.correction, { spoolId: 31, from: 1000, to: 770, remainPct: 77 });
    assert.equal(d.writes[0].patch.remaining_weight, 770);
    assert.equal(d.writes[0].patch.first_used, NOW);
  });

  test('also for an intake spool marked opened (first_used set) but never deducted', () => {
    const s = spool({ id: 31, filament: withCode(importedFil(), '11202'), remaining: 1000, firstUsed: NOW });
    assert.equal(resolveRfid([s], { estimatedSpoolIds: new Set([31]) }).correction.to, 770);
  });

  test('a weighed intake spool keeps its weight: the AMS estimate never overwrites it', () => {
    const s = spool({ id: 31, filament: withCode(importedFil(), '11202'), remaining: 640 });
    const d = resolveRfid([s], { estimatedSpoolIds: new Set() }); // weighed spools are not in the set
    assert.equal(d.correction, undefined);
    assert.equal('remaining_weight' in d.writes[0].patch, false);
  });

  test('no correction at 95 % or more, after a deduction, or when the AMS has no estimate', () => {
    const fresh = () => spool({ id: 31, filament: withCode(importedFil(), '11202'), remaining: 1000 });
    const ids = new Set([31]);
    assert.equal(resolveSource({ identity: { ...matte, remainPct: 95 }, location: 'x', inventory: { spools: [fresh()], filaments: [] }, colorTable: table, estimatedSpoolIds: ids }).correction, undefined);
    assert.equal(resolveSource({ identity: { ...matte, remainPct: null }, location: 'x', inventory: { spools: [fresh()], filaments: [] }, colorTable: table, estimatedSpoolIds: ids }).correction, undefined);
    const used = spool({ id: 31, filament: withCode(importedFil(), '11202'), remaining: 990 });
    assert.equal(resolveRfid([used], { estimatedSpoolIds: ids }).correction, undefined);
  });
});

describe('multi-colour spools', () => {
  const table = createColorTable({
    data: [
      ...colorCodes.data,
      { fila_color_code: '99901', fila_id: 'GFA05', fila_type: 'PLA Silk', fila_color_type: '多拼色', fila_color_name: { en: 'Test Duo' }, fila_color: ['#1F3A93FF', '#C0392BFF'] },
    ],
  });
  // An RFID tray with a two-colour spool: color is the first colour, cols lists both.
  const duo = identityFromTray({ ...tray(3), filament_id: 'GFA05', name: 'Bambu PLA Silk', color: '#1F3A93FF', cols: ['#1F3A93FF', '#C0392BFF'], tray_uuid: 'D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0' });
  const duoFil = { ...filament({ id: 50, name: 'Silk Test Duo', colorHex: null, bambuId: 'GFA05' }), multi_color_hexes: 'C0392B,1F3A93', multi_color_direction: 'coaxial' };
  const duoFilWithCode = { ...duoFil, extra: { ...duoFil.extra, bambu_color_code: '"99901"' } };

  test('an intake spool of a multi-colour filament is paired via its colour code', () => {
    const d = resolveSource({ identity: duo, location: 'P2S AMS1 Slot 3', inventory: { spools: [spool({ id: 51, filament: duoFilWithCode })], filaments: [] }, colorTable: table, now: NOW });
    assert.deepEqual([d.status, d.via, d.spoolId], ['resolved', 'paired', 51]); // first colour matches exactly
  });

  test('an unknown multi-colour spool is auto-created with all its colours on an existing filament', () => {
    const d = resolveSource({ identity: duo, location: 'x', inventory: { spools: [], filaments: [duoFil] }, colorTable: table, now: NOW });
    assert.equal(d.status, 'create');
    assert.equal(d.filamentId, 50); // same filament id and the same set of colours
  });

  test('without a matching filament the RFID query carries the colours and direction', () => {
    const d = resolveSource({ identity: duo, location: 'x', inventory: { spools: [], filaments: [] }, colorTable: table, now: NOW });
    assert.deepEqual([d.filamentQuery.colorCode, d.filamentQuery.colorHexes, d.filamentQuery.colorDirection], ['99901', ['1F3A93', 'C0392B'], 'coaxial']);
    const f = filamentFromRfid(d.filamentQuery, { vendorId: 1 });
    assert.deepEqual([f.color_hex, f.multi_color_hexes, f.multi_color_direction], [null, '1F3A93,C0392B', 'coaxial']);
    assert.deepEqual(f.extra, { bambu_filament_id: 'GFA05', bambu_color_code: '99901' });
  });
});

describe('remembered external-spool answers (aliases)', () => {
  // The A1 reports Generic PETG black; the user said that is Acme PETG Black (filament 60).
  const reported = { ...petgWhite, filamentId: 'GFG99', colorHex: '000000', colorHexes: [], material: 'PETG' };
  const acme = filament({ id: 60, name: 'Black', material: 'PETG', colorHex: '101010', bambuId: 'GFG98' });
  const aliases = new Map([['GFG99|000000', 60]]);
  const resolveExt = (spools, extra = {}) => resolveSource({ identity: reported, location: 'A1', inventory: { spools, filaments: [] }, now: NOW, aliases, ...extra });

  test('the alias resolves after the exact match and before nearest colour', () => {
    const d = resolveExt([spool({ id: 61, filament: acme, firstUsed: NOW })]);
    assert.deepEqual([d.status, d.via, d.spoolId], ['resolved', 'alias', 61]);
  });

  test('an exact match still wins over the alias', () => {
    const exact = filament({ id: 62, name: 'Black', material: 'PETG', colorHex: '000000', bambuId: 'GFG99' });
    const d = resolveExt([spool({ id: 61, filament: acme, firstUsed: NOW }), spool({ id: 63, filament: exact, firstUsed: NOW })]);
    assert.deepEqual([d.via, d.spoolId], ['matched', 63]);
  });

  test('the alias follows the usual spool rules: oldest unopened gets first_used; several opened -> ask', () => {
    const fifo = resolveExt([spool({ id: 65, filament: acme }), spool({ id: 64, filament: acme })]);
    assert.deepEqual([fifo.via, fifo.spoolId, fifo.writes[0].patch.first_used], ['alias_unopened', 64, NOW]);
    const ask = resolveExt([spool({ id: 64, filament: acme, firstUsed: NOW }), spool({ id: 65, filament: acme, firstUsed: NOW })]);
    assert.equal(ask.reason, 'ambiguous_opened');
  });

  test('an alias filament without a usable spool falls through to nearest colour', () => {
    const near = filament({ id: 66, name: 'Jet', material: 'PETG', colorHex: '050505', bambuId: 'GFG99' });
    const d = resolveExt([spool({ id: 61, filament: acme, remaining: 0 }), spool({ id: 67, filament: near, firstUsed: NOW })]);
    assert.deepEqual([d.via, d.spoolId], ['nearest', 67]);
  });

  test('a different reported colour does not use the alias', () => {
    const d = resolveSource({ identity: { ...reported, colorHex: 'FF0000' }, location: 'A1', inventory: { spools: [spool({ id: 61, filament: acme })], filaments: [] }, aliases });
    assert.equal(d.status, 'pending');
  });
});

test('an RFID tray with a translucent colour creates its filament with the alpha', () => {
  const clearTray = identityFromTray({ ...tray(1), filament_id: 'GFG01', type: 'PETG', name: 'Bambu PETG Translucent', color: '#00000000', cols: ['#00000000'] });
  assert.deepEqual([clearTray.colorHex, clearTray.colorStore], ['000000', '00000000']);
  const d = resolveSource({ identity: clearTray, location: 'x', inventory: { spools: [], filaments: [] }, now: NOW });
  assert.equal(filamentFromRfid(d.filamentQuery, { vendorId: 1 }).color_hex, '00000000');
});
