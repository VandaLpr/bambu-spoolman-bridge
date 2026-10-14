// Decides which Spoolman spool a print source consumes from. Pure: it reads an inventory
// snapshot and returns a decision plus the Spoolman writes needed to carry it out.
// The executor performs the writes (or logs them in DRY_RUN).
//
// Decisions:
//   { status: 'resolved', via, spoolId, writes, correction? }
//     correction: { spoolId, from, to, remainPct } when an intake spool took the AMS estimate
//   { status: 'create',   via: 'created', filamentId, filamentQuery, spool, tagUid }
//   { status: 'pending',  reason, candidates: [{ spoolId, label }] }
//
// Write ops:
//   { op: 'patchSpool', spoolId, patch, extra }   extra is merged into the spool's existing extra
//   { op: 'linkTag', spoolId, uid, format }
//   { op: 'patchFilament', filamentId, patch }

import { CREATED_COMMENT, findExistingFilament } from './catalog.js';
import { deltaE, filamentColors, normalizeHex, sameColors } from './color.js';
import { readExtra } from './spoolman/extra.js';

const MAX_CANDIDATES = 5;

const upper = (v) => (typeof v === 'string' && v ? v.toUpperCase() : null);
const rfidOf = (spool) => upper(readExtra(spool, 'rfid_uuid'));
const tagUids = (spool) => (spool.tags || []).map((t) => upper(t.uid));
const filamentIdOf = (spool) => readExtra(spool.filament, 'bambu_filament_id');
const colorCodeOf = (spool) => readExtra(spool.filament, 'bambu_color_code');
// The first colour; for a multi-colour filament that's the first of multi_color_hexes.
const colorOf = (spool) => filamentColors(spool.filament)[0] ?? null;
const isOpened = (spool) => Boolean(spool.first_used);
const isAvailable = (spool) => !spool.archived && (spool.remaining_weight == null || spool.remaining_weight > 0);
const isRfidBound = (spool) => Boolean(rfidOf(spool)) || tagUids(spool).length > 0;
const byId = (a, b) => a.id - b.id;

export function describeSpool(spool) {
  const f = spool.filament || {};
  const parts = [`#${spool.id}`, [f.material, f.name].filter(Boolean).join(' ')];
  if (spool.remaining_weight != null) parts.push(`${Math.round(spool.remaining_weight)} g`);
  if (spool.location) parts.push(spool.location);
  if (!isOpened(spool)) parts.push('unopened');
  return parts.join(' · ');
}

const candidate = (spool, extra = {}) => ({ spoolId: spool.id, label: describeSpool(spool), ...extra });
const pending = (reason, spools) => ({
  status: 'pending',
  reason,
  candidates: spools.slice(0, MAX_CANDIDATES).map((s) => candidate(s)),
});

/**
 * @param {object} p
 * @param {object} p.identity   from identityFromTray()
 * @param {string} p.location   location string for this source
 * @param {object} p.inventory  { spools, filaments } straight from Spoolman (spools incl. archived)
 * @param {string[]} [p.loadedTrayUuids] tray_uuids currently sitting in any AMS
 * @param {number} [p.nearestMaxDeltaE]
 * @param {string} [p.now] ISO timestamp used for first_used
 * @param {object|null} [p.colorTable]  Bambu colour codes (bambu/colors.js); pairing by code needs it
 * @param {Set<number>} [p.estimatedSpoolIds] intake spools imported without a weighed remaining_weight
 * @param {Map<string, number>} [p.aliases] remembered external-spool answers, aliasKey() -> filament id
 */
export function resolveSource({
  identity,
  location,
  inventory,
  loadedTrayUuids = [],
  nearestMaxDeltaE = 20,
  now,
  colorTable = null,
  estimatedSpoolIds = new Set(),
  aliases = new Map(),
}) {
  const ctx = { identity, location, inventory, now: now || new Date().toISOString(), nearestMaxDeltaE, colorTable, estimatedSpoolIds, aliases };
  ctx.loaded = new Set(loadedTrayUuids.map(upper).filter(Boolean));
  return identity.trayUuid ? resolveRfid(ctx) : resolveByFilament(ctx);
}

// Same filament id and colour; a multi-colour tray (several cols) matches on the set of colours.
function matchesFilament(spool, identity) {
  if (!identity.filamentId || filamentIdOf(spool) !== identity.filamentId) return false;
  const many = identity.colorHexes?.length > 1;
  return many ? sameColors(filamentColors(spool.filament), identity.colorHexes) : colorOf(spool) === identity.colorHex;
}

function locationPatch(spool, location) {
  return location && spool.location !== location ? { location } : {};
}

function patchOp(spoolId, patch, extra) {
  if (!Object.keys(patch).length && !(extra && Object.keys(extra).length)) return [];
  return [{ op: 'patchSpool', spoolId, patch, ...(extra ? { extra } : {}) }];
}

const linkTagOp = (spoolId, uid) => ({ op: 'linkTag', spoolId, uid, format: 'bambu' });

function resolveRfid(ctx) {
  const { identity, location, inventory } = ctx;
  const uid = identity.trayUuid;
  const spools = inventory.spools;

  // 1. Native Spoolman tag (uid is unique across Spoolman, so at most one hit).
  const tagged = spools.find((s) => tagUids(s).includes(uid));
  if (tagged) {
    if (tagged.archived) return pending('rfid_spool_archived', [tagged]);
    const extra = rfidOf(tagged) === uid ? null : { rfid_uuid: uid };
    return { status: 'resolved', via: 'tag', spoolId: tagged.id, writes: patchOp(tagged.id, locationPatch(tagged, location), extra) };
  }

  // 2. rfid_uuid extra field (spools paired before tags existed).
  const byRfid = spools.filter((s) => rfidOf(s) === uid).sort(byId);
  if (byRfid.length > 1) return pending('duplicate_rfid_uuid', byRfid);
  if (byRfid.length === 1) {
    const s = byRfid[0];
    if (s.archived) return pending('rfid_spool_archived', [s]);
    return {
      status: 'resolved',
      via: 'rfid_uuid',
      spoolId: s.id,
      writes: [...patchOp(s.id, locationPatch(s, location)), linkTagOp(s.id, uid)],
    };
  }

  // First-time pairing of an unbound spool (e.g. one imported via intake), before any
  // auto-create so a shelf spool is never duplicated.
  const unbound = spools.filter((s) => isAvailable(s) && !isRfidBound(s));

  // 3. Same filament id and exact colour.
  const exact = unbound.filter((s) => matchesFilament(s, identity));
  if (exact.length) return pairWith(ctx, exact, 'paired');

  // 4. Same Bambu colour code: the RFID's (filament id, colour) -> code via BambuStudio's table.
  //    Catches filaments whose color_hex came from elsewhere (e.g. SpoolmanDB).
  const entry = ctx.colorTable?.byFilamentAndHex(identity.filamentId, identity.colorHex, identity.colorHexes) ?? null;
  const code = entry?.code ?? null;
  if (code) {
    const sameCode = unbound.filter((s) => colorCodeOf(s) === code);
    if (sameCode.length) return pairWith(ctx, sameCode, 'paired_code');
  }

  // 5. Nearest colour among unbound spools of the same filament id, only if exactly one
  //    filament is close enough. A filament with a different known colour code is another
  //    colour, however close. The filament's color_hex is corrected to what the RFID reports.
  if (identity.filamentId) {
    const near = unbound.filter(
      (s) =>
        filamentIdOf(s) === identity.filamentId &&
        deltaE(colorOf(s), identity.colorHex) <= ctx.nearestMaxDeltaE &&
        !(code && colorCodeOf(s) && colorCodeOf(s) !== code),
    );
    const filamentIds = new Set(near.map((s) => s.filament.id));
    if (filamentIds.size > 1) return pending('ambiguous_pairing_color', near.sort(byId));
    if (filamentIds.size === 1) {
      const decision = pairWith(ctx, near, 'paired_nearest');
      if (decision.status === 'resolved' && colorOf(near[0]) !== identity.colorHex) {
        decision.writes.push({ op: 'patchFilament', filamentId: near[0].filament.id, patch: { color_hex: identity.colorHex } });
      }
      return decision;
    }
  }

  // 6. Unknown spool: create it, reusing an existing filament when there is one.
  //    The executor runs planFilament() again right before creating, against fresh data.
  const filament = findExistingFilament(inventory.filaments, { ...identity, colorCode: code });
  const { trayWeight, remainPct } = identity;
  return {
    status: 'create',
    via: 'created',
    filamentId: filament?.id ?? null,
    filamentQuery: filament
      ? null
      : {
          ...pickQuery(identity),
          colorCode: code,
          ...(entry?.direction ? { colorHexes: entry.hexes, colorStores: entry.stored, colorDirection: entry.direction } : {}),
        },
    spool: {
      initial_weight: trayWeight ?? undefined,
      remaining_weight: trayWeight && remainPct != null ? Math.round((trayWeight * remainPct) / 100) : undefined,
      location,
      first_used: ctx.now,
      comment: CREATED_COMMENT,
      extra: { rfid_uuid: uid },
    },
    tagUid: uid,
  };
}

// Pairs the RFID tray with one of equivalent unbound spools: the only opened one, or the
// lowest-id unopened one (FIFO, oldest stock first). Several opened = ask.
function pairWith(ctx, pool, via) {
  const { identity, location } = ctx;
  const sorted = [...pool].sort(byId);
  const opened = sorted.filter(isOpened);
  if (opened.length > 1) return pending('ambiguous_pairing', opened);
  const target = opened[0] || sorted[0];
  const uid = identity.trayUuid;
  const correction = remainingCorrection(ctx, target);
  const patch = {
    ...locationPatch(target, location),
    ...(isOpened(target) ? {} : { first_used: ctx.now }),
    ...(correction ? { remaining_weight: correction.to } : {}),
  };
  return {
    status: 'resolved',
    via,
    spoolId: target.id,
    writes: [...patchOp(target.id, patch, { rfid_uuid: uid }), linkTagOp(target.id, uid)],
    ...(correction ? { correction } : {}),
  };
}

// An intake spool imported without a weighed remaining_weight is assumed full. When it is
// paired and the AMS estimates it below 95%, take the estimate. Never for a weighed spool
// and never once anything was deducted from it.
export const ESTIMATE_BELOW_PCT = 95;
function remainingCorrection(ctx, spool) {
  const { identity, estimatedSpoolIds } = ctx;
  if (!estimatedSpoolIds.has(spool.id)) return null;
  if (Math.abs(Number(spool.used_weight) || 0) > 0.01) return null;
  const { remainPct, trayWeight } = identity;
  if (remainPct == null || remainPct >= ESTIMATE_BELOW_PCT || !trayWeight) return null;
  return { spoolId: spool.id, from: spool.remaining_weight, to: Math.round((trayWeight * remainPct) / 100), remainPct };
}

// A spool the user picked for a pending source, as a decision: location, first_used when it
// was unopened, and for an RFID tray the pairing (rfid_uuid + tag) so it resolves itself next
// time, plus the AMS estimate for an intake spool without a weighed weight.
export function choiceDecision({ spool, identity, location, now = new Date().toISOString(), estimatedSpoolIds = new Set() }) {
  const uid = identity.trayUuid;
  const correction = uid ? remainingCorrection({ identity, estimatedSpoolIds }, spool) : null;
  const patch = {
    ...locationPatch(spool, location),
    ...(isOpened(spool) ? {} : { first_used: now }),
    ...(correction ? { remaining_weight: correction.to } : {}),
  };
  let writes;
  if (!uid) writes = patchOp(spool.id, patch);
  else {
    writes = patchOp(spool.id, patch, rfidOf(spool) === uid ? null : { rfid_uuid: uid });
    if (!tagUids(spool).includes(uid)) writes.push(linkTagOp(spool.id, uid));
  }
  return { status: 'resolved', via: 'chosen', spoolId: spool.id, writes, ...(correction ? { correction } : {}) };
}

export const choiceWrites = (args) => choiceDecision(args).writes;

function pickQuery(identity) {
  const { filamentId, colorHex, colorStore, material, name, trayWeight, nozzleTempMin, nozzleTempMax } = identity;
  return { filamentId, colorHex, colorStore, material, name, trayWeight, nozzleTempMin, nozzleTempMax };
}

export const aliasKey = (filamentId, hex) => `${filamentId}|${normalizeHex(hex)}`;

// Spools that can answer a question: available ones; for an RFID tray also unbound (the
// tray's tag will be linked to it).
export function usableSpools(spools, { forRfidTray = false } = {}) {
  return spools.filter((s) => isAvailable(s) && (!forRfidTray || !isRfidBound(s)));
}

/**
 * The spool to use when the user picked a filament: the one opened spool, else the oldest
 * unopened one (FIFO). @returns {{ spool, firstUse } | { ambiguous: spool[] } | null}
 */
export function pickSpoolForFilament(spools, filamentId, { forRfidTray = false } = {}) {
  return pickOpenedOrUnopened(usableSpools(spools, { forRfidTray }).filter((s) => s.filament?.id === filamentId));
}

// One spool from a set of equivalent candidates: the only opened one, or the
// lowest-id unopened one. Lowest id is intentional FIFO: Spoolman ids grow with
// registration, so the oldest stock is opened first. Several opened = ambiguous.
function pickOpenedOrUnopened(spools) {
  const sorted = [...spools].sort(byId);
  const opened = sorted.filter(isOpened);
  if (opened.length > 1) return { ambiguous: opened };
  if (opened.length === 1) return { spool: opened[0], firstUse: false };
  if (sorted.length) return { spool: sorted[0], firstUse: true };
  return null;
}

function resolvedFromPick(ctx, pick, via) {
  const { spool, firstUse } = pick;
  const patch = { ...locationPatch(spool, ctx.location), ...(firstUse ? { first_used: ctx.now } : {}) };
  return { status: 'resolved', via: firstUse ? `${via}_unopened` : via, spoolId: spool.id, writes: patchOp(spool.id, patch) };
}

// External spool (or an AMS tray without RFID): match on bambu_filament_id + color.
function resolveByFilament(ctx) {
  const { identity, inventory, loaded } = ctx;
  if (identity.empty || (!identity.filamentId && !identity.colorHex)) return pending('no_spool_info', []);

  // A spool currently sitting in an AMS slot can't be on the external holder.
  const eligible = inventory.spools.filter(
    (s) => isAvailable(s) && !loaded.has(rfidOf(s)) && !tagUids(s).some((u) => loaded.has(u)),
  );

  const exact = pickOpenedOrUnopened(eligible.filter((s) => matchesFilament(s, identity)));
  if (exact?.ambiguous) return pending('ambiguous_opened', exact.ambiguous);
  if (exact) return resolvedFromPick(ctx, exact, 'matched');

  // A remembered answer: the user once said this reported (filament id, colour) is that
  // filament. Used only while that filament has a usable spool.
  const aliased = ctx.aliases.get(aliasKey(identity.filamentId, identity.colorHex));
  if (aliased !== undefined) {
    const pick = pickOpenedOrUnopened(eligible.filter((s) => s.filament?.id === aliased));
    if (pick?.ambiguous) return pending('ambiguous_opened', pick.ambiguous);
    if (pick) return resolvedFromPick(ctx, pick, 'alias');
  }

  // Nearest color within the same filament id, only when exactly one filament is close enough.
  const sameId = identity.filamentId ? eligible.filter((s) => filamentIdOf(s) === identity.filamentId) : [];
  const withDistance = (list) =>
    list.map((s) => ({ s, d: deltaE(colorOf(s), identity.colorHex) })).sort((a, b) => a.d - b.d || a.s.id - b.s.id);
  const near = withDistance(sameId).filter((x) => x.d <= ctx.nearestMaxDeltaE);
  const nearFilaments = new Set(near.map((x) => x.s.filament.id));
  if (nearFilaments.size === 1) {
    const pick = pickOpenedOrUnopened(near.map((x) => x.s));
    if (pick.ambiguous) return pending('ambiguous_opened', pick.ambiguous);
    return resolvedFromPick(ctx, pick, 'nearest');
  }

  // Give the user the closest options: same filament id first, else same material.
  const fallback = sameId.length
    ? sameId
    : eligible.filter((s) => identity.material && s.filament?.material?.toUpperCase() === identity.material.toUpperCase());
  return pending(nearFilaments.size > 1 ? 'ambiguous_color' : 'no_match', withDistance(fallback).map((x) => x.s));
}
