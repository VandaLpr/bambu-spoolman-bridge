// Test doubles: an in-memory Spoolman with the client's interface, a recording notifier,
// a silent logger and a tiny Home Assistant "world" that produces entity maps.

import { encodeExtra } from '../../src/spoolman/extra.js';
import { SpoolmanError, TagConflictError } from '../../src/spoolman/client.js';
import { vendor } from './spoolman.js';

export const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

export const httpError = (status) => new SpoolmanError(`HTTP ${status}`, status, { message: `status ${status}` });

export function createFakeSpoolman({ spools = [], filaments = [], catalog = [], dryRun = false } = {}) {
  const db = { spools: structuredClone(spools), filaments: structuredClone(filaments), vendors: [vendor] };
  const calls = [];
  const failures = new Map();
  let nextId = 1000;

  const fail = (point) => {
    const entry = failures.get(point);
    if (entry) {
      if (--entry.times <= 0) failures.delete(point);
      throw entry.err;
    }
  };
  const spool = (id) => {
    const s = db.spools.find((x) => x.id === id);
    if (!s) throw new SpoolmanError(`GET /spool/${id} -> HTTP 404`, 404);
    return s;
  };
  // In DRY_RUN the real client logs writes and returns null without sending them.
  const write = (name, args, apply) => {
    calls.push([name, ...args]);
    return dryRun ? null : apply();
  };

  return {
    dryRun,
    db,
    calls,
    writes: (name) => calls.filter((c) => c[0] === name),
    /**
     * points: getSpool, useWeight:before (nothing applied), useWeight:after (applied, then error).
     * Default error is a network error (no HTTP status); pass httpError(404) etc. for responses.
     */
    failNext(point, err = new SpoolmanError(`${point} failed`), times = 1) {
      failures.set(point, { err, times });
    },

    info: async () => ({ version: '0.27.0' }),
    listSpools: async () => structuredClone(db.spools),
    getSpool: async (id) => {
      fail('getSpool');
      return structuredClone(spool(id));
    },
    listFilaments: async () => structuredClone(db.filaments),
    listVendors: async () => structuredClone(db.vendors),
    listFields: async () => [],
    searchCatalog: async () => catalog,

    createVendor: async (params) => write('createVendor', [params], () => ({ ...params, id: nextId++ })),
    createFilament: async (params) =>
      write('createFilament', [params], () => {
        const f = { ...params, id: nextId++, vendor, extra: encodeExtra(params.extra || {}) };
        db.filaments.push(f);
        return structuredClone(f);
      }),
    createSpool: async (params) =>
      write('createSpool', [params], () => {
        const filament = db.filaments.find((f) => f.id === params.filament_id);
        const remaining = params.remaining_weight ?? params.initial_weight ?? filament.weight;
        const s = {
          id: nextId++,
          filament,
          first_used: params.first_used ?? null,
          last_used: null,
          remaining_weight: remaining,
          initial_weight: params.initial_weight ?? filament.weight,
          used_weight: (params.initial_weight ?? filament.weight) - remaining,
          location: params.location ?? null,
          comment: params.comment ?? null,
          archived: false,
          extra: encodeExtra(params.extra || {}),
          tags: [],
        };
        db.spools.push(s);
        return structuredClone(s);
      }),
    useWeight: async (id, grams) => {
      fail('useWeight:before');
      return write('useWeight', [id, grams], () => {
        const s = spool(id);
        s.used_weight += grams;
        s.remaining_weight = Math.max(0, Math.round((s.remaining_weight - grams) * 100) / 100);
        fail('useWeight:after');
        return structuredClone(s);
      });
    },
    patchSpool: async (id, patch = {}, extra = null) =>
      write('patchSpool', [id, patch, extra], () => {
        const s = spool(id);
        Object.assign(s, patch);
        if (extra) s.extra = { ...s.extra, ...encodeExtra(extra) };
        return structuredClone(s);
      }),
    patchFilamentExtra: async (id, extra) =>
      write('patchFilamentExtra', [id, extra], () => {
        const f = db.filaments.find((x) => x.id === id);
        f.extra = { ...f.extra, ...encodeExtra(extra) };
        return structuredClone(f);
      }),
    linkTag: async (id, uid, format) => {
      const holder = db.spools.find((s) => s.id !== id && s.tags.some((t) => t.uid === uid.toUpperCase()));
      if (holder && !dryRun) throw new TagConflictError(uid, { message: 'conflict', spool_id: holder.id });
      return write('linkTag', [id, uid, format], () => {
        const s = spool(id);
        if (!s.tags.some((t) => t.uid === uid.toUpperCase())) s.tags.push({ uid: uid.toUpperCase(), format, added: 'now' });
        return { uid, format };
      });
    },
  };
}

export function createRecordingNotifier() {
  const sent = { pending: [], problems: [] };
  return {
    sent,
    pending: async (args) => {
      sent.pending.push(args);
    },
    problem: async (title, message, opts = {}) => {
      sent.problems.push({ title, message, ...opts });
    },
  };
}

// Entity maps for one printer. update() returns a NEW map (the tracker compares objects),
// keeping unchanged entity objects identical, like home-assistant-js-websocket does.
export function createWorld(prefix, initial = {}, initialAt = undefined) {
  let entities = {};
  const id = {
    status: `sensor.${prefix}_print_status`,
    progress: `sensor.${prefix}_print_progress`,
    printWeight: `sensor.${prefix}_print_weight`,
    startTime: `sensor.${prefix}_start_time`,
    taskName: `sensor.${prefix}_task_name`,
    activeTray: `sensor.${prefix}_active_tray`,
    stage: `sensor.${prefix}_current_stage`,
    externalSpool: `sensor.${prefix}_external_spool_external_spool`,
  };
  const tray = (n) => `sensor.${prefix}_ams_1_tray_${n}`;

  // at: optional HA timestamp for every entity in this update (last_changed/last_updated),
  // the way HA stamps entities that change together.
  function update(changes, at = undefined) {
    entities = { ...entities };
    for (const [key, value] of Object.entries(changes)) {
      const entityId = id[key] ?? key;
      const { state = String(value), attributes = {} } = typeof value === 'object' && value !== null ? value : {};
      const stamp = at ? { last_changed: at, last_updated: at } : {};
      entities[entityId] = { entity_id: entityId, state, attributes, ...stamp };
    }
    return entities;
  }
  update(initial, initialAt);
  return { id, tray, update, get: () => entities };
}
