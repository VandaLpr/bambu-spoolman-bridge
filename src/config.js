// Environment parsing and validation. Every problem is collected and reported at once.

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

export class ConfigError extends Error {}

export function loadConfig(env = process.env) {
  const problems = [];
  const required = (key) => {
    const v = env[key]?.trim();
    if (!v) problems.push(`${key} is required`);
    return v;
  };
  const number = (key, def) => {
    if (env[key] === undefined || env[key] === '') return def;
    const n = Number(env[key]);
    if (!Number.isFinite(n) || n < 0) problems.push(`${key} must be a non-negative number`);
    return n;
  };

  const haUrl = required('HA_URL');
  const haToken = required('HA_TOKEN');
  const spoolmanUrl = required('SPOOLMAN_URL');
  const notifyService = required('NOTIFY_SERVICE');
  if (notifyService && !/^notify\.[a-z0-9_]+$/.test(notifyService)) {
    problems.push('NOTIFY_SERVICE must look like notify.mobile_app_<device>');
  }

  // Anything other than an explicit "false" keeps the bridge read-only.
  const dryRun = String(env.DRY_RUN ?? 'true').trim().toLowerCase() !== 'false';

  const logLevel = (env.LOG_LEVEL || 'info').toLowerCase();
  if (!LOG_LEVELS.includes(logLevel)) problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);

  const printers = parsePrinters(env.PRINTERS, problems);

  if (problems.length) throw new ConfigError(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);

  return Object.freeze({
    haUrl: haUrl.replace(/\/+$/, ''),
    haToken,
    spoolmanUrl: spoolmanUrl.replace(/\/+$/, ''),
    notifyService,
    bridgeUrl: env.BRIDGE_URL?.trim().replace(/\/+$/, '') || null,
    dryRun,
    logLevel,
    dataDir: env.DATA_DIR || '/data',
    port: number('PORT', 8080),
    jobStartToleranceSec: number('JOB_START_TOLERANCE_SEC', 120),
    nearestColorMaxDeltaE: number('NEAREST_COLOR_MAX_DE', 20),
    spoolmanRetryMinutes: number('SPOOLMAN_RETRY_MINUTES', 5),
    printers,
  });
}

function parsePrinters(raw, problems) {
  if (!raw?.trim()) {
    problems.push('PRINTERS is required (JSON array, see .env.example)');
    return [];
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    problems.push(`PRINTERS is not valid JSON: ${e.message}`);
    return [];
  }
  if (!Array.isArray(list) || list.length === 0) {
    problems.push('PRINTERS must be a non-empty JSON array');
    return [];
  }
  const seen = new Set();
  return list.map((p, i) => {
    const prefix = p?.prefix;
    if (typeof prefix !== 'string' || !/^[a-z0-9_]+$/.test(prefix)) {
      problems.push(`PRINTERS[${i}].prefix must be an entity prefix like p2s`);
    } else if (seen.has(prefix)) {
      problems.push(`PRINTERS[${i}].prefix "${prefix}" is listed twice`);
    }
    seen.add(prefix);
    const name = p?.name || prefix;
    return Object.freeze({
      prefix,
      name,
      // {unit} = AMS number as in HA (ams_1 = 1), {n} = slot 1..4
      amsLocation: p?.amsLocation || `${name} AMS{unit} Slot {n}`,
      externalLocation: p?.externalLocation || name,
      refreshDelayMs: Number.isFinite(p?.refreshDelayMs) ? p.refreshDelayMs : 5000,
      // Optional entity id overrides, e.g. {"externalSpool": "sensor.x"}. Keys: status, progress,
      // printWeight, startTime, taskName, activeTray, stage, externalSpool, refreshButton (see ha/entities.js)
      entities: Object.freeze({ ...(p?.entities || {}) }),
    });
  });
}
