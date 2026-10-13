// Recovery for usage rows left in 'planned' (the bridge stopped between persisting the
// row and confirming the Spoolman write). Compares the spool's remaining_weight now with
// the value persisted just before the call:
//   current == before - grams  -> the write landed: mark applied
//   current == before          -> it never landed: apply it again
//   anything else              -> something else changed the spool: uncertain, notify

const EPSILON = 0.01; // grams; Spoolman returns floats

const same = (a, b) => Math.abs(a - b) <= EPSILON;

/** @returns {'applied'|'reapply'|'uncertain'} */
export function classifyRecovery({ remainingBefore, grams, currentRemaining }) {
  if (![remainingBefore, grams, currentRemaining].every(Number.isFinite)) return 'uncertain';
  // Spoolman clamps remaining_weight at 0, so a deduction larger than what's left ends at 0.
  const expected = Math.max(remainingBefore - grams, 0);
  // Nothing to tell apart when the spool was already empty.
  if (same(expected, remainingBefore)) return 'uncertain';
  if (same(currentRemaining, expected)) return 'applied';
  if (same(currentRemaining, remainingBefore)) return 'reapply';
  return 'uncertain';
}
