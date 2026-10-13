// Minimal leveled logger. Registered secrets are masked in every line it prints.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;
const secrets = new Set();

export function setLogLevel(level) {
  threshold = LEVELS[level] ?? LEVELS.info;
}

export function addSecret(value) {
  if (value && value.length >= 8) secrets.add(value);
}

function mask(text) {
  let out = text;
  for (const s of secrets) out = out.split(s).join('***');
  return out;
}

function format(level, scope, msg, data) {
  let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (data !== undefined) {
    const detail = data instanceof Error ? data.stack || data.message : JSON.stringify(data);
    line += ` ${detail}`;
  }
  return mask(line);
}

export function createLogger(scope) {
  const emit = (level) => (msg, data) => {
    if (LEVELS[level] < threshold) return;
    const line = format(level, scope, msg, data);
    (level === 'error' || level === 'warn' ? console.error : console.log)(line);
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
