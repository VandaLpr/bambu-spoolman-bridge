// Job lifecycle rules, kept pure so the tracker's status handling is testable.
//
// Statuses that start or continue a job: prepare, running.
// Statuses that end a job: finish, failed.
// idle ends nothing, but a print starting after it is always a new job.
// Everything else (pause, offline, unknown, unavailable, init, slicing) is neutral.

export const ACTIVE = new Set(['prepare', 'running']);
export const TERMINAL = new Set(['finish', 'failed']);
const SIGNIFICANT = new Set([...ACTIVE, ...TERMINAL, 'idle']);

export function isSignificant(status) {
  return SIGNIFICANT.has(status);
}

/**
 * @param {object} p
 * @param {string} p.status            new print_status
 * @param {string|null} p.lastSignificant  last significant status seen (null right after bridge start)
 * @param {boolean} p.hasActiveJob
 * @param {boolean} p.startTimeChanged start_time moved beyond the tolerance from the active job's
 * @returns {'start'|'continue'|'restart'|'end'|'none'}
 *   restart = close the active job as missed_end, then start a new one
 */
export function decide({ status, lastSignificant, hasActiveJob, startTimeChanged = false }) {
  if (ACTIVE.has(status)) {
    if (!hasActiveJob) return 'start';
    if (startTimeChanged) return 'restart';
    if (lastSignificant === 'idle' || TERMINAL.has(lastSignificant)) return 'restart';
    return 'continue';
  }
  if (TERMINAL.has(status)) return hasActiveJob ? 'end' : 'none';
  return 'none';
}

// The progress jump that comes with the first "printing" stage arrives in the same HA update
// but can be stamped a few microseconds later (seen: 47 µs), hence the window.
export const BASELINE_WINDOW_MS = 1000;

/**
 * Failed-print baseline from recorder history: the progress at the first "printing" stage.
 * @param {{state: string, time: number}[]} stageRows     ascending
 * @param {{state: string, time: number}[]} progressRows  ascending
 * @returns {{ printing: boolean, baseline: number|null }}
 */
export function baselineFromHistory(stageRows = [], progressRows = []) {
  const first = stageRows.find((r) => r.state === 'printing');
  if (!first) return { printing: false, baseline: null };
  let baseline = null;
  for (const r of progressRows) {
    if (r.time > first.time + BASELINE_WINDOW_MS) break;
    const n = Number(r.state);
    if (Number.isFinite(n)) baseline = n;
  }
  return { printing: true, baseline };
}

// ISO timestamps more than toleranceSec apart. Unknown values never count as a change,
// because HA reports start_time as unknown after its own restart.
export function startTimeDiffers(a, b, toleranceSec) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return Math.abs(ta - tb) > toleranceSec * 1000;
}
