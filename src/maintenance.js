// One-time data corrections, recorded in the store's meta table so each runs once.

import { colorFields, filamentColors, filamentStoredColors, sameColors } from './color.js';
import { readExtra } from './spoolman/extra.js';

export const ALPHA_FIX = 'alpha_fix_v1';

/**
 * Up to 0.3.0 the alpha channel was stripped, so translucent and clear Bambu colours were
 * stored opaque (PETG Translucent Clear 32101 as 000000 instead of 00000000). For every
 * filament whose bambu_color_code maps to a non-opaque colour, restore the alpha, but only
 * when its RGB still matches the table: a colour changed by hand is left alone.
 * Runs once (it is a correction of imported data, so like intake it ignores DRY_RUN);
 * if anything fails it is retried at the next start.
 */
export async function restoreAlpha({ store, spoolman, colorTable, log }) {
  if (store.getMeta(ALPHA_FIX)) return { skipped: true, fixed: [] };
  if (!colorTable) {
    log.warn('alpha correction postponed: colour code table unavailable');
    return { skipped: true, fixed: [] };
  }
  const fixed = [];
  for (const f of await spoolman.listFilaments()) {
    const entry = colorTable.byCode(readExtra(f, 'bambu_color_code'));
    if (!entry || !entry.stored.some((h) => h.length === 8)) continue;
    if (!sameColors(filamentColors(f), entry.hexes)) continue; // changed by hand
    if (sameColors(filamentStoredColors(f), entry.stored)) continue; // already right
    const patch = colorFields(entry.stored, entry.direction);
    await spoolman.patchFilament(f.id, patch);
    log.info(`filament #${f.id} "${f.name}" (colour code ${entry.code}): colour ${filamentStoredColors(f).join(',')} -> ${entry.stored.join(',')}`);
    fixed.push(f.id);
  }
  store.setMeta(ALPHA_FIX, new Date().toISOString());
  if (!fixed.length) log.info('alpha correction: nothing to fix');
  return { skipped: false, fixed };
}
