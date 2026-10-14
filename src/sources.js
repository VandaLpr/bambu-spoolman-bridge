// Pure parsing of ha-bambulab entity data into filament sources and spool identities.

import { normalizeHex } from './color.js';

const AMS_KEY = /^AMS (\d+) Tray (\d+)$/;
const EXTERNAL_KEY = /^External Spool$/i;
// Attributes HA adds to every sensor; anything else unrecognised gets reported.
const HA_ATTRIBUTES = new Set(['state_class', 'unit_of_measurement', 'device_class', 'friendly_name', 'icon']);

// print_weight attributes -> [{ sourceKey, kind, unit, slot, grams }] plus unknown keys.
export function parsePrintWeight(attributes = {}) {
  const sources = [];
  const unknown = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (HA_ATTRIBUTES.has(key)) continue;
    const grams = Number(value);
    const ams = AMS_KEY.exec(key);
    if (ams) {
      if (grams > 0) sources.push({ sourceKey: key, kind: 'ams', unit: Number(ams[1]), slot: Number(ams[2]), grams });
    } else if (EXTERNAL_KEY.test(key)) {
      if (grams > 0) sources.push({ sourceKey: key, kind: 'external', unit: null, slot: null, grams });
    } else {
      unknown.push(key);
    }
  }
  sources.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
  return { sources, unknown };
}

// The print_weight key of the tray feeding the nozzle, or null when it isn't an AMS tray.
// ha-bambulab's ams_index and tray_index are 0-based.
export function activeTrayKey(attributes = {}) {
  const { ams_index: ams, tray_index: tray } = attributes;
  if (!Number.isInteger(ams) || !Number.isInteger(tray)) return null;
  if (ams < 0 || ams > 63 || tray < 0 || tray > 3) return null;
  return `AMS ${ams + 1} Tray ${tray + 1}`;
}

export function isZeroId(value) {
  return typeof value !== 'string' || /^0*$/.test(value);
}

// AMS tray / external spool entity attributes -> identity used by the resolver.
export function identityFromTray(attributes = {}) {
  const remain = Number(attributes.remain);
  const trayWeight = Number(attributes.tray_weight);
  const material = attributes.type && attributes.type !== '?' ? attributes.type : null;
  return {
    trayUuid: isZeroId(attributes.tray_uuid) ? null : attributes.tray_uuid.toUpperCase(),
    filamentId: attributes.filament_id || null,
    colorHex: normalizeHex(attributes.color),
    // every colour of a multi-colour spool (ha-bambulab's cols); one entry otherwise
    colorHexes: (attributes.cols || []).map(normalizeHex).filter(Boolean),
    material,
    name: attributes.name && attributes.name !== '?' ? attributes.name : null,
    remainPct: attributes.remain_enabled && remain >= 0 ? remain : null,
    trayWeight: trayWeight > 0 ? trayWeight : null,
    nozzleTempMin: Number(attributes.nozzle_temp_min) || null,
    nozzleTempMax: Number(attributes.nozzle_temp_max) || null,
    empty: attributes.empty === true || (!material && !attributes.filament_id),
  };
}

export function formatLocation(printer, source) {
  if (source.kind === 'external') return printer.externalLocation;
  return printer.amsLocation.replaceAll('{unit}', String(source.unit)).replaceAll('{n}', String(source.slot));
}
