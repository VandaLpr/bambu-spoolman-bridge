// Picks a SpoolmanDB (external catalog) entry for an RFID identity, or builds a
// filament from the RFID data when the catalog has no single unambiguous match.
// SpoolmanDB names Bambu colors plainly ("Gold"), so matching is by vendor,
// material and exact color, narrowed by the variant word in the HA name (Matte, Silk+...).

import { densityFor } from './bambu/profiles.js';
import { colorFields, filamentColors, normalizeHex, sameColors } from './color.js';
import { readExtra } from './spoolman/extra.js';

export const CREATED_COMMENT = 'auto-created from RFID by bridge';
const VENDOR = 'bambu lab';
const VARIANT_WORDS = ['matte', 'silk', 'sparkle', 'metal', 'marble', 'galaxy', 'glow', 'translucent', 'tough', 'hf', 'cf', 'gradient', 'dual', 'wood', 'aero', 'lite', 'pure', 'support'];
// Spoolman requires a density; it only affects length figures, never weights.
const FALLBACK_DENSITY = 1.24;

// "Bambu PLA Matte" + material PLA -> ["matte"]; "Bambu PLA Basic" -> []
export function variantTokens(name, material) {
  let rest = String(name || '').replace(/^bambu(\s+lab)?\s+/i, '');
  if (material) rest = rest.replace(new RegExp(`\\b${material.replace(/[^A-Za-z0-9]/g, '\\$&')}\\b`, 'i'), '');
  return rest
    .toLowerCase()
    .replace(/\+/g, '')
    .split(/\s+/)
    .filter((t) => t && t !== 'basic');
}

function entryText(e) {
  return [e.name, e.finish, e.pattern, e.translucent ? 'translucent' : '', e.glow ? 'glow' : ''].join(' ').toLowerCase();
}

// Dedupe gate. Every path that creates or imports a filament (RFID fallback, intake) must
// check local filaments first: by Bambu colour code (when known), by bambu_filament_id +
// colour, then by SpoolmanDB external_id. Lowest id wins if Spoolman already holds duplicates.
export function findExistingFilament(filaments, { filamentId, colorHex, colorHexes = [], colorCode = null, externalId = null }) {
  const colors = colorHexes.length > 1 ? colorHexes : [normalizeHex(colorHex)].filter(Boolean);
  const sorted = [...filaments].sort((a, b) => a.id - b.id);
  const byCode = colorCode ? sorted.find((f) => readExtra(f, 'bambu_color_code') === colorCode) : undefined;
  if (byCode) return byCode;
  const byBambuId = filamentId
    ? sorted.find((f) => readExtra(f, 'bambu_filament_id') === filamentId && sameColors(filamentColors(f), colors))
    : undefined;
  if (byBambuId) return byBambuId;
  return (externalId && sorted.find((f) => f.external_id === externalId)) || null;
}

/**
 * Decides how to get a filament for an RFID identity, without creating duplicates.
 * @returns {{ use: object, patchExtra?: object } | { import: object, entry: object } | { create: object }}
 *   use     an existing local filament (patchExtra: bambu_filament_id it was missing)
 *   import  FilamentParameters copied from the SpoolmanDB entry
 *   create  FilamentParameters built from RFID data
 */
export function planFilament({ filaments, catalogEntries, query, vendorId }) {
  const existing = findExistingFilament(filaments, query);
  if (existing) return { use: existing };

  const entry = pickCatalogEntry(catalogEntries, query);
  if (entry) {
    const imported = findExistingFilament(filaments, { externalId: entry.id });
    if (imported) {
      // Imported by hand without the Bambu id: reuse it and fill the id in.
      return readExtra(imported, 'bambu_filament_id')
        ? { use: imported }
        : { use: imported, patchExtra: { bambu_filament_id: query.filamentId } };
    }
    const params = filamentFromCatalog(entry, { vendorId, bambuFilamentId: query.filamentId });
    if (query.colorCode) params.extra.bambu_color_code = query.colorCode;
    return { import: params, entry };
  }
  return { create: filamentFromRfid(query, { vendorId }) };
}

export function catalogSearchQuery(query) {
  return ['Bambu Lab', query.material].filter(Boolean).join(' ');
}

/** @returns {object|null} the single matching ExternalFilament entry */
export function pickCatalogEntry(entries, query) {
  // Multi-colour: the set of colours identifies the entry; names like "Midnight Blaze" carry
  // no variant word, so the variant filter below doesn't apply.
  if (query.colorHexes?.length > 1) {
    const multi = entries.filter(
      (e) =>
        e.manufacturer?.toLowerCase() === VENDOR &&
        e.material?.toUpperCase() === query.material?.toUpperCase() &&
        sameColors((e.color_hexes || []).map(normalizeHex).filter(Boolean), query.colorHexes),
    );
    return multi.length === 1 ? multi[0] : null;
  }
  const color = normalizeHex(query.colorHex);
  let matches = entries.filter(
    (e) =>
      e.manufacturer?.toLowerCase() === VENDOR &&
      e.material?.toUpperCase() === query.material?.toUpperCase() &&
      !e.color_hexes?.length &&
      normalizeHex(e.color_hex) === color &&
      Number(e.diameter) === 1.75,
  );
  if (query.trayWeight) {
    const sameWeight = matches.filter((e) => Number(e.weight) === query.trayWeight);
    if (sameWeight.length) matches = sameWeight;
  }
  const tokens = variantTokens(query.name, query.material);
  matches = tokens.length
    ? matches.filter((e) => tokens.every((t) => entryText(e).includes(t)))
    : matches.filter((e) => !e.finish && !e.pattern && !VARIANT_WORDS.some((w) => entryText(e).split(/[^a-z]+/).includes(w)));
  return matches.length === 1 ? matches[0] : null;
}

// FilamentParameters for POST /filament. extra values are plain; the client encodes them.
export function filamentFromCatalog(entry, { vendorId, bambuFilamentId }) {
  return {
    name: entry.name,
    vendor_id: vendorId,
    material: entry.material,
    density: entry.density,
    diameter: entry.diameter,
    weight: entry.weight,
    spool_weight: entry.spool_weight ?? undefined,
    ...colorFields(entry.color_hexes?.length ? entry.color_hexes.map(normalizeHex).filter(Boolean) : [normalizeHex(entry.color_hex)], entry.multi_color_direction ?? null),
    settings_extruder_temp: entry.extruder_temp ?? undefined,
    settings_bed_temp: entry.bed_temp ?? undefined,
    external_id: entry.id,
    extra: { bambu_filament_id: bambuFilamentId },
  };
}

export function filamentFromRfid(query, { vendorId }) {
  const label = String(query.name || query.material || 'Filament').replace(/^bambu(\s+lab)?\s+/i, '');
  return {
    name: `${label} #${query.colorHex}`,
    vendor_id: vendorId,
    material: query.material ?? undefined,
    density: densityFor(query.filamentId) ?? FALLBACK_DENSITY,
    diameter: 1.75,
    weight: query.trayWeight ?? undefined,
    ...(query.colorHexes?.length > 1 && query.colorDirection
      ? colorFields(query.colorHexes, query.colorDirection)
      : { color_hex: query.colorHex ?? undefined }),
    comment: CREATED_COMMENT,
    extra: { bambu_filament_id: query.filamentId, ...(query.colorCode ? { bambu_color_code: query.colorCode } : {}) },
  };
}
