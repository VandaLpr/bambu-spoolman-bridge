import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, isSignificant, startTimeDiffers } from '../src/lifecycle.js';

// Feeds a status sequence through decide() the way the tracker does and returns the actions.
function run(statuses, { activeJob = false, lastSignificant = null } = {}) {
  let hasActiveJob = activeJob;
  let last = lastSignificant;
  return statuses.map((status) => {
    const action = decide({ status, lastSignificant: last, hasActiveJob });
    if (action === 'start' || action === 'restart') hasActiveJob = true;
    if (action === 'end') hasActiveJob = false;
    if (isSignificant(status)) last = status;
    return action;
  });
}

test('normal print: finish -> prepare -> running -> finish (P2S)', () => {
  assert.deepEqual(run(['prepare', 'running', 'finish'], { lastSignificant: 'finish' }), ['start', 'continue', 'end']);
});

test('offline mid-print neither ends nor restarts the job (A1)', () => {
  assert.deepEqual(
    run(['prepare', 'running', 'offline', 'running', 'finish', 'offline', 'finish'], { lastSignificant: 'finish' }),
    ['start', 'continue', 'none', 'continue', 'end', 'none', 'none'],
  );
});

test('pause behaves like offline: running -> pause -> running -> finish', () => {
  assert.deepEqual(
    run(['prepare', 'running', 'pause', 'running', 'finish'], { lastSignificant: 'idle' }),
    ['start', 'continue', 'none', 'continue', 'end'],
  );
});

test('failed ends the job once; HA re-emitting failed after its restart does nothing', () => {
  assert.deepEqual(run(['prepare', 'running', 'failed', 'failed', 'offline', 'failed']), ['start', 'continue', 'end', 'none', 'none', 'none']);
});

test('idle -> prepare with a job still open closes it and starts a new one', () => {
  assert.deepEqual(run(['running', 'idle', 'prepare'], { activeJob: true, lastSignificant: 'running' }), ['continue', 'none', 'restart']);
});

test('bridge start with a print running and no open job adopts it', () => {
  assert.deepEqual(run(['running']), ['start']);
});

test('bridge start with an open job and status finish/failed closes the job', () => {
  assert.deepEqual(run(['finish'], { activeJob: true }), ['end']);
  assert.deepEqual(run(['failed'], { activeJob: true }), ['end']);
});

test('bridge start with an open job and the print still running continues it', () => {
  assert.deepEqual(run(['running'], { activeJob: true }), ['continue']);
  assert.deepEqual(run(['pause', 'running'], { activeJob: true }), ['none', 'continue']);
});

test('a different start_time on an open job means a print we never saw end', () => {
  assert.equal(decide({ status: 'running', lastSignificant: null, hasActiveJob: true, startTimeChanged: true }), 'restart');
});

test('startTimeDiffers tolerates the minute-rounded first value and unknowns', () => {
  assert.equal(startTimeDiffers('2026-10-12T22:19:00+00:00', '2026-10-12T22:18:59+00:00', 120), false);
  assert.equal(startTimeDiffers('2026-10-12T22:19:00+00:00', 'unknown', 120), false);
  assert.equal(startTimeDiffers(null, '2026-10-12T22:19:00+00:00', 120), false);
  assert.equal(startTimeDiffers('2026-10-12T22:19:00+00:00', '2026-10-12T22:43:49+00:00', 120), true);
});
