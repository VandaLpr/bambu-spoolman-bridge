// Intake: imports spools from order lists into Spoolman (POST /intake).
//
// User-initiated, so independent of DRY_RUN: it runs on its own Spoolman client. DRY_RUN
// keeps governing only the automatic, print-driven writes. apply=false (default) returns the
// plan and writes nothing; apply=true writes, all or nothing: if any item needs input the
// whole batch is rejected.
//
// Items:
//   Bambu:     { bambu_color_code, product_line?, color_name?, form, count, weight?, ... }
//              The colour code is resolved through BambuStudio's table (filament id, product
//              line, colour name, hex). color_hex is only needed for codes not in the table.
//   Non-Bambu: { vendor, material, color_name, color_hex, form, count, profile?, ... }
//              bambu_filament_id is the generic id the printer reports when that material is
//              selected on its screen (e.g. Generic PETG = GFG99); profile picks a variant
//              such as "PLA Silk".
//   Common optional: weight (1000), remaining_weight (weighed), opened, location, price,
//              order_ref, spool_weight (overrides TARE_SPOOL_G / TARE_REFILL_G).
//
// Filaments are resolved local-first, as everywhere: by bambu_color_code, then by
// bambu_filament_id + colour, then a SpoolmanDB import, then create. Idempotent per batch_id.

import { createHash } from 'node:crypto';
import { bambuProfile, genericProfile, genericProfileNames } from './bambu/profiles.js';
import { catalogSearchQuery, filamentFromCatalog, localFilamentForEntry, pickCatalogEntry } from './catalog.js';
import { colorFields, filamentColors, filamentStoredColors, normalizeHex, sameColors, storedHex } from './color.js';
import { readExtra } from './spoolman/extra.js';

const BATCH_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const FORMS = ['spool', 'refill'];
const MAX_ITEMS = 200;
const MAX_COUNT = 100;
const FALLBACK_DENSITY = 1.24; // only affects Spoolman's length figures

const lower = (v) => String(v ?? '').trim().toLowerCase();
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export class IntakeError extends Error {
  constructor(status, message, body = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// Stable hash of the items: the same batch_id with different content is a conflict.
export function contentHash(items) {
  const canonical = (v) =>
    Array.isArray(v)
      ? `[${v.map(canonical).join(',')}]`
      : v && typeof v === 'object'
        ? `{${Object.keys(v)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
            .join(',')}}`
        : JSON.stringify(v);
  return createHash('sha256').update(canonical(items)).digest('hex');
}

// Marker in the spool comment, so a spool created just before a crash is adopted on resume.
export const unitMarker = (batchId, itemIndex, unitIndex) => `[intake ${batchId} #${itemIndex}.${unitIndex}]`;

function readItem(raw, index) {
  const item = { index, problems: [], warnings: [] };
  const need = (msg) => item.problems.push(msg);
  if (!raw || typeof raw !== 'object') {
    need('item must be an object');
    return item;
  }
  item.kind = raw.bambu_color_code !== undefined && raw.bambu_color_code !== null && raw.bambu_color_code !== '' ? 'bambu' : 'other';

  item.form = raw.form;
  if (!FORMS.includes(raw.form)) need(`form must be "spool" or "refill"`);
  item.count = raw.count ?? 1;
  if (!Number.isInteger(item.count) || item.count < 1 || item.count > MAX_COUNT) need(`count must be an integer 1..${MAX_COUNT}`);
  item.weight = raw.weight ?? 1000;
  if (!isNum(item.weight) || item.weight <= 0) need('weight must be a positive number of grams');
  item.remainingWeight = raw.remaining_weight ?? null;
  if (item.remainingWeight !== null && (!isNum(item.remainingWeight) || item.remainingWeight < 0 || item.remainingWeight > item.weight)) {
    need('remaining_weight must be between 0 and weight');
  }
  item.opened = raw.opened === true;
  item.location = raw.location ?? null;
  if (item.location !== null && (typeof item.location !== 'string' || item.location.length > 64)) need('location must be text, at most 64 characters');
  item.price = raw.price ?? null;
  if (item.price !== null && (!isNum(item.price) || item.price < 0)) need('price must be a non-negative number');
  item.orderRef = raw.order_ref ?? null;
  item.spoolWeight = raw.spool_weight ?? null;
  if (item.spoolWeight !== null && (!isNum(item.spoolWeight) || item.spoolWeight < 0)) need('spool_weight must be a non-negative number');

  item.colorName = raw.color_name ?? null;
  item.colorHex = raw.color_hex === undefined || raw.color_hex === null ? null : normalizeHex(raw.color_hex);
  item.colorStore = item.colorHex ? storedHex(raw.color_hex) : null; // keeps a non-opaque alpha
  if (raw.color_hex != null && !item.colorHex) need(`color_hex "${raw.color_hex}" is not a hex colour`);
  if (item.kind === 'bambu') {
    item.code = String(raw.bambu_color_code).trim();
    item.productLine = raw.product_line ?? null;
  } else {
    item.vendor = typeof raw.vendor === 'string' ? raw.vendor.trim() : '';
    item.material = typeof raw.material === 'string' ? raw.material.trim() : '';
    item.profileName = raw.profile ?? null;
    if (!item.vendor) need('vendor is required for non-Bambu items (or give bambu_color_code)');
    if (!item.material) need('material is required for non-Bambu items');
    if (!item.colorName) need('color_name is required for non-Bambu items');
    if (!item.colorHex && raw.color_hex == null) need('color_hex is required for non-Bambu items');
  }
  return item;
}

// SpoolmanDB style: the product line's variant plus the colour, e.g. PLA Matte + Lilac Purple
// -> "Matte Lilac Purple", PLA Basic + Gold -> "Gold".
function spoolmanName(line, colorName, material) {
  const variant = line
    .split(/\s+/)
    .filter((w) => lower(w) !== lower(material) && lower(w) !== 'basic')
    .join(' ');
  return [variant, colorName].filter(Boolean).join(' ');
}

function bambuTarget(item, colorTable) {
  if (!colorTable) {
    item.problems.push("BambuStudio's colour code table is unavailable (see the log), so colour codes can't be resolved");
    return null;
  }
  const entry = colorTable.byCode(item.code);
  if (!entry) {
    const line = item.productLine ? colorTable.line(item.productLine) : null;
    if (!line) {
      item.problems.push(`colour code ${item.code} is not in BambuStudio's table and the product line is ${item.productLine ? `unknown ("${item.productLine}")` : 'missing'}`);
      return null;
    }
    if (!item.colorHex) {
      item.problems.push(`colour code ${item.code} is not in BambuStudio's table: give color_hex (and color_name)`);
      return null;
    }
    if (!item.colorName) item.problems.push(`colour code ${item.code} is not in BambuStudio's table: give color_name`);
    return withProfile(item, {
      filamentId: line.filamentId,
      code: item.code,
      hex: item.colorHex,
      hexes: [item.colorHex],
      stored: [item.colorStore],
      direction: null,
      line: line.line,
      colorName: item.colorName,
    });
  }
  if (item.productLine && lower(item.productLine) !== lower(entry.line)) {
    item.problems.push(`colour code ${item.code} is ${entry.line} ${entry.name}, not ${item.productLine}`);
    return null;
  }
  if (item.colorName && entry.name && lower(item.colorName) !== lower(entry.name)) {
    item.warnings.push(`colour code ${item.code} is called "${entry.name}" in BambuStudio (given: "${item.colorName}")`);
  }
  if (item.colorHex && item.colorHex !== entry.hex) {
    item.warnings.push(`color_hex ${item.colorHex} ignored: colour code ${item.code} is ${entry.hex}, which is what the RFID reports`);
  }
  return withProfile(item, {
    filamentId: entry.filamentId,
    code: entry.code,
    hex: entry.hex,
    hexes: entry.hexes,
    stored: entry.stored,
    direction: entry.direction,
    line: entry.line,
    colorName: entry.name,
  });
}

function withProfile(item, t) {
  const profile = bambuProfile(t.filamentId);
  if (!profile) item.warnings.push(`no BambuStudio profile for ${t.filamentId}: material from the product line, default density`);
  const material = profile?.material ?? t.line.split(/\s+/)[0];
  return {
    ...t,
    vendorName: 'Bambu Lab',
    material,
    density: profile?.density ?? FALLBACK_DENSITY,
    name: spoolmanName(t.line, t.colorName, material),
  };
}

function otherTarget(item) {
  const wanted = item.profileName ?? item.material;
  const profile = genericProfile(wanted);
  if (!profile) {
    item.problems.push(`no Bambu generic profile "Generic ${wanted}", so the printer can't report it; use profile: one of ${genericProfileNames().join(', ')}`);
    return null;
  }
  if (!item.colorHex) return null;
  return {
    vendorName: item.vendor,
    filamentId: profile.filamentId,
    code: null,
    hex: item.colorHex,
    hexes: [item.colorHex],
    stored: [item.colorStore],
    direction: null,
    line: profile.profile,
    colorName: item.colorName,
    material: profile.material,
    density: profile.density,
    name: item.colorName,
  };
}

const sameVendor = (filament, name) => lower(filament.vendor?.name) === lower(name);

// Local first: colour code, then filament id + colour, then (non-Bambu) vendor + material +
// colour of a filament created by hand without a filament id.
function findLocal(filaments, t) {
  const sorted = [...filaments].sort((a, b) => a.id - b.id);
  const sameAs = (f) => sameColors(filamentColors(f), t.hexes);
  if (t.code) {
    const byCode = sorted.find((f) => readExtra(f, 'bambu_color_code') === t.code);
    if (byCode) return byCode;
  }
  const byId = sorted.find(
    (f) => readExtra(f, 'bambu_filament_id') === t.filamentId && sameAs(f) && (t.code || sameVendor(f, t.vendorName)),
  );
  if (byId) return byId;
  if (!t.code) {
    return (
      sorted.find((f) => !readExtra(f, 'bambu_filament_id') && sameVendor(f, t.vendorName) && lower(f.material) === lower(t.material) && sameAs(f)) ??
      null
    );
  }
  return null;
}

// What an existing filament still needs so the printer can find it: ids and the RFID colour.
function filamentPatch(f, t) {
  const extra = {};
  if (readExtra(f, 'bambu_filament_id') !== t.filamentId) extra.bambu_filament_id = t.filamentId;
  if (t.code && readExtra(f, 'bambu_color_code') !== t.code) extra.bambu_color_code = t.code;
  let patch = {};
  // compared as stored, so a missing alpha (translucent colour) is corrected too
  if (!sameColors(filamentStoredColors(f), t.stored)) {
    patch = colorFields(t.stored, t.direction);
    if (!patch.multi_color_hexes && f.multi_color_hexes) Object.assign(patch, { multi_color_hexes: null, multi_color_direction: null });
  }
  return Object.keys(extra).length || Object.keys(patch).length ? { patch, extra } : null;
}

function pickOtherCatalogEntry(entries, t, weight) {
  let matches = entries.filter(
    (e) =>
      lower(e.manufacturer) === lower(t.vendorName) &&
      lower(e.material) === lower(t.material) &&
      !e.color_hexes?.length &&
      normalizeHex(e.color_hex) === t.hex &&
      Number(e.diameter) === 1.75,
  );
  const sameWeight = matches.filter((e) => Number(e.weight) === weight);
  if (sameWeight.length) matches = sameWeight;
  return matches.length === 1 ? matches[0] : null;
}

/**
 * @param {object} deps
 * @param {object} deps.spoolman  Spoolman client with dryRun=false (intake ignores DRY_RUN)
 * @param {object} deps.store
 * @param {Function} deps.colorTable  () => colour table or null
 * @param {object} deps.config  { tareSpoolG, tareRefillG }
 * @param {object} deps.log
 */
export function createIntake({ spoolman, store, colorTable, config, log, now = () => new Date().toISOString() }) {
  async function plan(request) {
    const { batch_id: batchId = null, items: rawItems } = request ?? {};
    if (batchId !== null && (typeof batchId !== 'string' || !BATCH_ID.test(batchId))) {
      throw new IntakeError(400, 'batch_id must be 1-100 characters of A-Z a-z 0-9 . _ : -');
    }
    if (!Array.isArray(rawItems) || rawItems.length === 0) throw new IntakeError(400, 'items must be a non-empty array');
    if (rawItems.length > MAX_ITEMS) throw new IntakeError(400, `at most ${MAX_ITEMS} items per batch`);

    const [filaments, vendors] = await Promise.all([spoolman.listFilaments(), spoolman.listVendors()]);
    const table = colorTable();
    const catalogCache = new Map();
    const catalog = (query) => {
      if (!catalogCache.has(query)) catalogCache.set(query, spoolman.searchCatalog(query));
      return catalogCache.get(query);
    };
    const plannedFilaments = new Map(); // target key -> item index that plans it

    const items = [];
    for (const [index, raw] of rawItems.entries()) {
      const item = readItem(raw, index);
      const target = item.problems.length ? null : item.kind === 'bambu' ? bambuTarget(item, table) : otherTarget(item);
      const out = { index, kind: item.kind ?? null, problems: item.problems, warnings: item.warnings };
      if (target && !item.problems.length) {
        out.target = { filament_id: target.filamentId, color_code: target.code, color_hex: target.hex, line: target.line, color: target.colorName };
        if (target.hexes.length > 1) Object.assign(out.target, { color_hexes: target.hexes, direction: target.direction });
        if (target.stored.some((h) => h.length === 8)) out.target.color_stored = target.stored;
        out.filament = await planFilamentFor(target, item, { filaments, vendors, catalog, plannedFilaments });
        out.spools = planSpools(item, batchId);
      }
      out.status = out.problems.length ? 'needs_input' : 'ready';
      items.push(out);
    }

    const ready = items.filter((i) => i.status === 'ready');
    const count = (action) => ready.filter((i) => i.filament.action === action).length;
    return {
      batch_id: batchId,
      status: items.some((i) => i.status === 'needs_input') ? 'needs_input' : 'ready',
      summary: {
        items: items.length,
        spools: ready.reduce((n, i) => n + i.spools.count, 0),
        filaments: { reuse: count('reuse'), import: count('import'), create: count('create'), same_as_earlier_item: count('same') },
        vendors_to_create: [...new Set(ready.filter((i) => i.filament.vendor?.action === 'create').map((i) => i.filament.vendor.name))],
      },
      items,
    };
  }

  async function planFilamentFor(t, item, { filaments, vendors, catalog, plannedFilaments }) {
    const key = t.code ? `code:${t.code}` : `${lower(t.vendorName)}|${t.filamentId}|${t.hex}`;
    if (plannedFilaments.has(key)) return { action: 'same', as_item: plannedFilaments.get(key), name: t.name };

    const local = findLocal(filaments, t);
    if (local) {
      plannedFilaments.set(key, item.index);
      const p = filamentPatch(local, t);
      return { action: 'reuse', id: local.id, name: local.name, vendor: { action: 'reuse', name: local.vendor?.name ?? null }, ...(p ? { update: p } : {}) };
    }

    const vendor = vendors.find((v) => lower(v.name) === lower(t.vendorName));
    const vendorPlan = vendor ? { action: 'reuse', id: vendor.id, name: vendor.name } : { action: 'create', name: t.vendorName };
    const extra = { bambu_filament_id: t.filamentId, ...(t.code ? { bambu_color_code: t.code } : {}) };

    const entries = await catalog(t.code ? catalogSearchQuery({ material: t.material }) : `${t.vendorName} ${t.material}`);
    const entry = t.code
      ? pickCatalogEntry(entries, { material: t.material, colorHex: t.hex, colorHexes: t.hexes, name: `Bambu ${t.line}`, trayWeight: item.weight })
      : pickOtherCatalogEntry(entries, t, item.weight);
    if (entry) {
      const imported = filaments.find((f) => f.external_id === entry.id);
      if (imported) {
        plannedFilaments.set(key, item.index);
        const p = filamentPatch(imported, t);
        return { action: 'reuse', id: imported.id, name: imported.name, vendor: { action: 'reuse', name: imported.vendor?.name ?? null }, ...(p ? { update: p } : {}) };
      }
      plannedFilaments.set(key, item.index);
      // BambuStudio's colours win: that's what the RFID reports.
      const params = { ...filamentFromCatalog(entry, { vendorId: vendor?.id ?? null, bambuFilamentId: t.filamentId }), ...colorFields(t.stored, t.direction), extra };
      return { action: 'import', external_id: entry.id, name: entry.name, vendor: vendorPlan, params };
    }

    plannedFilaments.set(key, item.index);
    const params = {
      name: t.name,
      vendor_id: vendor?.id ?? null,
      material: t.material,
      density: t.density,
      diameter: 1.75,
      weight: item.weight,
      ...colorFields(t.stored, t.direction),
      extra,
    };
    return { action: 'create', name: t.name, vendor: vendorPlan, params };
  }

  function planSpools(item, batchId) {
    const tare = item.spoolWeight ?? (item.form === 'refill' ? config.tareRefillG : config.tareSpoolG);
    const comment = [item.orderRef ? `order ${item.orderRef}` : null, unitMarker(batchId ?? '<batch_id>', item.index, '<n>')].filter(Boolean).join(' ');
    return {
      count: item.count,
      weighed: item.remainingWeight !== null,
      params: {
        initial_weight: item.weight,
        ...(item.remainingWeight !== null ? { remaining_weight: item.remainingWeight } : {}),
        ...(tare !== null && tare !== undefined ? { spool_weight: tare } : {}),
        ...(item.opened ? { first_used: '<now>' } : {}),
        ...(item.location ? { location: item.location } : {}),
        ...(item.price !== null ? { price: item.price } : {}),
        comment,
      },
    };
  }

  // Creates or updates the planned filament for real; re-checks local filaments first so
  // nothing created since the plan (or by an earlier item) is duplicated.
  async function realizeFilament(planned, item, state) {
    if (planned.action === 'same') return state.filamentIdByItem.get(planned.as_item);
    if (planned.action === 'reuse') {
      if (planned.update) {
        if (Object.keys(planned.update.patch).length) await spoolman.patchFilament(planned.id, planned.update.patch);
        if (Object.keys(planned.update.extra).length) await spoolman.patchFilamentExtra(planned.id, planned.update.extra);
      }
      return planned.id;
    }
    const t = item.target;
    const again = findLocal(state.filaments, {
      filamentId: t.filament_id,
      code: t.color_code,
      hexes: t.color_hexes ?? [t.color_hex],
      vendorName: planned.vendor.name,
      material: planned.params.material,
    });
    if (again) return again.id;
    const vendorId = await realizeVendor(planned.vendor, state);
    const created = await spoolman.createFilament({ ...planned.params, vendor_id: vendorId });
    state.filaments.push(created);
    log.info(`intake: ${planned.action === 'import' ? `imported ${planned.external_id}` : `created filament "${planned.name}"`} as #${created.id}`);
    return created.id;
  }

  async function realizeVendor(vendorPlan, state) {
    if (vendorPlan.action === 'reuse') return vendorPlan.id ?? state.vendors.find((v) => lower(v.name) === lower(vendorPlan.name))?.id ?? null;
    const existing = state.vendors.find((v) => lower(v.name) === lower(vendorPlan.name));
    if (existing) return existing.id;
    const created = await spoolman.createVendor({ name: vendorPlan.name });
    state.vendors.push(created);
    log.info(`intake: created vendor "${vendorPlan.name}" as #${created.id}`);
    return created.id;
  }

  async function apply(request) {
    const batchId = request?.batch_id;
    if (!batchId) throw new IntakeError(400, 'batch_id is required to apply');
    const hash = contentHash(request.items);
    const existing = store.getIntakeBatch(batchId);
    if (existing && existing.content_hash !== hash) {
      throw new IntakeError(409, `batch_id "${batchId}" was already used for different items`);
    }
    if (existing?.state === 'applied') return applied(batchId, 'already_applied', request.items.length);

    const planned = await plan(request);
    if (planned.status === 'needs_input') throw new IntakeError(422, 'some items need input; nothing was written', planned);

    store.beginIntakeBatch(batchId, hash);
    const done = new Set(store.intakeSpools(batchId).map((r) => `${r.item_index}.${r.unit_index}`));
    const [filaments, vendors, spools] = await Promise.all([spoolman.listFilaments(), spoolman.listVendors(), spoolman.listSpools()]);
    const state = { filaments, vendors, filamentIdByItem: new Map() };
    const stamp = now();

    for (const item of planned.items) {
      const filamentId = await realizeFilament(item.filament, item, state);
      state.filamentIdByItem.set(item.index, filamentId);
      for (let unit = 0; unit < item.spools.count; unit++) {
        if (done.has(`${item.index}.${unit}`)) continue;
        const marker = unitMarker(batchId, item.index, unit);
        let spool = spools.find((s) => s.comment?.includes(marker));
        if (!spool) {
          const params = { ...item.spools.params, filament_id: filamentId, comment: item.spools.params.comment.replace(unitMarker(batchId, item.index, '<n>'), marker) };
          if (params.first_used) params.first_used = stamp;
          spool = await spoolman.createSpool(params);
          log.info(`intake ${batchId}: item ${item.index} unit ${unit} -> spool #${spool.id}`);
        } else {
          log.info(`intake ${batchId}: item ${item.index} unit ${unit} already in Spoolman as spool #${spool.id} (adopted)`);
        }
        store.recordIntakeSpool({ batchId, itemIndex: item.index, unitIndex: unit, spoolId: spool.id, weighed: item.spools.weighed });
      }
    }
    store.finishIntakeBatch(batchId);
    return applied(batchId, 'applied', planned.items.length);
  }

  function applied(batchId, status, itemCount) {
    const rows = store.intakeSpools(batchId);
    const items = Array.from({ length: itemCount }, (_, index) => ({
      index,
      spool_ids: rows.filter((r) => r.item_index === index).map((r) => r.spool_id),
    }));
    return { batch_id: batchId, status, spool_ids: rows.map((r) => r.spool_id), items };
  }

  /**
   * "Add from SpoolmanDB" on the pending page: one new spool of a catalog entry. Its filament
   * is reused when Spoolman has it (colour code, filament id + colours, or external_id) and
   * imported otherwise. bambuFilamentId is what the printer reported, so it finds the filament.
   * User-initiated like intake, so independent of DRY_RUN.
   * @param {string} query  the search that listed the entry (the catalog has no lookup by id)
   */
  async function addCatalogSpool({ query, externalId, bambuFilamentId = null }) {
    const entry = (await spoolman.searchCatalog(query, { max: 100 })).find((e) => e.id === externalId);
    if (!entry) throw new IntakeError(404, `SpoolmanDB entry ${externalId} not found for "${query}"`);
    const [filaments, vendors] = await Promise.all([spoolman.listFilaments(), spoolman.listVendors()]);
    const local = localFilamentForEntry(filaments, entry, { bambuFilamentId, colorTable: colorTable() });
    const code = local.colorCode;
    let filament = local.filament;
    if (filament) {
      const extra = {};
      if (bambuFilamentId && !readExtra(filament, 'bambu_filament_id')) extra.bambu_filament_id = bambuFilamentId;
      if (code && !readExtra(filament, 'bambu_color_code')) extra.bambu_color_code = code;
      if (Object.keys(extra).length) await spoolman.patchFilamentExtra(filament.id, extra);
    } else {
      const vendor = vendors.find((v) => lower(v.name) === lower(entry.manufacturer));
      const vendorId = await realizeVendor(vendor ? { action: 'reuse', id: vendor.id } : { action: 'create', name: entry.manufacturer }, { vendors });
      const params = filamentFromCatalog(entry, { vendorId, bambuFilamentId });
      if (code) params.extra.bambu_color_code = code;
      filament = await spoolman.createFilament(params);
      log.info(`pending page: imported ${entry.id} as filament #${filament.id}`);
    }
    const spool = await spoolman.createSpool({
      filament_id: filament.id,
      initial_weight: entry.weight,
      ...(entry.spool_weight != null ? { spool_weight: entry.spool_weight } : {}),
      comment: `added from the bridge (SpoolmanDB ${entry.id})`,
    });
    log.info(`pending page: new spool #${spool.id} of filament #${filament.id}`);
    return { spoolId: spool.id, filamentId: filament.id, filamentName: filament.name };
  }

  /**
   * "+ New spool" on the pending page: one more spool of a filament Spoolman already has,
   * e.g. when its only spool is tied to another RFID tag. User-initiated, like intake.
   */
  async function addFilamentSpool({ filamentId }) {
    const filament = (await spoolman.listFilaments()).find((f) => f.id === filamentId);
    if (!filament) throw new IntakeError(404, `filament #${filamentId} not found in Spoolman`);
    const spool = await spoolman.createSpool({
      filament_id: filament.id,
      ...(filament.weight != null ? { initial_weight: filament.weight } : {}),
      ...(filament.spool_weight != null ? { spool_weight: filament.spool_weight } : {}),
      comment: 'added from the bridge',
    });
    log.info(`pending page: new spool #${spool.id} of filament #${filament.id}`);
    return { spoolId: spool.id, filamentId: filament.id, filamentName: filament.name };
  }

  return { plan, apply, addCatalogSpool, addFilamentSpool };
}
