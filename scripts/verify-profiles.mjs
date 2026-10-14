// Re-checks src/bambu/profiles.js against BambuStudio's filament profiles: filament_id, and
// filament_type / density resolved through "inherits". Network required; not part of npm test.
//   node scripts/verify-profiles.mjs [git-ref]     (default: master)

import { BAMBU_PROFILES, GENERIC_PROFILES } from '../src/bambu/profiles.js';

const ref = process.argv[2] || 'master';
const base = `https://raw.githubusercontent.com/bambulab/BambuStudio/${ref}/resources/profiles/BBL/filament/`;
const cache = new Map();

async function profile(name) {
  if (!cache.has(name)) {
    const res = await fetch(base + encodeURIComponent(`${name}.json`));
    if (!res.ok) throw new Error(`${name}.json: HTTP ${res.status}`);
    cache.set(name, await res.json());
  }
  return cache.get(name);
}

// First value of `key` along the inherits chain.
async function resolve(name, key) {
  for (let p = await profile(name); p; p = p.inherits ? await profile(p.inherits) : null) {
    if (p[key] !== undefined) return Array.isArray(p[key]) ? p[key][0] : p[key];
  }
  return undefined;
}

let failures = 0;
for (const p of [...BAMBU_PROFILES, ...GENERIC_PROFILES]) {
  const file = `${p.profile} @base`;
  try {
    const id = (await profile(file)).filament_id;
    const type = await resolve(file, 'filament_type');
    const density = Number(await resolve(file, 'filament_density'));
    const ok = id === p.filamentId && type === p.material && density === p.density;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'DIFF'} ${p.profile.padEnd(30)} ${id} ${type} ${density}` + (ok ? '' : `   (table: ${p.filamentId} ${p.material} ${p.density})`));
  } catch (e) {
    failures++;
    console.log(`ERR  ${p.profile.padEnd(30)} ${e.message}`);
  }
}
const total = BAMBU_PROFILES.length + GENERIC_PROFILES.length;
console.log(failures ? `${failures} of ${total} profiles differ from ${ref}` : `all ${total} profiles match ${ref}`);
process.exit(failures ? 1 : 0);
