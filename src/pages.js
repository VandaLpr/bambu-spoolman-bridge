// Server-rendered HTML pages (no JavaScript). Mobile-first: they are opened from phone
// notifications, usually while standing at the printer.

import { stockLabel } from './choices.js';
import { normalizeHex } from './color.js';
import { REASONS } from './notifier.js';
import { describeSpool } from './resolver.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STYLE = `
:root{--bg:#f5f4f0;--card:#fff;--ink:#1c1c1e;--muted:#6e6e73;--line:#e2e0da;--accent:#0b7a4b;--accent-ink:#fff;--note:#fff3d1;--done:#dcf2e4;--danger:#a3261b}
@media(prefers-color-scheme:dark){:root{--bg:#121212;--card:#1d1d1f;--ink:#ececec;--muted:#9a9aa0;--line:#2e2e31;--accent:#39c481;--accent-ink:#06210f;--note:#3d3215;--done:#173524;--danger:#ff8a80}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:34rem;margin:0 auto;padding:1rem 1rem 3rem}
header{display:flex;align-items:center;gap:.6rem;margin:.2rem 0 .3rem}
header img{width:2.2rem;height:2.2rem}
h1{font-size:1.35rem;margin:0}
h2{font-size:.78rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:1.6rem 0 .5rem}
.ctx{color:var(--muted);margin:0 0 .8rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:.9rem;padding:.8rem .9rem}
.reported{display:flex;gap:.8rem;align-items:center}
.reported .sw{width:2.6rem;height:2.6rem}
.note{background:var(--note);border-radius:.7rem;padding:.6rem .8rem;margin:.6rem 0}
.done{background:var(--done)}
.sw{display:inline-block;flex:none;width:1.9rem;height:1.9rem;border-radius:50%;border:1px solid rgba(0,0,0,.18);background:var(--line)}
ul{list-style:none;margin:0;padding:0}
.list li{background:var(--card);border:1px solid var(--line);border-radius:.9rem;margin:.45rem 0;overflow:hidden}
form{margin:0}
.row{display:flex;align-items:center;gap:.75rem;width:100%;min-height:3.6rem;padding:.6rem .8rem;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.row:active{background:var(--line)}
.main{flex:1;min-width:0}
.name{display:block;font-weight:600;overflow-wrap:anywhere}
.sub{display:block;color:var(--muted);font-size:.88rem}
.go{color:var(--muted);font-size:1.4rem}
.cta{flex:none;background:var(--accent);color:var(--accent-ink);border-radius:.6rem;padding:.35rem .7rem;font-size:.85rem;font-weight:600}
.have{flex:none;border:1px solid var(--line);color:var(--muted);border-radius:.6rem;padding:.3rem .6rem;font-size:.85rem}
a.row{text-decoration:none}
.list li:target{outline:2px solid var(--accent)}
.aliases{display:flex;flex-wrap:wrap;align-items:center;gap:.35rem;padding:0 .8rem .6rem 3.45rem;color:var(--muted);font-size:.8rem}
.chip{border:1px solid var(--line);border-radius:1rem;background:none;color:inherit;font:inherit;padding:.1rem .55rem;cursor:pointer}
details{background:var(--card);border:1px solid var(--line);border-radius:.9rem;margin:.45rem 0}
summary{cursor:pointer;padding:.8rem .9rem;font-weight:600}
summary span{color:var(--muted);font-weight:400}
details .list{padding:0 .5rem .3rem}
details .list li{border-color:var(--line)}
.inline{display:flex;gap:.5rem}
input{flex:1;min-width:0;font:inherit;padding:.65rem .75rem;border:1px solid var(--line);border-radius:.7rem;background:var(--card);color:inherit}
.btn{font:inherit;font-weight:600;padding:.65rem 1rem;border-radius:.7rem;border:0;background:var(--accent);color:var(--accent-ink);cursor:pointer}
.ghost{width:100%;margin-top:.6rem;background:none;border:1px solid var(--line);color:var(--danger)}
.muted{color:var(--muted);font-size:.88rem}
a{color:var(--accent)}
`;

export function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml"><link rel="icon" href="/assets/icon.png" type="image/png" sizes="512x512">
<link rel="apple-touch-icon" href="/assets/icon.png"><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

const header = (title) => `<header><img src="/assets/icon.svg" alt=""><h1>${esc(title)}</h1></header>`;

// Colour swatch: one colour, a gradient (longitudinal) or hard stripes (coaxial).
export function swatch(colors = [], direction = null) {
  const hexes = colors.map(normalizeHex).filter(Boolean);
  if (!hexes.length) return '<span class="sw"></span>';
  if (hexes.length === 1) return `<span class="sw" style="background:#${hexes[0]}"></span>`;
  if (direction === 'coaxial') {
    const step = 100 / hexes.length;
    const stops = hexes.map((h, i) => `#${h} ${(i * step).toFixed(1)}% ${((i + 1) * step).toFixed(1)}%`).join(',');
    return `<span class="sw" style="background:linear-gradient(90deg,${stops})"></span>`;
  }
  return `<span class="sw" style="background:linear-gradient(135deg,${hexes.map((h) => `#${h}`).join(',')})"></span>`;
}

const notes = ({ dryRun, notice, error }) =>
  [
    dryRun ? '<p class="note">DRY_RUN is on: answers are logged only. "Add from SpoolmanDB" still creates the spool.</p>' : '',
    notice ? `<p class="note">${esc(notice)}</p>` : '',
    error ? `<p class="note">${esc(error)}</p>` : '',
  ].join('');

// A filament the question can be answered with. Without a free spool (its spools are used up,
// or tied to other RFID tags) the row offers "+ New spool" of it instead of choosing it.
function filamentRow(pendingId, v, back) {
  const stock = v.free > 0 ? stockLabel(v) : v.boundOnly ? 'no free spool: its spools are tied to other RFID tags' : 'no spool in stock';
  const sub = [v.vendor, stock].filter(Boolean).join(' · ');
  const aliases = v.aliases.length
    ? `<div class="aliases">Printer:${v.aliases
        .map(
          (a) => `<form method="post" action="/aliases/remove"><input type="hidden" name="reported_filament_id" value="${esc(a.reported_filament_id)}">` +
            `<input type="hidden" name="reported_color_hex" value="${esc(a.reported_color_hex)}"><input type="hidden" name="back" value="${esc(back)}">` +
            `<button class="chip" title="Remove this printer alias">${esc(a.reported_filament_id)} #${esc(a.reported_color_hex)} ✕</button></form>`,
        )
        .join('')}</div>`
    : '';
  const action = v.free > 0 ? 'resolve' : 'new-spool';
  const end = v.free > 0 ? '<span class="go">›</span>' : '<span class="cta">+ New spool</span>';
  return `<li id="filament-${v.id}"><form method="post" action="/pending/${pendingId}/${action}"><input type="hidden" name="filamentId" value="${v.id}">` +
    `<button class="row">${swatch(v.colors, v.direction)}<span class="main"><span class="name">${esc(v.name)}</span><span class="sub">${esc(sub)}</span></span>${end}</button></form>${aliases}</li>`;
}

function reportedCard(pending, reported) {
  const what = [reported.name ?? reported.material, reported.colorHex ? `#${reported.colorHex}` : null].filter(Boolean).join(' ');
  return `<div class="card reported">${swatch(reported.colorHex ? [reported.colorHex] : [])}<div><span class="muted">Printer reports</span><br>` +
    `<b>${esc(what || 'nothing')}</b>${reported.filamentId ? ` <span class="muted">${esc(reported.filamentId)}</span>` : ''}<br>` +
    `<span class="muted">${esc(REASONS[pending.reason] ?? pending.reason)}</span></div></div>`;
}

/**
 * @param {object} p
 * @param {object} p.pending, p.job, p.reported
 * @param {object|null} p.choices   filamentChoices() result (null if Spoolman is unreachable)
 * @param {object|null} p.step2     { filament, spools } when several opened spools need a pick
 * @param {object|null} p.search    { q, results } from SpoolmanDB
 */
export function pendingPage({ pending, job, reported, choices = null, step2 = null, search = null, dryRun, notice, error }) {
  const id = pending.id;
  const back = `/pending/${id}`;
  const what = pending.kind === 'insert' ? 'spool just inserted' : esc(job?.task_name ?? 'unknown print');
  const parts = [header('Which spool?'), `<p class="ctx">${esc(job?.printer ?? pending.printer)} · ${what} · ${esc(pending.source_key)}</p>`];
  parts.push(reportedCard(pending, reported), notes({ dryRun, notice, error }));

  if (pending.state !== 'open') {
    parts.push(`<p class="note done">Already ${esc(pending.state)}${pending.chosen_spool_id ? `: spool #${esc(pending.chosen_spool_id)}` : ''}.</p>`);
    return page('Which spool?', parts.join('\n'));
  }

  if (step2) {
    parts.push(`<h2>Several opened spools of ${esc(step2.filament.name)}</h2><ul class="list">`);
    for (const s of step2.spools) {
      parts.push(`<li><form method="post" action="/pending/${id}/resolve"><input type="hidden" name="spoolId" value="${s.id}">` +
        `<button class="row">${swatch(step2.filament.colors, step2.filament.direction)}<span class="main"><span class="name">${esc(describeSpool(s))}</span></span><span class="go">›</span></button></form></li>`);
    }
    parts.push(`</ul><p><a href="${back}">‹ Back to all filaments</a></p>`);
    return page('Which spool?', parts.join('\n'));
  }

  if (choices) {
    if (choices.suggested.length) {
      parts.push('<h2>Best matches</h2><ul class="list">', ...choices.suggested.map((v) => filamentRow(id, v, back)), '</ul>');
    }
    if (choices.groups.length) {
      parts.push(`<h2>${choices.suggested.length ? 'Other filaments' : 'Filaments'}</h2>`);
      for (const g of choices.groups) {
        parts.push(`<details><summary>${esc(g.material)} <span>${g.filaments.length}</span></summary><ul class="list">`, ...g.filaments.map((v) => filamentRow(id, v, back)), '</ul></details>');
      }
    }
    if (!choices.suggested.length && !choices.groups.length) parts.push('<p class="muted">No filament in Spoolman has a spool that fits here.</p>');
    if (choices.hidden) parts.push(`<p class="muted">${choices.hidden} filament(s) without a usable spool are not shown.</p>`);
  }

  parts.push(
    '<h2>Not in Spoolman?</h2>',
    `<form method="get" action="${back}" class="inline"><input name="q" value="${esc(search?.q ?? '')}" placeholder="Search SpoolmanDB, e.g. Polymaker PETG black" aria-label="Search SpoolmanDB"><button class="btn">Search</button></form>`,
  );
  if (search) {
    if (!search.results.length) parts.push('<p class="muted">Nothing found.</p>');
    else {
      parts.push('<ul class="list">');
      for (const e of search.results) {
        const colors = e.color_hexes?.length ? e.color_hexes : [e.color_hex];
        const sub = esc([e.manufacturer, e.material, e.weight ? `${e.weight} g` : null].filter(Boolean).join(' · '));
        // Already in Spoolman: link to that filament's row instead of creating a duplicate.
        if (e.inInventory) {
          parts.push(`<li><a class="row" href="#filament-${e.inInventory.id}">${swatch(colors, e.multi_color_direction)}<span class="main"><span class="name">${esc(e.name)}</span>` +
            `<span class="sub">${sub}</span></span><span class="have">In inventory ›</span></a></li>`);
          continue;
        }
        parts.push(`<li><form method="post" action="/pending/${id}/add"><input type="hidden" name="externalId" value="${esc(e.id)}"><input type="hidden" name="q" value="${esc(search.q)}">` +
          `<button class="row">${swatch(colors, e.multi_color_direction)}<span class="main"><span class="name">${esc(e.name)}</span>` +
          `<span class="sub">${sub}</span></span><span class="cta">Add &amp; use</span></button></form></li>`);
      }
      parts.push('</ul>');
    }
  }

  parts.push(
    '<h2>Or</h2>',
    `<form method="post" action="/pending/${id}/resolve" class="inline"><input name="spoolId" inputmode="numeric" required placeholder="Spool id" aria-label="Spool id"><button class="btn">Use spool</button></form>`,
    `<form method="post" action="/pending/${id}/resolve"><input type="hidden" name="skip" value="true"><button class="btn ghost">${pending.kind === 'insert' ? 'Skip: leave this spool unpaired' : 'Skip: deduct nothing for this source'}</button></form>`,
  );
  return page('Which spool?', parts.join('\n'));
}

export function usagePage({ row, job, dryRun, notice }) {
  const parts = [
    header(`Deduction ${row.id}`),
    `<p class="ctx">${esc(job?.printer)} · ${esc(row.task_name ?? 'unknown print')} · ${esc(row.source_key)}</p>`,
    `<div class="card">${esc(row.grams)} g from spool #${esc(row.spool_id ?? '?')} · state: ${esc(row.write_state)} · attempts: ${esc(row.attempts)}</div>`,
  ];
  if (row.error) parts.push(`<p class="note">Last error: ${esc(row.error)}</p>`);
  parts.push(notes({ dryRun, notice }));
  if (row.write_state !== 'needs_attention') return page('Deduction', parts.join('\n'));
  const form = (fields, label, cls = 'btn') => `<form method="post" action="/usage/${row.id}/requeue">${fields}<button class="${cls}">${label}</button></form>`;
  parts.push('<h2>Deduct it</h2>');
  if (row.spool_id) parts.push(form(`<input type="hidden" name="spoolId" value="${esc(row.spool_id)}">`, `Retry spool #${esc(row.spool_id)}`));
  parts.push(
    `<form method="post" action="/usage/${row.id}/requeue" class="inline" style="margin-top:.6rem"><input name="spoolId" inputmode="numeric" required placeholder="Other spool id" aria-label="Other spool id"><button class="btn">Deduct from this spool</button></form>`,
    form('<input type="hidden" name="skip" value="true">', 'Skip: deduct nothing', 'btn ghost'),
  );
  return page('Deduction', parts.join('\n'));
}
