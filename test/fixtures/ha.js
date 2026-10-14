// Home Assistant data captured from a live ha-bambulab setup (P2S + AMS 2 Pro, A1).
// Structure is unchanged; IDs, UUIDs and names are anonymized.

import { readFileSync } from 'node:fs';

const load = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));

export const states = load('./ha-states.json');
export const catalog = load('./catalog.json');
// BambuStudio colour codes, reduced to the five entries reported by the author's own trays.
export const colorCodes = load('./color-codes.json');

export const tray = (n) => states[`sensor.p2s_ams_1_tray_${n}`].attributes;
export const activeTray = states['sensor.p2s_active_tray'].attributes;
export const p2sExternal = states['sensor.p2s_externalspool_external_spool'].attributes;
export const a1External = states['sensor.a1_external_spool_external_spool'].attributes;

const haAttrs = (friendly) => ({ state_class: 'measurement', unit_of_measurement: 'g', device_class: 'weight', friendly_name: friendly });

// print_weight attribute sets seen in the recorder history.
export const printWeight = {
  fourColor: { ...haAttrs('P2S Print weight'), 'AMS 1 Tray 1': 1.02, 'AMS 1 Tray 2': 1.05, 'AMS 1 Tray 3': 0.64, 'AMS 1 Tray 4': 1.45 },
  // failed at 63% (progress fell to 0 five seconds later)
  failedAt63: { ...haAttrs('P2S Print weight'), 'AMS 1 Tray 2': 0.56 },
  // two updates in the same second: slot corrected from Tray 1 to Tray 3
  lateFirst: { ...haAttrs('P2S Print weight'), 'AMS 1 Tray 1': 21.92 },
  lateCorrected: { ...haAttrs('P2S Print weight'), 'AMS 1 Tray 3': 21.92 },
  a1External: { ...haAttrs('A1 Print weight'), 'External Spool': 10.07 },
};
