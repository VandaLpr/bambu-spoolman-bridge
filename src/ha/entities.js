// Entity IDs per printer, derived from the ha-bambulab prefix, with the startup report.
// Naming differs between models (P2S: _externalspool_external_spool, A1:
// _external_spool_external_spool), so some keys have several candidates.
// Any key can be overridden per printer via PRINTERS[].entities.

const SPEC = [
  { key: 'status', required: true, candidates: (p) => [`sensor.${p}_print_status`] },
  { key: 'progress', required: true, candidates: (p) => [`sensor.${p}_print_progress`] },
  { key: 'printWeight', required: true, candidates: (p) => [`sensor.${p}_print_weight`] },
  { key: 'startTime', required: false, candidates: (p) => [`sensor.${p}_start_time`] },
  { key: 'taskName', required: false, candidates: (p) => [`sensor.${p}_task_name`] },
  // Only printers with an AMS have it.
  { key: 'activeTray', required: false, quiet: true, candidates: (p) => [`sensor.${p}_active_tray`] },
  {
    key: 'externalSpool',
    required: false,
    candidates: (p) => [`sensor.${p}_externalspool_external_spool`, `sensor.${p}_external_spool_external_spool`],
  },
  // Optional by design: printers without Developer LAN mode expose no buttons.
  { key: 'refreshButton', required: false, quiet: true, candidates: (p) => [`button.${p}_force_refresh_data`] },
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {object} printer  from config.printers
 * @param {object} states   entity_id -> state object (as delivered by subscribeEntities)
 * @returns {{ ids: object, report: object[] }}
 *   ids.trays: Map of print_weight key ("AMS 1 Tray 2") -> entity id
 */
export function resolveEntities(printer, states) {
  const p = printer.prefix;
  const ids = {};
  const report = [];
  for (const { key, required, quiet, candidates } of SPEC) {
    const override = printer.entities[key];
    const list = override ? [override] : candidates(p);
    const found = list.find((id) => states[id]);
    ids[key] = found ?? null;
    report.push({ printer: printer.name, key, entityId: found ?? list.join(' | '), found: Boolean(found), required, quiet: Boolean(quiet) });
  }

  ids.trays = new Map();
  const trayPattern = new RegExp(`^sensor\\.${escape(p)}_ams_(\\d+)_tray_(\\d+)$`);
  for (const id of Object.keys(states).sort()) {
    const m = trayPattern.exec(id);
    if (m) ids.trays.set(`AMS ${Number(m[1])} Tray ${Number(m[2])}`, id);
  }
  report.push({ printer: printer.name, key: 'amsTrays', entityId: `${ids.trays.size} found`, found: true, required: false, quiet: true });
  return { ids, report };
}

export function missingRequired(report) {
  return report.filter((r) => r.required && !r.found);
}

export function formatReport(report) {
  return report.map((r) => `${r.found ? 'ok  ' : r.required ? 'MISS' : r.quiet ? 'none' : 'warn'} ${r.printer.padEnd(8)} ${r.key.padEnd(14)} ${r.entityId}`);
}
