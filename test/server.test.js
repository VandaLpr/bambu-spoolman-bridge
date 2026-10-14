import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { IntakeError } from '../src/intake.js';
import { createApp } from '../src/server.js';
import { createColorTable } from '../src/bambu/colors.js';
import { openStore } from '../src/store.js';
import { colorCodes } from './fixtures/ha.js';
import { filament, spool } from './fixtures/spoolman.js';

let server;
let base;
let store;
let inventoryDown = false;
const answers = [];
const requeues = [];
const added = [];
let usageId;

// Inventory as the page sees it: an Acme PETG Black (the alias target), a Bambu PETG White,
// a PLA Gold, and an RFID-bound PLA Matte spool.
const petgBlack = { ...filament({ id: 10, name: 'Black', material: 'PETG', colorHex: '000000', bambuId: 'GFG99' }), vendor: { id: 5, name: 'Acme' } };
const petgWhite = filament({ id: 11, name: 'White', material: 'PETG', colorHex: 'FFFFFF', bambuId: 'GFG00' });
const plaGold = filament({ id: 12, name: 'Gold', material: 'PLA', colorHex: 'E4BD68', bambuId: 'GFA00' });
const plaMatte = filament({ id: 13, name: 'Matte Dark Red', material: 'PLA', colorHex: 'BB3D43', bambuId: 'GFA01' });
const inventory = {
  filaments: [petgBlack, petgWhite, plaGold, plaMatte],
  spools: [
    spool({ id: 20, filament: petgBlack, remaining: 500, firstUsed: '2026-10-01T00:00:00Z', location: 'A1' }),
    spool({ id: 21, filament: petgBlack, remaining: 1000 }),
    spool({ id: 22, filament: petgWhite, remaining: 1000 }),
    spool({ id: 23, filament: plaGold, remaining: 800, firstUsed: '2026-10-01T00:00:00Z' }),
    spool({ id: 24, filament: plaMatte, remaining: 900, firstUsed: '2026-10-01T00:00:00Z', rfid: 'EEEE', tags: ['EEEE'] }),
  ],
};
const catalogResult = { id: 'polymaker_petg_black_1000_175_n', manufacturer: 'Polymaker', name: 'Black', material: 'PETG', weight: 1000, color_hex: '000000' };
// SpoolmanDB entries for the insert question: Matte Dark Red is already in the inventory (filament 13).
const matteEntry = { id: 'bambulab_pla_mattedarkred_1000_175_n', manufacturer: 'Bambu Lab', name: 'Matte Dark Red', material: 'PLA', weight: 1000, color_hex: 'BB3D43' };
const scarletEntry = { id: 'bambulab_pla_mattescarletred_1000_175_n', manufacturer: 'Bambu Lab', name: 'Matte Scarlet Red', material: 'PLA', weight: 1000, color_hex: 'DE4343' };
const colorTableForPage = createColorTable(colorCodes);
const newSpools = [];

before(async () => {
  store = openStore(':memory:');
  const jobId = store.createJob({ printer: 'a1', taskName: '<b>Test</b> print', dryRun: false });
  store.replaceJobSources(jobId, [
    { sourceKey: 'External Spool', grams: 10.07, kind: 'external', filamentId: 'GFG99', colorHex: '000000', material: 'PETG', name: 'Generic PETG' },
  ]);
  store.upsertPending({ jobId, sourceKey: 'External Spool', reason: 'ambiguous_opened', candidates: [{ spoolId: 20, label: '#20 · PETG Black' }], printer: 'a1' });
  store.addInsertPending({
    printer: 'p2s', sourceKey: 'AMS 1 Tray 3', trayUuid: 'ABCD', reason: 'ambiguous_pairing', candidates: [],
    context: { identity: { filamentId: 'GFA01', colorHex: 'BB3D43', material: 'PLA', name: 'Bambu PLA Matte', trayUuid: 'ABCD' }, location: 'P2S AMS1 Slot 3' },
  });
  store.setAlias({ reportedFilamentId: 'GFG99', reportedColorHex: '000000', filamentId: 10 });
  usageId = store.recordUsage({ jobId, printer: 'a1', sourceKey: 'External Spool', spoolId: 20, grams: 10.07, status: 'finish', dryRun: false, writeState: 'queued' });
  store.countUsageAttempt(usageId);
  store.setUsageState(usageId, 'needs_attention', { error: 'GET /spool/20 -> HTTP 404' });

  const app = createApp({
    store,
    dryRun: false,
    health: () => ({ ok: true, version: 'test' }),
    choices: {
      inventory: async () => {
        if (inventoryDown) throw new Error('connect ECONNREFUSED');
        return structuredClone(inventory);
      },
      search: async (q) => (q.includes('polymaker') ? [catalogResult] : q.includes('matte') ? [matteEntry, scarletEntry] : []),
      colorTable: () => colorTableForPage,
      newSpool: async (args) => {
        newSpools.push(args);
        return { ok: true, message: 'New spool #98 of Matte Dark Red added to Spoolman. Spool #98 chosen.' };
      },
      addFromCatalog: async (args) => {
        added.push(args);
        return { ok: true, message: 'Spool #99 (Black) added to Spoolman. Spool #99 chosen.' };
      },
    },
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
    resolvePending: async (id, answer) => {
      answers.push([id, answer]);
      if (answer.filamentId === 10) return { ok: false, chooseSpool: [20, 25], message: 'Several opened spools of this filament: which one?' };
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

const html = async (path) => (await fetch(`${base}${path}`)).text();
const postForm = (path, body) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), redirect: 'manual' });
const postJson = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('GET /health, /jobs, /jobs/:id, /usage, /pending, /aliases', async () => {
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true, version: 'test' });
  const jobs = await (await fetch(`${base}/jobs`)).json();
  assert.equal(jobs.length, 1);
  const job = await (await fetch(`${base}/jobs/${jobs[0].id}`)).json();
  assert.deepEqual(job.usage.map((u) => u.write_state), ['needs_attention']);
  assert.equal((await fetch(`${base}/jobs/999`)).status, 404);
  assert.equal((await (await fetch(`${base}/usage`)).json()).length, 1);
  assert.equal((await (await fetch(`${base}/pending`)).json()).length, 2);
  assert.deepEqual((await (await fetch(`${base}/aliases`)).json()).map((a) => [a.reported_filament_id, a.reported_color_hex, a.filament_id]), [['GFG99', '000000', 10]]);
});

test('step 1: what the printer reported, the remembered filament first, stock and alias chips', async () => {
  const page = await html('/pending/1');
  assert.match(page, /a1 · &lt;b&gt;Test&lt;\/b&gt; print · External Spool/);
  assert.match(page, /Printer reports<\/span><br><b>Generic PETG #000000<\/b> <span class="muted">GFG99<\/span>/);
  const best = page.slice(page.indexOf('Best matches'), page.indexOf('Other filaments'));
  // the alias target is the match; PETG White (other filament id, far colour) is not
  assert.match(best, />Black</);
  assert.doesNotMatch(best, />White</);
  assert.match(page, /<details><summary>PETG <span>1<\/span><\/summary>/);
  assert.match(best, /Acme · 1 opened · 1 on shelf/);
  assert.match(best, /<button class="chip" title="Remove this printer alias">GFG99 #000000 ✕<\/button>/);
  assert.match(page, /<details><summary>PLA <span>2<\/span><\/summary>/); // PLA is not a match for PETG
  assert.match(page, /name="filamentId" value="10"/);
  assert.match(page, /placeholder="Spool id"/);
  assert.match(page, /Skip: deduct nothing for this source/);
  assert.match(page, /<link rel="icon" href="\/assets\/icon.svg"/);
});

test('an insert question: the exact filament is the top match even when its only spool is tied to another tag', async () => {
  const page = await html('/pending/2');
  assert.match(page, /p2s · spool just inserted · AMS 1 Tray 3/);
  assert.match(page, /Skip: leave this spool unpaired/);
  const best = page.slice(page.indexOf('Best matches'), page.indexOf('</ul>', page.indexOf('Best matches')));
  assert.ok(best.indexOf('Matte Dark Red') > 0);
  assert.match(best, /<li id="filament-13"><form method="post" action="\/pending\/2\/new-spool">/);
  assert.match(best, /no free spool: its spools are tied to other RFID tags/);
  assert.match(best, /\+ New spool/);
});

test('SpoolmanDB results already in the inventory link to the filament instead of "Add & use"', async () => {
  const page = await html('/pending/2?q=bambu%20matte');
  const results = page.slice(page.indexOf('Not in Spoolman?'));
  const darkRed = results.slice(results.indexOf('Matte Dark Red') - 300, results.indexOf('Matte Dark Red') + 300);
  assert.match(darkRed, /<a class="row" href="#filament-13">/);
  assert.match(darkRed, /In inventory ›/);
  assert.doesNotMatch(darkRed, /Add &amp; use/);
  const scarlet = results.slice(results.indexOf('Matte Scarlet Red'));
  assert.match(scarlet, /Add &amp; use/); // not in the inventory
});

test('"+ New spool" creates one spool of that filament and answers with it', async () => {
  const res = await postForm('/pending/2/new-spool', { filamentId: '13' });
  assert.equal(res.status, 303);
  assert.match(decodeURIComponent(res.headers.get('location')), /New spool #98 of Matte Dark Red/);
  assert.deepEqual(newSpools, [{ pendingId: 2, filamentId: 13 }]);
  assert.equal((await postJson('/pending/2/new-spool', {})).status, 400);
});

test('choosing a filament; several opened spools lead to step 2', async () => {
  const one = await postForm('/pending/1/resolve', { filamentId: '11' });
  assert.equal(one.status, 303);
  assert.equal(one.headers.get('location'), '/pending/1?msg=done');
  const several = await postForm('/pending/1/resolve', { filamentId: '10' });
  assert.match(several.headers.get('location'), /^\/pending\/1\?msg=Several%20opened.*&filament=10$/);
  const step2 = await html('/pending/1?filament=10');
  assert.match(step2, /Several opened spools of Black/);
  assert.ok(step2.indexOf('#20 · PETG Black · 500 g · A1') < step2.indexOf('#21 · PETG Black · 1000 g · unopened'));
  assert.match(step2, /name="spoolId" value="20"/);
  assert.match(step2, /Back to all filaments/);
});

test('POST /pending/:id/resolve: JSON with filamentId, spoolId or skip; nothing else', async () => {
  answers.length = 0;
  assert.equal((await postJson('/pending/1/resolve', {})).status, 400);
  assert.equal((await postJson('/pending/1/resolve', { spoolId: 'x' })).status, 400);
  assert.equal((await postJson('/pending/1/resolve', { spoolId: 20 })).status, 200);
  assert.equal((await postJson('/pending/1/resolve', { filamentId: 11 })).status, 200);
  assert.equal((await postJson('/pending/1/resolve', { skip: true })).status, 200);
  assert.deepEqual(answers, [
    [1, { spoolId: 20, filamentId: null }],
    [1, { spoolId: null, filamentId: 11 }],
    [1, {}],
  ]);
});

test('Add from SpoolmanDB: search, then add and use', async () => {
  const results = await html('/pending/1?q=polymaker%20petg');
  assert.match(results, /value="polymaker petg"/);
  assert.match(results, /Polymaker · PETG · 1000 g/);
  assert.match(results, /Add &amp; use/);
  assert.match(await html('/pending/1?q=nothing'), /Nothing found/);
  const res = await postForm('/pending/1/add', { externalId: catalogResult.id, q: 'polymaker petg' });
  assert.equal(res.status, 303);
  assert.match(decodeURIComponent(res.headers.get('location')), /Spool #99 \(Black\) added/);
  assert.deepEqual(added, [{ pendingId: 1, externalId: catalogResult.id, q: 'polymaker petg' }]);
  assert.equal((await postJson('/pending/1/add', {})).status, 400);
});

test('a printer alias can be removed from the page', async () => {
  const res = await postForm('/aliases/remove', { reported_filament_id: 'GFG99', reported_color_hex: '000000', back: '/pending/1' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/pending/1?msg=Printer%20alias%20removed.');
  assert.deepEqual(store.listAliases(), []);
  assert.doesNotMatch(await html('/pending/1'), /class="chip"/);
  // a foreign "back" target is not followed
  const odd = await postForm('/aliases/remove', { reported_filament_id: 'X', reported_color_hex: 'Y', back: 'https://example.com' });
  assert.equal(odd.status, 404);
  store.setAlias({ reportedFilamentId: 'GFG99', reportedColorHex: '000000', filamentId: 10 });
});

test('Spoolman unreachable: the page still offers a spool id', async () => {
  inventoryDown = true;
  const page = await html('/pending/1');
  inventoryDown = false;
  assert.match(page, /Spoolman is unreachable \(connect ECONNREFUSED\)/);
  assert.match(page, /placeholder="Spool id"/);
  assert.doesNotMatch(page, /Best matches/);
});

test('the deduction page shows a rejected row with retry, other spool and skip', async () => {
  const page = await html(`/usage/${usageId}`);
  assert.match(page, /10\.07 g from spool #20 · state: needs_attention · attempts: 1/);
  assert.match(page, /Last error: GET \/spool\/20 -&gt; HTTP 404/);
  assert.match(page, /Retry spool #20/);
  assert.match(page, /Skip: deduct nothing/);
  assert.equal((await fetch(`${base}/usage/999`)).status, 404);
});

test('POST /usage/:id/requeue validates input and passes spool or skip through', async () => {
  assert.equal((await postJson(`/usage/${usageId}/requeue`, { spoolId: 'abc' })).status, 400);
  assert.equal((await postJson(`/usage/${usageId}/requeue`, { spoolId: 21 })).status, 200);
  assert.equal((await postJson(`/usage/${usageId}/requeue`, { skip: true })).status, 200);
  assert.deepEqual(requeues, [[usageId, 21], [usageId, null]]);
});

test('POST /intake: plan by default, apply only with apply: true, errors mapped to status codes', async () => {
  const plan = await postJson('/intake', { batch_id: 'b1', items: [{ bambu_color_code: '10401' }] });
  assert.equal(plan.status, 200);
  assert.equal((await plan.json()).status, 'ready');
  assert.equal((await postJson('/intake', { batch_id: 'b1', apply: 'yes', items: [] })).status, 200); // only true applies
  assert.deepEqual(await (await postJson('/intake', { batch_id: 'b1', apply: true, items: [] })).json(), { status: 'applied', spool_ids: [5, 6] });
  assert.equal((await postJson('/intake', { batch_id: 'conflict', apply: true })).status, 409);
  const needs = await postJson('/intake', { batch_id: 'needs', apply: true });
  assert.equal(needs.status, 422);
  assert.equal((await needs.json()).status, 'needs_input');
  const down = await postJson('/intake', { batch_id: 'down', apply: true });
  assert.equal(down.status, 502);
  assert.match((await down.json()).error, /Re-post the same batch to resume/);
});

test('the icon is served and used as favicon on the pages', async () => {
  const png = await fetch(`${base}/assets/icon.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.match((await fetch(`${base}/assets/icon.svg`)).headers.get('content-type'), /^image\/svg\+xml/);
  const ico = await fetch(`${base}/favicon.ico`);
  assert.equal(ico.status, 200);
  assert.equal(ico.headers.get('content-type'), 'image/png');
  const page = await html('/pending/1');
  assert.match(page, /<link rel="apple-touch-icon" href="\/assets\/icon.png">/);
});
