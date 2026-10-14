import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { IntakeError } from '../src/intake.js';
import { createApp } from '../src/server.js';
import { openStore } from '../src/store.js';

let server;
let base;
let store;
const answers = [];
const requeues = [];
let usageId;

before(async () => {
  store = openStore(':memory:');
  const jobId = store.createJob({ printer: 'a1', taskName: '<b>Test</b> print', dryRun: false });
  store.upsertPending({ jobId, sourceKey: 'External Spool', reason: 'ambiguous_opened', candidates: [{ spoolId: 20, label: '#20 · PETG White' }] });
  store.addInsertPending({ printer: 'p2s', sourceKey: 'AMS 1 Tray 3', trayUuid: 'ABCD', reason: 'ambiguous_pairing', candidates: [{ spoolId: 42, label: '#42 · PLA Matte Dark Red' }], context: {} });
  usageId = store.recordUsage({ jobId, printer: 'a1', sourceKey: 'External Spool', spoolId: 20, grams: 10.07, status: 'finish', dryRun: false, writeState: 'queued' });
  store.countUsageAttempt(usageId);
  store.setUsageState(usageId, 'needs_attention', { error: 'GET /spool/20 -> HTTP 404' });
  const app = createApp({
    store,
    dryRun: false,
    health: () => ({ ok: true, version: 'test' }),
    intake: {
      plan: async (body) => ({ status: 'ready', echo: body }),
      apply: async (body) => {
        if (body.batch_id === 'conflict') throw new IntakeError(409, 'batch_id was already used for different items');
        if (body.batch_id === 'needs') throw new IntakeError(422, 'some items need input; nothing was written', { status: 'needs_input', items: [] });
        if (body.batch_id === 'down') throw new Error('POST /spool failed: connect ECONNREFUSED');
        return { status: 'applied', spool_ids: [5, 6] };
      },
    },
    requeueUsage: async (id, spoolId) => {
      requeues.push([id, spoolId]);
      return { ok: true, message: 'requeued' };
    },
    resolvePending: async (id, spoolId) => {
      answers.push([id, spoolId]);
      return { ok: true, message: 'done' };
    },
  });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  store.close();
});

test('GET /health, /jobs, /jobs/:id, /usage, /pending', async () => {
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true, version: 'test' });
  const jobs = await (await fetch(`${base}/jobs`)).json();
  assert.equal(jobs.length, 1);
  const job = await (await fetch(`${base}/jobs/${jobs[0].id}`)).json();
  assert.deepEqual(job.usage.map((u) => u.write_state), ['needs_attention']);
  assert.equal((await fetch(`${base}/jobs/999`)).status, 404);
  assert.equal((await (await fetch(`${base}/usage`)).json()).length, 1);
  assert.equal((await (await fetch(`${base}/pending`)).json()).length, 2);
});

test('the pending page escapes HTML and offers each candidate', async () => {
  const html = await (await fetch(`${base}/pending/1`)).text();
  assert.match(html, /&lt;b&gt;Test&lt;\/b&gt; print/);
  assert.match(html, /#20 · PETG White/);
  assert.match(html, /Skip: deduct nothing/);
});

test('POST /pending/:id/resolve validates input and passes spool or skip through', async () => {
  const post = (body) => fetch(`${base}/pending/1/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ spoolId: 20 })).status, 200);
  assert.equal((await post({ skip: true })).status, 200);
  assert.deepEqual(answers, [[1, 20], [1, null]]);
});

test('HTML form posts redirect back to the page with the result', async () => {
  const res = await fetch(`${base}/pending/1/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'spoolId=20',
    redirect: 'manual',
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/pending/1?msg=done');
});

test('the deduction page shows a rejected row with retry, other spool and skip', async () => {
  const html = await (await fetch(`${base}/usage/${usageId}`)).text();
  assert.match(html, /10\.07 g from spool #20 · state: needs_attention · attempts: 1/);
  assert.match(html, /Last error: GET \/spool\/20 -&gt; HTTP 404/);
  assert.match(html, /Retry spool #20/);
  assert.match(html, /Skip: deduct nothing/);
  assert.equal((await fetch(`${base}/usage/999`)).status, 404);
});

test('POST /usage/:id/requeue validates input and passes spool or skip through', async () => {
  const post = (body) => fetch(`${base}/usage/${usageId}/requeue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ spoolId: 'abc' })).status, 400);
  assert.equal((await post({ spoolId: 21 })).status, 200);
  assert.equal((await post({ skip: true })).status, 200);
  assert.deepEqual(requeues, [[usageId, 21], [usageId, null]]);
});

test('POST /intake: plan by default, apply only with apply: true, errors mapped to status codes', async () => {
  const post = (body) => fetch(`${base}/intake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const plan = await post({ batch_id: 'b1', items: [{ bambu_color_code: '10401' }] });
  assert.equal(plan.status, 200);
  assert.equal((await plan.json()).status, 'ready');
  assert.equal((await post({ batch_id: 'b1', apply: 'yes', items: [] })).status, 200); // only true applies
  assert.deepEqual(await (await post({ batch_id: 'b1', apply: true, items: [] })).json(), { status: 'applied', spool_ids: [5, 6] });
  assert.equal((await post({ batch_id: 'conflict', apply: true })).status, 409);
  const needs = await post({ batch_id: 'needs', apply: true });
  assert.equal(needs.status, 422);
  assert.equal((await needs.json()).status, 'needs_input');
  const down = await post({ batch_id: 'down', apply: true });
  assert.equal(down.status, 502);
  assert.match((await down.json()).error, /Re-post the same batch to resume/);
});

test('the page of an insert question names the printer and the slot', async () => {
  const html = await (await fetch(`${base}/pending/2`)).text();
  assert.match(html, /p2s · spool just inserted · AMS 1 Tray 3/);
  assert.match(html, /#42 · PLA Matte Dark Red/);
});

test('the icon is served and used as favicon on the pages', async () => {
  const png = await fetch(`${base}/assets/icon.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.match((await fetch(`${base}/assets/icon.svg`)).headers.get('content-type'), /^image\/svg\+xml/);
  const ico = await fetch(`${base}/favicon.ico`);
  assert.equal(ico.status, 200);
  assert.equal(ico.headers.get('content-type'), 'image/png');
  const html = await (await fetch(`${base}/pending/1`)).text();
  assert.match(html, /<link rel="icon" href="\/assets\/icon.svg" type="image\/svg\+xml">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/assets\/icon.png">/);
});
