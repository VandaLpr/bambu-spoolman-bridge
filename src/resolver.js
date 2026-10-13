// Decides which Spoolman spool a print source consumes from. Pure: it reads an inventory
// snapshot and returns a decision plus the Spoolman writes needed to carry it out.
// The executor performs the writes (or logs them in DRY_RUN).
//
// Decisions:
//   { status: 'resolved', via, spoolId, writes }
//   { status: 'create',   via: 'created', filamentId, filamentQuery, spool, tagUid }
//   { status: 'pending',  reason, candidates: [{ spoolId, label }] }
//
// Write ops:
//   { op: 'patchSpool', spoolId, patch, extra }   extra is merged into the spool's existing extra
//   { op: 'linkTag', spoolId, uid, format }

import { CREATED_COMMENT, findExistingFilament } from './catalog.js';
import { deltaE, normalizeHex } from './color.js';
import { readExtra } from './spoolman/extra.js';

const MAX_CANDIDATES = 5;

const upper = (v) => (typeof v === 'string' && v ? v.toUpperCase() : null);
const rfidOf = (spool) => upper(readExtra(spool, 'rfid_uuid'));
const tagUids = (spool) => (spool.tags || []).map((t) => upper(t.uid));
const filamentIdOf = (spool) => readExtra(spool.filament, 'bambu_filament_id');
const colorOf = (spool) => normalizeHex(spool.filament?.color_hex);
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
 */
export function resolveSource({ identity, location, inventory, loadedTrayUuids = [], nearestMaxDeltaE = 20, now }) {
  const ctx = { identity, location, inventory, now: now || new Date().toISOString(), nearestMaxDeltaE };
  ctx.loaded = new Set(loadedTrayUuids.map(upper).filter(Boolean));
  return identity.trayUuid ? resolveRfid(ctx) : resolveByFilament(ctx);
}

function matchesFilament(spool, identity) {
  return Boolean(identity.filamentId) && filamentIdOf(spool) === identity.filamentId && colorOf(spool) === identity.colorHex;
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

  // 3. First-time pairing: an unbound spool of the same filament and color.
  //    Among unopened spools the lowest id wins on purpose: FIFO, oldest stock first.
  const pool = spools.filter((s) => isAvailable(s) && !isRfidBound(s) && matchesFilament(s, identity)).sort(byId);
  const opened = pool.filter(isOpened);
  if (opened.length > 1) return pending('ambiguous_pairing', opened);
  const target = opened[0] || pool[0];
  if (target) {
    const patch = { ...locationPatch(target, location), ...(isOpened(target) ? {} : { first_used: ctx.now }) };
    return {
      status: 'resolved',
      via: 'paired',
      spoolId: target.id,
      writes: [...patchOp(target.id, patch, { rfid_uuid: uid }), linkTagOp(target.id, uid)],
    };
  }

  // 4. Unknown spool: create it, reusing an existing filament when there is one.
  //    The executor runs planFilament() again right before creating, against fresh data.
  const filament = findExistingFilament(inventory.filaments, identity);
  const { trayWeight, remainPct } = identity;
  return {
    status: 'create',
    via: 'created',
    filamentId: filament?.id ?? null,
    filamentQuery: filament ? null : pickQuery(identity),
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

// Writes for a spool the user picked for a pending source: location, first_used when it
// was unopened, and for an RFID tray the pairing (rfid_uuid + tag) so it resolves itself next time.
export function choiceWrites({ spool, identity, location, now = new Date().toISOString() }) {
  const patch = { ...locationPatch(spool, location), ...(isOpened(spool) ? {} : { first_used: now }) };
  const uid = identity.trayUuid;
  if (!uid) return patchOp(spool.id, patch);
  const writes = patchOp(spool.id, patch, rfidOf(spool) === uid ? null : { rfid_uuid: uid });
  if (!tagUids(spool).includes(uid)) writes.push(linkTagOp(spool.id, uid));
  return writes;
}

function pickQuery(identity) {
  const { filamentId, colorHex, material, name, trayWeight, nozzleTempMin, nozzleTempMax } = identity;
  return { filamentId, colorHex, material, name, trayWeight, nozzleTempMin, nozzleTempMax };
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
