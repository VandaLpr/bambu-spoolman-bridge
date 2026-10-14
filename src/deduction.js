// Deduction math: finish uses the full slicer estimate, failed scales it by how far the
// print got. print_progress is gcode progress, not extrusion: the start sequence (heating,
// leveling, calibration, purge) can reach 60-80% on small prints before a layer is printed.
// With current_stage available, a failed print counts only the progress made after the
// stage first became "printing" (the baseline).

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

export function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * @param {'finish'|'failed'} status
 * @param {number} maxProgress  highest print_progress seen during the job
 * @param {object} [stage]
 * @param {boolean} [stage.tracked]   the job followed current_stage
 * @param {number|null} [stage.baseline]  progress when the stage first became "printing"
 */
export function progressFactor(status, maxProgress, { tracked = false, baseline = null } = {}) {
  if (status === 'finish') return 1;
  if (status !== 'failed') throw new Error(`No deduction rule for status "${status}"`);
  const max = clamp(Number(maxProgress) || 0, 0, 100);
  if (!tracked) return max / 100;
  if (baseline === null || baseline === undefined) return 0; // never printed a layer
  const base = clamp(Number(baseline) || 0, 0, 100);
  if (base >= 100) return 0;
  return clamp((max - base) / (100 - base), 0, 1);
}

// sources: [{ sourceKey, grams }] -> [{ sourceKey, grams }] with zero results dropped.
export function computeDeductions(sources, status, maxProgress, stage = {}) {
  const factor = progressFactor(status, maxProgress, stage);
  return sources
    .map((s) => ({ sourceKey: s.sourceKey, grams: round2(s.grams * factor) }))
    .filter((d) => d.grams > 0);
}
