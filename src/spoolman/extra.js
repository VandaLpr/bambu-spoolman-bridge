// Spoolman stores every extra field value as a JSON-encoded string ("\"GFA00\"").
// This is the only place that knows about that encoding.

export function readExtra(entity, key) {
  const raw = entity?.extra?.[key];
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    const value = JSON.parse(raw);
    return value === '' ? null : value;
  } catch {
    return raw; // tolerate values written unencoded by other tools
  }
}

export function encodeExtra(fields) {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, v === null || v === undefined ? null : JSON.stringify(v)]),
  );
}
