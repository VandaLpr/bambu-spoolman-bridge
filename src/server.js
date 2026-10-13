// HTTP API for inspection, pending sources and rejected deductions. LAN only, no auth.
// createApp() returns the Express app so more routers (e.g. MCP in phase 2) can be mounted.

import express from 'express';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const limitOf = (req, def) => Math.min(Math.max(Number.parseInt(req.query.limit, 10) || def, 1), 500);

export function createApp({ store, health, resolvePending, requeueUsage, dryRun }) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

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

  app.get('/pending/:id', (req, res) => {
    const pending = store.getPending(Number(req.params.id));
    if (!pending) return res.status(404).type('html').send(page('Not found', '<p>This pending item does not exist.</p>'));
    res.type('html').send(pendingPage({ pending, job: store.getJob(pending.job_id), dryRun, notice: req.query.msg }));
  });

  app.get('/usage/:id', (req, res) => {
    const row = store.getUsage(Number(req.params.id));
    if (!row) return res.status(404).type('html').send(page('Not found', '<p>This deduction does not exist.</p>'));
    res.type('html').send(usagePage({ row, job: store.getJob(row.job_id), dryRun, notice: req.query.msg }));
  });

  // Body: { spoolId: 12 } or { skip: true }. HTML forms get a redirect back to the page.
  const answerRoute = (pagePath, handler) => async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const skip = req.body.skip === true || req.body.skip === 'true';
      const spoolId = skip ? null : Number.parseInt(req.body.spoolId, 10);
      if (!skip && !Number.isInteger(spoolId)) return res.status(400).json({ ok: false, message: 'spoolId or skip is required' });
      const result = await handler(id, spoolId);
      if (req.is('application/x-www-form-urlencoded')) return res.redirect(303, `${pagePath}/${id}?msg=${encodeURIComponent(result.message)}`);
      res.status(result.ok ? 200 : 409).json(result);
    } catch (e) {
      next(e);
    }
  };
  app.post('/pending/:id/resolve', answerRoute('/pending', resolvePending));
  // Only for rows in needs_attention (Spoolman rejected the deduction).
  app.post('/usage/:id/requeue', answerRoute('/usage', requeueUsage));

  app.use((err, req, res, _next) => res.status(500).json({ ok: false, message: err.message }));
  return app;
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font:16px/1.4 system-ui,sans-serif;max-width:32rem;margin:1rem auto;padding:0 1rem;color:#222;background:#fafafa}
button{display:block;width:100%;padding:.8rem;margin:.4rem 0;font-size:1rem;border:1px solid #888;border-radius:.4rem;background:#fff;text-align:left}
.note{padding:.6rem;border-radius:.4rem;background:#fff3cd}.done{background:#d1e7dd}input{padding:.6rem;font-size:1rem;width:8rem}
@media(prefers-color-scheme:dark){body{background:#121212;color:#ddd}button{background:#1e1e1e;color:#ddd}.note{background:#4d3d00}.done{background:#173d2a}}
</style></head><body>${body}</body></html>`;
}

function pendingPage({ pending, job, dryRun, notice }) {
  const open = pending.state === 'open';
  const parts = [
    `<h1>Which spool?</h1>`,
    `<p>${esc(job?.printer)} · ${esc(job?.task_name ?? 'unknown print')} · ${esc(pending.source_key)}<br>Reason: ${esc(pending.reason)}</p>`,
  ];
  if (dryRun) parts.push('<p class="note">DRY_RUN is on: answers are logged only.</p>');
  if (notice) parts.push(`<p class="note">${esc(notice)}</p>`);
  if (!open) {
    parts.push(`<p class="note done">Already ${esc(pending.state)}${pending.chosen_spool_id ? `: spool #${esc(pending.chosen_spool_id)}` : ''}.</p>`);
    return page('Pending', parts.join('\n'));
  }
  const form = (fields, label) =>
    `<form method="post" action="/pending/${pending.id}/resolve">${fields}<button type="submit">${label}</button></form>`;
  for (const c of pending.candidates) parts.push(form(`<input type="hidden" name="spoolId" value="${esc(c.spoolId)}">`, esc(c.label)));
  parts.push(form('<label>Other spool id <input name="spoolId" inputmode="numeric" required></label>', 'Use this spool'));
  parts.push(form('<input type="hidden" name="skip" value="true">', 'Skip: deduct nothing for this source'));
  return page('Pending', parts.join('\n'));
}

function usagePage({ row, job, dryRun, notice }) {
  const parts = [
    `<h1>Deduction ${esc(row.id)}</h1>`,
    `<p>${esc(job?.printer)} · ${esc(row.task_name ?? 'unknown print')} · ${esc(row.source_key)}<br>` +
      `${esc(row.grams)} g from spool #${esc(row.spool_id ?? '?')} · state: ${esc(row.write_state)} · attempts: ${esc(row.attempts)}</p>`,
  ];
  if (row.error) parts.push(`<p class="note">Last error: ${esc(row.error)}</p>`);
  if (dryRun) parts.push('<p class="note">DRY_RUN is on: answers are logged only.</p>');
  if (notice) parts.push(`<p class="note">${esc(notice)}</p>`);
  if (row.write_state !== 'needs_attention') return page('Deduction', parts.join('\n'));
  const form = (fields, label) => `<form method="post" action="/usage/${row.id}/requeue">${fields}<button type="submit">${label}</button></form>`;
  if (row.spool_id) parts.push(form(`<input type="hidden" name="spoolId" value="${esc(row.spool_id)}">`, `Retry spool #${esc(row.spool_id)}`));
  parts.push(form('<label>Other spool id <input name="spoolId" inputmode="numeric" required></label>', 'Deduct from this spool'));
  parts.push(form('<input type="hidden" name="skip" value="true">', 'Skip: deduct nothing'));
  return page('Deduction', parts.join('\n'));
}
