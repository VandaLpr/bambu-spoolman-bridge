import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../src/config.js';
import { readExtra, encodeExtra } from '../src/spoolman/extra.js';
import { goldSpool } from './fixtures/spoolman.js';

const base = {
  HA_URL: 'http://homeassistant.local:8123/',
  HA_TOKEN: 'secret-token-value',
  SPOOLMAN_URL: 'http://spoolman.local:7912',
  NOTIFY_SERVICE: 'notify.mobile_app_my_phone',
  PRINTERS: JSON.stringify([
    { prefix: 'p2s', name: 'P2S', amsLocation: 'P2S AMS{unit} Slot {n}', externalLocation: 'P2S External' },
    { prefix: 'a1', name: 'A1' },
  ]),
};

test('DRY_RUN defaults to true and only an explicit "false" turns it off', () => {
  assert.equal(loadConfig(base).dryRun, true);
  assert.equal(loadConfig({ ...base, DRY_RUN: 'no' }).dryRun, true);
  assert.equal(loadConfig({ ...base, DRY_RUN: ' FALSE ' }).dryRun, false);
});

test('printers get defaults derived from their name', () => {
  const [p2s, a1] = loadConfig(base).printers;
  assert.equal(p2s.amsLocation, 'P2S AMS{unit} Slot {n}');
  assert.equal(p2s.refreshDelayMs, 5000);
  assert.equal(a1.amsLocation, 'A1 AMS{unit} Slot {n}');
  assert.equal(a1.externalLocation, 'A1');
});

test('URLs lose trailing slashes', () => {
  assert.equal(loadConfig(base).haUrl, 'http://homeassistant.local:8123');
});

test('all problems are reported together', () => {
  assert.throws(
    () => loadConfig({ NOTIFY_SERVICE: 'my_phone', PRINTERS: '[{"prefix":"Bad-Prefix"}]', LOG_LEVEL: 'loud' }),
    (e) => e instanceof ConfigError && ['HA_URL', 'HA_TOKEN', 'SPOOLMAN_URL', 'NOTIFY_SERVICE', 'LOG_LEVEL', 'prefix'].every((k) => e.message.includes(k)),
  );
});

test('extra fields are JSON-decoded on read and encoded on write', () => {
  assert.equal(readExtra(goldSpool, 'rfid_uuid'), 'A1B2C3D4E5F60718293A4B5C6D7E8F90');
  assert.equal(readExtra(goldSpool.filament, 'bambu_color_code'), '10401');
  assert.equal(readExtra(goldSpool, 'missing'), null);
  assert.equal(readExtra({ extra: { x: 'not-json' } }, 'x'), 'not-json');
  assert.deepEqual(encodeExtra({ rfid_uuid: 'ABC', gone: null }), { rfid_uuid: '"ABC"', gone: null });
});
