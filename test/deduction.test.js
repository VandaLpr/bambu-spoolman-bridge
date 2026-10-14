import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDeductions, progressFactor, round2 } from '../src/deduction.js';
import { activeTrayKey, formatLocation, identityFromTray, parsePrintWeight } from '../src/sources.js';
import { a1External, activeTray, p2sExternal, printWeight, tray } from './fixtures/ha.js';

const p2s = { name: 'P2S', amsLocation: 'P2S AMS{unit} Slot {n}', externalLocation: 'P2S External' };

test('parsePrintWeight reads every AMS slot of a multi-color print and ignores HA attributes', () => {
  const { sources, unknown } = parsePrintWeight(printWeight.fourColor);
  assert.deepEqual(unknown, []);
  assert.deepEqual(sources.map((s) => [s.sourceKey, s.unit, s.slot, s.grams]), [
    ['AMS 1 Tray 1', 1, 1, 1.02],
    ['AMS 1 Tray 2', 1, 2, 1.05],
    ['AMS 1 Tray 3', 1, 3, 0.64],
    ['AMS 1 Tray 4', 1, 4, 1.45],
  ]);
  assert.equal(round2(sources.reduce((t, s) => t + s.grams, 0)), 4.16); // the sensor state
});

test('parsePrintWeight handles the external spool, further AMS units, zero grams and unknown keys', () => {
  assert.deepEqual(parsePrintWeight(printWeight.a1External).sources, [
    { sourceKey: 'External Spool', kind: 'external', unit: null, slot: null, grams: 10.07 },
  ]);
  const { sources, unknown } = parsePrintWeight({ 'AMS 2 Tray 3': 5, 'AMS 1 Tray 1': 0, 'HT 1': 2 });
  assert.deepEqual(sources.map((s) => [s.sourceKey, s.unit, s.slot]), [['AMS 2 Tray 3', 2, 3]]);
  assert.deepEqual(unknown, ['HT 1']);
});

test('finish deducts the full estimate per source', () => {
  const { sources } = parsePrintWeight(printWeight.fourColor);
  assert.deepEqual(computeDeductions(sources, 'finish', 37), [
    { sourceKey: 'AMS 1 Tray 1', grams: 1.02 },
    { sourceKey: 'AMS 1 Tray 2', grams: 1.05 },
    { sourceKey: 'AMS 1 Tray 3', grams: 0.64 },
    { sourceKey: 'AMS 1 Tray 4', grams: 1.45 },
  ]);
});

test('failed deducts grams x max progress (real print that failed at 63%)', () => {
  const { sources } = parsePrintWeight(printWeight.failedAt63);
  assert.deepEqual(computeDeductions(sources, 'failed', 63), [{ sourceKey: 'AMS 1 Tray 2', grams: 0.35 }]);
});

test('failed scales every source of a multi-color print and drops zero results', () => {
  const { sources } = parsePrintWeight(printWeight.fourColor);
  assert.deepEqual(computeDeductions(sources, 'failed', 50).map((d) => d.grams), [0.51, 0.53, 0.32, 0.73]);
  assert.deepEqual(computeDeductions(sources, 'failed', 0), []);
  assert.deepEqual(computeDeductions(sources, 'failed', 0.2), []); // rounds to 0 g
});

test('progressFactor clamps progress and rejects non-terminal statuses', () => {
  assert.equal(progressFactor('failed', 140), 1);
  assert.equal(progressFactor('failed', -5), 0);
  assert.equal(progressFactor('failed', null), 0);
  assert.throws(() => progressFactor('running', 50));
});

test('activeTrayKey converts 0-based indices to the print_weight key', () => {
  assert.equal(activeTrayKey(activeTray), 'AMS 1 Tray 2'); // ams_index 0, tray_index 1
  assert.equal(activeTrayKey({ ams_index: 255, tray_index: 254 }), null);
  assert.equal(activeTrayKey({}), null);
});

test('identityFromTray reads an RFID tray', () => {
  assert.deepEqual(identityFromTray(tray(1)), {
    trayUuid: 'A1B2C3D4E5F60718293A4B5C6D7E8F90',
    filamentId: 'GFA00',
    colorHex: 'E4BD68',
    colorHexes: ['E4BD68'],
    material: 'PLA',
    name: 'Bambu PLA Basic',
    remainPct: 64,
    trayWeight: 1000,
    nozzleTempMin: 190,
    nozzleTempMax: 230,
    empty: false,
  });
});

test('identityFromTray reads external spools (no RFID)', () => {
  const a1 = identityFromTray(a1External);
  assert.equal(a1.trayUuid, null);
  assert.equal(a1.filamentId, 'GFG00');
  assert.equal(a1.colorHex, 'FFFFFF');
  assert.equal(a1.material, 'PETG');
  assert.equal(a1.remainPct, null);
  assert.equal(a1.trayWeight, null);
  assert.equal(a1.empty, false);

  const empty = identityFromTray(p2sExternal);
  assert.equal(empty.empty, true);
  assert.equal(empty.material, null);
  assert.equal(empty.filamentId, null);
});

test('formatLocation applies the per-printer template', () => {
  assert.equal(formatLocation(p2s, { kind: 'ams', unit: 1, slot: 3 }), 'P2S AMS1 Slot 3');
  assert.equal(formatLocation(p2s, { kind: 'external' }), 'P2S External');
});

test('failed with current_stage: only progress after printing began counts (real 63% failure, baseline 60)', () => {
  const { sources } = parsePrintWeight(printWeight.failedAt63);
  assert.equal(progressFactor('failed', 63, { tracked: true, baseline: 60 }), 0.075);
  assert.deepEqual(computeDeductions(sources, 'failed', 63, { tracked: true, baseline: 60 }), [{ sourceKey: 'AMS 1 Tray 2', grams: 0.04 }]);
});

test('failed with current_stage but never printing deducts nothing (job 5: 66% during bed leveling)', () => {
  assert.equal(progressFactor('failed', 66, { tracked: true, baseline: null }), 0);
  assert.deepEqual(computeDeductions([{ sourceKey: 'External Spool', grams: 0.98 }], 'failed', 66, { tracked: true, baseline: null }), []);
});

test('baseline edge cases; finish ignores the baseline; untracked jobs keep plain progress', () => {
  assert.equal(progressFactor('failed', 50, { tracked: true, baseline: 60 }), 0); // below the baseline
  assert.equal(progressFactor('failed', 100, { tracked: true, baseline: 100 }), 0);
  assert.equal(progressFactor('failed', 80, { tracked: true, baseline: 40 }), 40 / 60);
  assert.equal(progressFactor('finish', 63, { tracked: true, baseline: null }), 1);
  assert.equal(progressFactor('failed', 63, { tracked: false, baseline: 60 }), 0.63);
});
