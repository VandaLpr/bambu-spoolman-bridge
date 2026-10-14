import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// The zone is fixed per process, so each case runs in a child process with its own TZ.
function localIsoIn(tz, iso) {
  const script = `import('./src/log.js').then(({ localIso }) => console.log(localIso(new Date('${iso}'))))`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

test('timestamps are local time with the offset of TZ, including DST', () => {
  assert.equal(localIsoIn('Europe/Zagreb', '2026-10-14T08:16:44.915Z'), '2026-10-14T10:16:44.915+02:00'); // CEST
  assert.equal(localIsoIn('Europe/Zagreb', '2026-01-15T08:16:44.005Z'), '2026-01-15T09:16:44.005+01:00'); // CET
  assert.equal(localIsoIn('UTC', '2026-10-14T08:16:44.915Z'), '2026-10-14T08:16:44.915+00:00');
  assert.equal(localIsoIn('America/St_Johns', '2026-01-15T08:16:44.915Z'), '2026-01-15T04:46:44.915-03:30'); // half-hour offset
});
