import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRecovery } from '../src/recovery.js';
import { openStore } from '../src/store.js';

test('current == before - grams: the write landed, mark applied', () => {
  assert.equal(classifyRecovery({ remainingBefore: 850, grams: 1.02, currentRemaining: 848.98 }), 'applied');
  assert.equal(classifyRecovery({ remainingBefore: 850, grams: 1.02, currentRemaining: 848.98000001 }), 'applied'); // float noise
});

test('current == before: the write never landed, re-apply', () => {
  assert.equal(classifyRecovery({ remainingBefore: 850, grams: 1.02, currentRemaining: 850 }), 'reapply');
});

test('anything else: uncertain', () => {
  assert.equal(classifyRecovery({ remainingBefore: 850, grams: 1.02, currentRemaining: 840 }), 'uncertain'); // other usage meanwhile
  assert.equal(classifyRecovery({ remainingBefore: 850, grams: 1.02, currentRemaining: 1000 }), 'uncertain'); // weighed / corrected by hand
  assert.equal(classifyRecovery({ remainingBefore: 850, grams: 1.02, currentRemaining: 846.94 }), 'uncertain'); // applied twice
});

test('missing values are uncertain', () => {
  assert.equal(classifyRecovery({ remainingBefore: null, grams: 1.02, currentRemaining: 850 }), 'uncertain');
  assert.equal(classifyRecovery({ remainingBefore: 850, grams: 1.02, currentRemaining: null }), 'uncertain');
});

test('Spoolman clamps at 0: a deduction larger than the remainder lands at 0', () => {
  assert.equal(classifyRecovery({ remainingBefore: 0.2, grams: 0.35, currentRemaining: 0 }), 'applied');
  assert.equal(classifyRecovery({ remainingBefore: 0.2, grams: 0.35, currentRemaining: 0.2 }), 'reapply');
  assert.equal(classifyRecovery({ remainingBefore: 0, grams: 0.35, currentRemaining: 0 }), 'uncertain');
});

test('remaining_before is persisted with the usage row and can be refreshed before a re-apply', () => {
  const store = openStore(':memory:');
  const jobId = store.createJob({ printer: 'p2s', dryRun: false });
  const id = store.recordUsage({
    jobId, printer: 'p2s', sourceKey: 'AMS 1 Tray 1', spoolId: 1, grams: 1.02, status: 'finish',
    remainingBefore: 850, dryRun: false, writeState: 'planned',
  });
  assert.equal(store.getUsage(id).remaining_before, 850);
  store.setUsageState(id, 'planned', { remainingBefore: 849 });
  store.setUsageState(id, 'applied');
  const row = store.getUsage(id);
  assert.equal(row.remaining_before, 849);
  assert.equal(row.write_state, 'applied');
  assert.deepEqual(store.usageByState('planned'), []);
  store.close();
});
