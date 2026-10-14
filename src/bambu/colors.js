// Bambu colour codes from BambuStudio's filaments_color_codes.json: colour code -> Bambu
// filament id, product line, colour name and RGBA, which is exactly what the RFID reports.
// BambuStudio is AGPL-3.0, so the file is downloaded at runtime (pinned to a git ref and
// cached in DATA_DIR) instead of being vendored into this MIT repository.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeHex, storedHex } from '../color.js';

// bambulab/BambuStudio commit 804d93bb5d (2026-09-22). BAMBU_COLOR_REF overrides it.
export const DEFAULT_COLOR_REF = '804d93bb5de142c48c0dabedba87736ea9553206';

export const colorTableUrl = (ref) =>
  `https://raw.githubusercontent.com/bambulab/BambuStudio/${encodeURIComponent(ref)}/resources/profiles/BBL/filament/filaments_color_codes.json`;

const KINDS = { 单色: 'single', 渐变色: 'gradient', 多拼色: 'multi' };
// Spoolman's multi_color_direction. SpoolmanDB classifies every Bambu gradient it has as
// longitudinal (colour changes along the strand) and every multi-part one as coaxial.
const DIRECTIONS = { gradient: 'longitudinal', multi: 'coaxial' };
const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

function normalize(raw) {
  const hexes = (raw.fila_color || []).map(normalizeHex).filter(Boolean);
  const kind = KINDS[raw.fila_color_type] ?? 'single';
  return {
    code: String(raw.fila_color_code),
    filamentId: raw.fila_id,
    line: raw.fila_type,
    name: raw.fila_color_name?.en ?? null,
    hex: hexes[0] ?? null,
    hexes,
    // as Spoolman should store them: alpha kept when not opaque (translucent and clear colours)
    stored: (raw.fila_color || []).map(storedHex).filter(Boolean),
    kind,
    direction: hexes.length > 1 ? (DIRECTIONS[kind] ?? null) : null,
  };
}

/** @param {{ data: object[] }} raw  the parsed JSON file */
export function createColorTable(raw) {
  if (!Array.isArray(raw?.data)) throw new Error('not a filaments_color_codes.json (no data array)');
  const entries = raw.data.map(normalize).filter((e) => e.code && e.filamentId && e.line);
  const byCode = new Map(entries.map((e) => [e.code, e]));
  const lines = new Map();
  for (const e of entries) if (!lines.has(e.line.toLowerCase())) lines.set(e.line.toLowerCase(), { line: e.line, filamentId: e.filamentId });
  return {
    size: entries.length,
    byCode: (code) => byCode.get(String(code ?? '').trim()) ?? null,
    // The entry an RFID tray corresponds to: its filament id and colour, or all its colours
    // (the tray's cols) for a multi-colour spool.
    byFilamentAndHex(filamentId, hex, hexes = []) {
      const all = hexes.map(normalizeHex).filter(Boolean);
      if (all.length > 1) return entries.find((e) => e.filamentId === filamentId && e.hexes.length > 1 && sameSet(e.hexes, all)) ?? null;
      const h = normalizeHex(hex);
      return entries.find((e) => e.kind === 'single' && e.filamentId === filamentId && e.hex === h) ?? null;
    },
    // "PLA Matte" -> { line: 'PLA Matte', filamentId: 'GFA01' }, case-insensitive.
    line: (name) => lines.get(String(name ?? '').trim().toLowerCase()) ?? null,
    lineNames: () => [...lines.values()].map((l) => l.line).sort(),
  };
}

/**
 * Cached per ref in DATA_DIR; downloaded once. Returns null (and logs) when it can't be had:
 * every feature that needs it then degrades instead of guessing.
 */
export async function loadColorTable({ ref = DEFAULT_COLOR_REF, dataDir, log, fetchImpl = fetch }) {
  const safeRef = ref.replace(/[^A-Za-z0-9._-]/g, '_');
  const file = path.join(dataDir, `bambu-color-codes-${safeRef}.json`);
  try {
    const table = createColorTable(JSON.parse(readFileSync(file, 'utf8')));
    log.info(`Bambu colour codes: ${table.size} entries (cached, ref ${ref})`);
    return table;
  } catch {
    // not cached yet (or unreadable): download
  }
  try {
    const res = await fetchImpl(colorTableUrl(ref), { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const table = createColorTable(JSON.parse(text));
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, text);
    log.info(`Bambu colour codes: ${table.size} entries (downloaded, ref ${ref})`);
    return table;
  } catch (e) {
    log.error(`Bambu colour codes unavailable (ref ${ref}): ${e.message}. Intake of Bambu items and colour-code pairing are disabled.`);
    return null;
  }
}
