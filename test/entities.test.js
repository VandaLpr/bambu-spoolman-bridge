import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatReport, missingRequired, resolveEntities } from '../src/ha/entities.js';

const printer = (prefix, entities = {}) => ({ prefix, name: prefix.toUpperCase(), entities });
const states = (ids) => Object.fromEntries(ids.map((id) => [id, { entity_id: id, state: 'x', attributes: {} }]));

// Entity naming as seen on a P2S (no buttons, "externalspool") and an A1.
const live = states([
  'sensor.p2s_print_status', 'sensor.p2s_print_progress', 'sensor.p2s_print_weight', 'sensor.p2s_start_time',
  'sensor.p2s_task_name', 'sensor.p2s_active_tray', 'sensor.p2s_externalspool_external_spool',
  'sensor.p2s_ams_1_tray_1', 'sensor.p2s_ams_1_tray_2', 'sensor.p2s_ams_1_tray_3', 'sensor.p2s_ams_1_tray_4',
  'sensor.p2s_ams_1_humidity',
  'sensor.a1_print_status', 'sensor.a1_print_progress', 'sensor.a1_print_weight', 'sensor.a1_start_time',
  'sensor.a1_task_name', 'sensor.a1_external_spool_external_spool', 'button.a1_force_refresh_data',
]);

test('P2S: AMS trays discovered, external spool found under its P2S name, no refresh button', () => {
  const { ids, report } = resolveEntities(printer('p2s'), live);
  assert.equal(ids.status, 'sensor.p2s_print_status');
  assert.equal(ids.externalSpool, 'sensor.p2s_externalspool_external_spool');
  assert.equal(ids.refreshButton, null);
  assert.deepEqual([...ids.trays], [
    ['AMS 1 Tray 1', 'sensor.p2s_ams_1_tray_1'],
    ['AMS 1 Tray 2', 'sensor.p2s_ams_1_tray_2'],
    ['AMS 1 Tray 3', 'sensor.p2s_ams_1_tray_3'],
    ['AMS 1 Tray 4', 'sensor.p2s_ams_1_tray_4'],
  ]);
  assert.deepEqual(missingRequired(report), []);
});

test('A1: external spool under its A1 name, refresh button found, no AMS', () => {
  const { ids } = resolveEntities(printer('a1'), live);
  assert.equal(ids.externalSpool, 'sensor.a1_external_spool_external_spool');
  assert.equal(ids.refreshButton, 'button.a1_force_refresh_data');
  assert.equal(ids.activeTray, null);
  assert.equal(ids.trays.size, 0);
});

test('a second AMS unit is picked up generically', () => {
  const { ids } = resolveEntities(printer('p2s'), { ...live, ...states(['sensor.p2s_ams_2_tray_3']) });
  assert.equal(ids.trays.get('AMS 2 Tray 3'), 'sensor.p2s_ams_2_tray_3');
});

test('overrides win and missing required entities are reported', () => {
  const { ids, report } = resolveEntities(printer('x1', { status: 'sensor.p2s_print_status' }), live);
  assert.equal(ids.status, 'sensor.p2s_print_status');
  assert.deepEqual(missingRequired(report).map((r) => r.key), ['progress', 'printWeight']);
  const lines = formatReport(report);
  assert.ok(lines.some((l) => l.startsWith('MISS') && l.includes('sensor.x1_print_progress')));
  assert.ok(lines.some((l) => l.startsWith('ok') && l.includes('sensor.p2s_print_status')));
});
