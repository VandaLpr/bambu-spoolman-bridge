// Color helpers. HA reports "#E4BD68FF" (RGBA), Spoolman stores "E4BD68".

export function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}([0-9A-F]{2})?$/.test(hex)) return null;
  return hex.slice(0, 6);
}

function toLab(hex) {
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// CIE76 delta E between two hex colors; Infinity when either is unusable.
export function deltaE(a, b) {
  const ha = normalizeHex(a);
  const hb = normalizeHex(b);
  if (!ha || !hb) return Infinity;
  const [l1, a1, b1] = toLab(ha);
  const [l2, a2, b2] = toLab(hb);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}
