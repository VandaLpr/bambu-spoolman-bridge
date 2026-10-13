// Spoolman REST client (API v1, checked against v0.27.0). Every write goes through
// write(): in DRY_RUN it is logged with its full body and never sent.

import { encodeExtra } from './extra.js';

export class SpoolmanError extends Error {
  constructor(message, status = null, body = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// POST /spool/{id}/tag returned 409: the uid already belongs to another spool or filament.
export class TagConflictError extends SpoolmanError {
  constructor(uid, body) {
    super(`tag ${uid} is already linked to ${body?.spool_id ? `spool #${body.spool_id}` : `filament #${body?.filament_id}`}`, 409, body);
    this.spoolId = body?.spool_id ?? null;
    this.filamentId = body?.filament_id ?? null;
  }
}

const CATALOG_PAGE = 100;
const CATALOG_MAX_PAGES = 10;

export function createSpoolmanClient({ baseUrl, dryRun, log, timeoutMs = 10_000, fetchImpl = fetch }) {
  const api = `${baseUrl}/api/v1`;

  async function request(method, path, body) {
    let res;
    try {
      res = await fetchImpl(api + path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new SpoolmanError(`${method} ${path} failed: ${e.message}`);
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) throw new SpoolmanError(`${method} ${path} -> HTTP ${res.status}`, res.status, data);
    return data;
  }

  const read = (path) => request('GET', path);

  async function write(method, path, body) {
    if (dryRun) {
      log.info(`[DRY RUN] would ${method} ${path}`, body);
      return null;
    }
    log.info(`${method} ${path}`, body);
    return request(method, path, body);
  }

  const withEncodedExtra = (params) => (params.extra ? { ...params, extra: encodeExtra(params.extra) } : params);

  return {
    dryRun,
    info: () => read('/info'),
    listSpools: () => read('/spool?allow_archived=true'),
    getSpool: (id) => read(`/spool/${id}`),
    listFilaments: () => read('/filament'),
    listVendors: () => read('/vendor'),
    listFields: (entityType) => read(`/field/${entityType}`),

    async searchCatalog(query) {
      const all = [];
      for (let page = 0; page < CATALOG_MAX_PAGES; page++) {
        const params = new URLSearchParams({ query, limit: String(CATALOG_PAGE), offset: String(page * CATALOG_PAGE) });
        const batch = await read(`/external/filament/search?${params}`);
        all.push(...batch);
        if (batch.length < CATALOG_PAGE) break;
      }
      return all;
    },

    createVendor: (params) => write('POST', '/vendor', params),
    createFilament: (params) => write('POST', '/filament', withEncodedExtra(params)),
    createSpool: (params) => write('POST', '/spool', withEncodedExtra(params)),
    useWeight: (spoolId, grams) => write('PUT', `/spool/${spoolId}/use`, { use_weight: grams }),

    // extra is merged into the entity's current extra map (read fresh), so a PATCH can
    // never drop other extra fields, whether Spoolman replaces or merges the map.
    async patchSpool(spoolId, patch = {}, extra = null) {
      const body = { ...patch };
      if (extra) body.extra = { ...(await read(`/spool/${spoolId}`)).extra, ...encodeExtra(extra) };
      if (!Object.keys(body).length) return null;
      return write('PATCH', `/spool/${spoolId}`, body);
    },

    async patchFilamentExtra(filamentId, extra) {
      const current = await read(`/filament/${filamentId}`);
      return write('PATCH', `/filament/${filamentId}`, { extra: { ...current.extra, ...encodeExtra(extra) } });
    },

    async linkTag(spoolId, uid, format = 'bambu') {
      try {
        return await write('POST', `/spool/${spoolId}/tag`, { uid, format });
      } catch (e) {
        if (e.status === 409) throw new TagConflictError(uid, e.body);
        throw e;
      }
    },
  };
}
