// Data behind the pending page: which filaments can answer a question, how much stock each
// has, its remembered aliases, and which ones match what the printer reported. Pure.

import { deltaE, filamentColors, sameColors } from './color.js';
import { usableSpools } from './resolver.js';
import { readExtra } from './spoolman/extra.js';

const lower = (v) => String(v ?? '').toLowerCase();

/**
 * What the printer reported for the source a question is about; with the colour table, also
 * the Bambu colour code it corresponds to.
 * @returns {{ filamentId, colorHex, material, name, trayUuid, colorCode } }
 */
export function reportedFor(store, pending, colorTable = null) {
  let r;
  if (pending.kind === 'insert') {
    const i = pending.context?.identity ?? {};
    r = { filamentId: i.filamentId ?? null, colorHex: i.colorHex ?? null, material: i.material ?? null, name: i.name ?? null, trayUuid: pending.tray_uuid };
  } else {
    const s = store.getJobSources(pending.job_id).find((x) => x.source_key === pending.source_key) ?? {};
    r = { filamentId: s.filament_id ?? null, colorHex: s.color_hex ?? null, material: s.material ?? null, name: s.name ?? null, trayUuid: s.tray_uuid ?? null };
  }
  r.colorCode = (r.filamentId && colorTable?.byFilamentAndHex(r.filamentId, r.colorHex)?.code) || null;
  return r;
}

export function stockLabel({ opened, shelf }) {
  return [opened ? `${opened} opened` : null, shelf ? `${shelf} on shelf` : null].filter(Boolean).join(' · ');
}

/**
 * @param {object} p
 * @param {object[]} p.filaments, p.spools  from Spoolman
 * @param {object} p.reported   from reportedFor()
 * @param {object[]} p.aliases  store.listAliases()
 * @param {Set<number>} [p.alsoShow]  filaments to list even without a free spool (search hits)
 * @returns {{ suggested: object[], groups: { material: string, filaments: object[] }[], hidden: number }}
 *   free = 0 on a view: the filament has no spool that can answer this question (it gets
 *   "+ New spool"); such filaments are listed only when they are the exact match, the alias
 *   or in alsoShow. hidden: the filaments not listed.
 */
export function filamentChoices({ filaments, spools, reported, aliases = [], maxDeltaE = 20, alsoShow = new Set() }) {
  const forRfidTray = Boolean(reported.trayUuid);
  const usable = usableSpools(spools, { forRfidTray });
  const available = usableSpools(spools);
  const spoolsOf = new Map();
  for (const s of usable) spoolsOf.set(s.filament?.id, [...(spoolsOf.get(s.filament?.id) ?? []), s]);
  const aliasesOf = new Map();
  for (const a of aliases) aliasesOf.set(a.filament_id, [...(aliasesOf.get(a.filament_id) ?? []), a]);
  const aliased = aliases.find((a) => a.reported_filament_id === reported.filamentId && a.reported_color_hex === reported.colorHex)?.filament_id;

  const reportedColors = reported.colorHex ? [reported.colorHex] : [];
  const views = filaments
    .map((f) => {
      const list = spoolsOf.get(f.id) ?? [];
      const opened = list.filter((s) => s.first_used).length;
      const colors = filamentColors(f);
      const sameId = Boolean(reported.filamentId) && readExtra(f, 'bambu_filament_id') === reported.filamentId;
      const sameCode = Boolean(reported.colorCode) && readExtra(f, 'bambu_color_code') === reported.colorCode;
      return {
        id: f.id,
        name: f.name ?? `Filament #${f.id}`,
        vendor: f.vendor?.name ?? null,
        material: f.material || 'Other',
        colors,
        direction: f.multi_color_direction ?? null,
        opened,
        shelf: list.length - opened,
        free: list.length,
        // RFID question: it has spools, but all are tied to other tags
        boundOnly: forRfidTray && list.length === 0 && available.some((s) => s.filament?.id === f.id),
        // what the printer reported, exactly: same filament id and colour, or same colour code
        exact: sameCode || (sameId && sameColors(colors, reportedColors)),
        aliases: aliasesOf.get(f.id) ?? [],
        isAlias: f.id === aliased,
        sameId,
        distance: reported.colorHex && colors.length ? deltaE(colors[0], reported.colorHex) : Infinity,
      };
    })
    .filter((v) => v.free > 0 || v.exact || v.isAlias || alsoShow.has(v.id));

  // A match is the remembered answer, or a close colour (within the threshold) of the same
  // filament id or material. Other colours of the same line stay in their material group.
  // Order: the exact filament, the alias, same filament id, then by colour distance.
  const sameMaterial = (v) => Boolean(reported.material) && lower(v.material) === lower(reported.material);
  const matches = (v) => v.exact || v.isAlias || ((v.sameId || sameMaterial(v)) && v.distance <= maxDeltaE);
  const suggested = views
    .filter(matches)
    .sort((a, b) => b.exact - a.exact || b.isAlias - a.isAlias || b.sameId - a.sameId || a.distance - b.distance || a.id - b.id);
  const byMaterial = new Map();
  for (const v of views.filter((x) => !matches(x))) byMaterial.set(v.material, [...(byMaterial.get(v.material) ?? []), v]);
  const groups = [...byMaterial.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([material, list]) => ({
      material,
      filaments: list.sort((a, b) => lower(a.vendor).localeCompare(lower(b.vendor)) || lower(a.name).localeCompare(lower(b.name))),
    }));
  return { suggested, groups, hidden: filaments.length - views.length };
}

// Spools of one filament for the second step: opened ones first (several opened is why the
// bridge asks), then unopened by age.
export function spoolChoices({ spools, filamentId, reported }) {
  return usableSpools(spools, { forRfidTray: Boolean(reported.trayUuid) })
    .filter((s) => s.filament?.id === filamentId)
    .sort((a, b) => Boolean(b.first_used) - Boolean(a.first_used) || a.id - b.id);
}
