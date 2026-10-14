// HTTP API for inspection, pending questions, rejected deductions and intake. LAN only, no auth.
// createApp() returns the Express app so more routers (e.g. MCP in phase 2) can be mounted.

import { fileURLToPath } from 'node:url';
import express from 'express';
import { localFilamentForEntry } from './catalog.js';
import { filamentChoices, reportedFor, spoolChoices } from './choices.js';
import { IntakeError } from './intake.js';
import { page, pendingPage, usagePage } from './pages.js';

const ASSETS = fileURLToPath(new URL('../assets/', import.meta.url));
const SEARCH_RESULTS = 20;

const limitOf = (req, def) => Math.min(Math.max(Number.parseInt(req.query.limit, 10) || def, 1), 500);
const int = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) ? n : null;
};
const isForm = (req) => req.is('application/x-www-form-urlencoded');
const notFound = (res, what) => res.status(404).type('html').send(page('Not found', `<p>This ${what} does not exist.</p>`));

/**
 * @param {object} deps
 * @param {Function} deps.resolvePending  (pendingId, { spoolId?, filamentId? }) -> { ok, message, chooseSpool? }
 * @param {object} deps.choices  { inventory(), search(q), colorTable(), addFromCatalog({ pendingId, externalId, q }),
 *   newSpool({ pendingId, filamentId }) }
 */
export function createApp({ store, health, resolvePending, requeueUsage, intake, choices, dryRun, nearestMaxDeltaE = 20 }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  // The bridge's icon (assets/icon.png, icon.svg) for the pages' favicon.
  app.use('/assets', express.static(ASSETS, { maxAge: '7d' }));
  app.get('/favicon.ico', (req, res) => res.type('png').sendFile('icon.png', { root: ASSETS, maxAge: '7d' }));

  app.get('/health', (req, res) => {
    const h = health();
    res.status(h.ok ? 200 : 503).json(h);
  });

  app.get('/jobs', (req, res) => res.json(store.listJobs(limitOf(req, 50))));

  app.get('/jobs/:id', (req, res) => {
    const id = Number(req.params.id);
    const job = store.getJob(id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json({ ...job, sources: store.getJobSources(id), usage: store.usageForJob(id) });
  });

  app.get('/usage', (req, res) => res.json(store.listUsage(limitOf(req, 100))));

  app.get('/pending', (req, res) => res.json(store.listPending(req.query.state || 'open')));

  // Step 1: choose a filament (or search SpoolmanDB, or type a spool id). Step 2 (?filament=)
  // only when that filament has several opened spools.
  app.get('/pending/:id', async (req, res, next) => {
    try {
      const pending = store.getPending(Number(req.params.id));
      if (!pending) return notFound(res, 'question');
      const colorTable = choices.colorTable?.() ?? null;
      const view = { pending, job: pending.job_id ? store.getJob(pending.job_id) : null, reported: reportedFor(store, pending, colorTable), dryRun, notice: req.query.msg };
      if (pending.state !== 'open') return res.type('html').send(pendingPage(view));
      let inventory = null;
      try {
        inventory = await choices.inventory();
      } catch (e) {
        view.error = `Spoolman is unreachable (${e.message}); only a spool id can be entered.`;
      }
      const filamentId = int(req.query.filament);
      if (inventory && filamentId !== null) {
        const filament = inventory.filaments.find((f) => f.id === filamentId);
        if (filament) {
          const listed = filamentChoices({ filaments: [filament], spools: inventory.spools, reported: view.reported });
          const v = listed.suggested[0] ?? listed.groups[0]?.filaments[0] ?? { name: filament.name, colors: [], direction: null };
          view.step2 = { filament: v, spools: spoolChoices({ spools: inventory.spools, filamentId, reported: view.reported }) };
        }
      }
      const q = String(req.query.q ?? '').trim();
      if (q && !view.step2) {
        try {
          view.search = { q, results: (await choices.search(q)).slice(0, SEARCH_RESULTS) };
        } catch (e) {
          view.error = `SpoolmanDB search failed: ${e.message}`;
        }
      }
      if (inventory && !view.step2) {
        // A search hit that is already in the inventory links to that filament's row instead.
        const alsoShow = new Set();
        for (const e of view.search?.results ?? []) {
          const { filament } = localFilamentForEntry(inventory.filaments, e, { bambuFilamentId: view.reported.filamentId, colorTable });
          if (filament) {
            e.inInventory = { id: filament.id, name: filament.name };
            alsoShow.add(filament.id);
          }
        }
        view.choices = filamentChoices({ ...inventory, reported: view.reported, aliases: store.listAliases(), maxDeltaE: nearestMaxDeltaE, alsoShow });
      }
      res.type('html').send(pendingPage(view));
    } catch (e) {
      next(e);
    }
  });

  // Body: { filamentId } | { spoolId } | { skip: true }. HTML forms get a redirect back.
  app.post('/pending/:id/resolve', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const skip = req.body.skip === true || req.body.skip === 'true';
      const answer = { spoolId: int(req.body.spoolId), filamentId: int(req.body.filamentId) };
      if (!skip && answer.spoolId === null && answer.filamentId === null) {
        return res.status(400).json({ ok: false, message: 'filamentId, spoolId or skip is required' });
      }
      const result = await resolvePending(id, skip ? {} : answer);
      if (isForm(req)) {
        const step2 = result.chooseSpool ? `&filament=${answer.filamentId}` : '';
        return res.redirect(303, `/pending/${id}?msg=${encodeURIComponent(result.message)}${step2}`);
      }
      res.status(result.ok ? 200 : 409).json(result);
    } catch (e) {
      next(e);
    }
  });

  // "Add from SpoolmanDB": one new spool of that entry, used to answer the question.
  app.post('/pending/:id/add', async (req, res, next) => {
    const id = Number(req.params.id);
    try {
      const externalId = String(req.body.externalId ?? '');
      const q = String(req.body.q ?? '');
      if (!externalId || !q) return res.status(400).json({ ok: false, message: 'externalId and q are required' });
      const result = await choices.addFromCatalog({ pendingId: id, externalId, q });
      if (isForm(req)) return res.redirect(303, `/pending/${id}?msg=${encodeURIComponent(result.message)}`);
      res.status(result.ok ? 200 : 409).json(result);
    } catch (e) {
      if (!(e instanceof IntakeError)) return next(e);
      if (isForm(req)) return res.redirect(303, `/pending/${id}?msg=${encodeURIComponent(e.message)}`);
      res.status(e.status).json({ ok: false, message: e.message });
    }
  });

  // "+ New spool" of a filament that has no free spool (used up, or all tied to other tags).
  app.post('/pending/:id/new-spool', async (req, res, next) => {
    const id = Number(req.params.id);
    try {
      const filamentId = int(req.body.filamentId);
      if (filamentId === null) return res.status(400).json({ ok: false, message: 'filamentId is required' });
      const result = await choices.newSpool({ pendingId: id, filamentId });
      if (isForm(req)) return res.redirect(303, `/pending/${id}?msg=${encodeURIComponent(result.message)}`);
      res.status(result.ok ? 200 : 409).json(result);
    } catch (e) {
      if (!(e instanceof IntakeError)) return next(e);
      if (isForm(req)) return res.redirect(303, `/pending/${id}?msg=${encodeURIComponent(e.message)}`);
      res.status(e.status).json({ ok: false, message: e.message });
    }
  });

  // Remembered external-spool answers: printer-reported (filament id, colour) -> filament.
  app.get('/aliases', (req, res) => res.json(store.listAliases()));
  app.post('/aliases/remove', (req, res) => {
    const removed = store.deleteAlias(String(req.body.reported_filament_id ?? ''), String(req.body.reported_color_hex ?? ''));
    const back = String(req.body.back ?? '');
    if (isForm(req) && /^\/pending\/\d+$/.test(back)) {
      return res.redirect(303, `${back}?msg=${encodeURIComponent(removed ? 'Printer alias removed.' : 'That alias was already gone.')}`);
    }
    res.status(removed ? 200 : 404).json({ ok: removed });
  });

  app.get('/usage/:id', (req, res) => {
    const row = store.getUsage(Number(req.params.id));
    if (!row) return notFound(res, 'deduction');
    res.type('html').send(usagePage({ row, job: store.getJob(row.job_id), dryRun, notice: req.query.msg }));
  });

  // Only for rows in needs_attention (Spoolman rejected the deduction). Body: { spoolId } | { skip: true }
  app.post('/usage/:id/requeue', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const skip = req.body.skip === true || req.body.skip === 'true';
      const spoolId = skip ? null : int(req.body.spoolId);
      if (!skip && spoolId === null) return res.status(400).json({ ok: false, message: 'spoolId or skip is required' });
      const result = await requeueUsage(id, spoolId);
      if (isForm(req)) return res.redirect(303, `/usage/${id}?msg=${encodeURIComponent(result.message)}`);
      res.status(result.ok ? 200 : 409).json(result);
    } catch (e) {
      next(e);
    }
  });

  // Body: { batch_id, apply: false|true, items: [...] }. Independent of DRY_RUN.
  // 200 plan or result, 400 bad request, 409 batch_id reused for other items,
  // 422 items need input (nothing written), 502 Spoolman failed mid-apply (re-post to resume).
  app.post('/intake', async (req, res) => {
    try {
      const result = req.body?.apply === true ? await intake.apply(req.body) : await intake.plan(req.body);
      res.json(result);
    } catch (e) {
      if (e instanceof IntakeError) return res.status(e.status).json({ error: e.message, ...e.body });
      res.status(502).json({ error: `${e.message}. Re-post the same batch to resume; nothing is created twice.` });
    }
  });

  app.use((err, req, res, _next) => res.status(500).json({ ok: false, message: err.message }));
  return app;
}
