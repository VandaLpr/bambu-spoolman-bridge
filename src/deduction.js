// Deduction math: finish uses the full slicer estimate, failed scales it by the
// highest progress seen (progress drops to 0 a few seconds after a failure).

export function round2(n) {
  return Math.round(n * 100) / 100;
}

export function progressFactor(status, maxProgress) {
  if (status === 'finish') return 1;
  if (status === 'failed') return Math.min(Math.max(Number(maxProgress) || 0, 0), 100) / 100;
  throw new Error(`No deduction rule for status "${status}"`);
}

// sources: [{ sourceKey, grams }] -> [{ sourceKey, grams }] with zero results dropped.
export function computeDeductions(sources, status, maxProgress) {
  const factor = progressFactor(status, maxProgress);
  return sources
    .map((s) => ({ sourceKey: s.sourceKey, grams: round2(s.grams * factor) }))
    .filter((d) => d.grams > 0);
}
