import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionId, createNotifier, parseAction } from '../src/notifier.js';
import { silentLog } from './fixtures/fakes.js';

const pending = {
  id: 7,
  source_key: 'External Spool',
  reason: 'ambiguous_opened',
  candidates: [
    { spoolId: 20, label: '#20 · PETG White · 500 g · A1' },
    { spoolId: 21, label: '#21 · PETG White · 800 g' },
    { spoolId: 22, label: '#22 · PETG White · 1000 g · unopened' },
  ],
};
const source = { material: 'PETG', name: 'Bambu PETG Basic', color_hex: 'FFFFFF' };

function capture(opts = {}) {
  const calls = [];
  const ha = { callService: async (...args) => calls.push(args) };
  return { calls, notifier: createNotifier({ ha, service: 'notify.mobile_app_test', dryRun: false, bridgeUrl: 'http://bridge.local:8080', log: silentLog, ...opts }) };
}

test('pending notification: top 2 candidates plus Open bridge, LAN-only hint', async () => {
  const { calls, notifier } = capture();
  await notifier.pending({ pending, printerName: 'A1', taskName: 'Test print', source });
  const [[domain, service, payload]] = calls;
  assert.equal(domain, 'notify');
  assert.equal(service, 'mobile_app_test');
  assert.equal(payload.title, 'Which spool?');
  assert.deepEqual(payload.data.actions, [
    { action: 'BSB_7_20', title: '#20 · PETG White · 500 g · A1' },
    { action: 'BSB_7_21', title: '#21 · PETG White · 800 g' },
    { action: 'URI', title: 'Open bridge', uri: 'http://bridge.local:8080/pending/7' },
  ]);
  assert.match(payload.message, /A1 · "Test print"/);
  assert.match(payload.message, /External Spool \(PETG Bambu PETG Basic #FFFFFF\): several opened spools match/);
  assert.match(payload.message, /only on home Wi-Fi/);
});

test('DRY_RUN prefixes every title', async () => {
  const { calls, notifier } = capture({ dryRun: true });
  await notifier.pending({ pending, printerName: 'A1', taskName: null, source });
  await notifier.problem('Deduction needs a check', 'details');
  assert.deepEqual(calls.map((c) => c[2].title), ['[DRY RUN] Which spool?', '[DRY RUN] Deduction needs a check']);
});

test('without BRIDGE_URL there is no Open bridge button', async () => {
  const { calls, notifier } = capture({ bridgeUrl: null });
  await notifier.pending({ pending, printerName: 'A1', taskName: null, source });
  assert.equal(calls[0][2].data.actions.some((a) => a.action === 'URI'), false);
});

test('a failing notify call is logged, not thrown', async () => {
  const notifier = createNotifier({ ha: { callService: async () => Promise.reject(new Error('nope')) }, service: 'notify.x', dryRun: false, bridgeUrl: null, log: silentLog });
  await notifier.problem('t', 'm');
});

test('action ids round-trip; foreign actions are ignored', () => {
  assert.deepEqual(parseAction(actionId(7, 21)), { pendingId: 7, spoolId: 21 });
  assert.equal(parseAction('URI'), null);
  assert.equal(parseAction('SOME_OTHER_AUTOMATION'), null);
  assert.equal(parseAction(undefined), null);
});
