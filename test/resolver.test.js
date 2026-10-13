import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CREATED_COMMENT } from '../src/catalog.js';
import { choiceWrites, resolveSource } from '../src/resolver.js';
import { identityFromTray } from '../src/sources.js';
import { a1External, p2sExternal, tray } from './fixtures/ha.js';
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
        filamentId: 'GFA00', colorHex: '000000', material: 'PLA', name: 'Bambu PLA Basic',
        trayWeight: 1000, nozzleTempMin: 190, nozzleTempMax: 230,
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
