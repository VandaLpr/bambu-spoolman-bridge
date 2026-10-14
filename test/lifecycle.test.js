import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baselineFromHistory, decide, isSignificant, startTimeDiffers } from '../src/lifecycle.js';

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

// Rows exactly as HA's history/history_during_period returned them for the real 63% failure
// (P2S, 2026-10-12): progress 60 is stamped 47 µs after "printing".
const stageRows = [
  { state: 'print_calibration_lines', time: 1791845370 * 1000 },
  { state: 'printing', time: 1791845378.902699 * 1000 },
  { state: 'idle', time: 1791845402.8355496 * 1000 },
];
const progressRows = [
  { state: '5', time: 1791845370 * 1000 },
  { state: '60', time: 1791845378.902746 * 1000 },
  { state: '61', time: 1791845382.3259711 * 1000 },
  { state: '63', time: 1791845397.0182295 * 1000 },
];

test('baselineFromHistory takes the progress that arrived with the first "printing"', () => {
  assert.deepEqual(baselineFromHistory(stageRows, progressRows), { printing: true, baseline: 60 });
});

test('baselineFromHistory: never printing, or no progress rows', () => {
  assert.deepEqual(baselineFromHistory(stageRows.filter((r) => r.state !== 'printing'), progressRows), { printing: false, baseline: null });
  assert.deepEqual(baselineFromHistory(stageRows, []), { printing: true, baseline: null });
  assert.deepEqual(baselineFromHistory(undefined, undefined), { printing: false, baseline: null });
});
