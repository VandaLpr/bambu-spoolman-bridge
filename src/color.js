// Color helpers. HA and BambuStudio report "#E4BD68FF" (RGBA); Spoolman stores "E4BD68", or
// 8 digits with alpha for translucent colours ("C9A38180"). Matching always compares RGB.

// RGB only, for matching: "#C9A38180" -> "C9A381"
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

// A Spoolman filament's colours: color_hex, or multi_color_hexes for a multi-colour filament.
// For storing in Spoolman: RGB when opaque, RGBA when the alpha isn't FF ("#C9A38180" -> "C9A38180").
export function storedHex(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}([0-9A-F]{2})?$/.test(hex)) return null;
  return hex.length === 8 && !hex.endsWith('FF') ? hex : hex.slice(0, 6);
}

// A filament's colours as stored (with alpha), for checking whether they need an update.
export function filamentStoredColors(filament) {
  if (filament?.multi_color_hexes) return filament.multi_color_hexes.split(',').map(storedHex).filter(Boolean);
  const hex = storedHex(filament?.color_hex);
  return hex ? [hex] : [];
}

export function filamentColors(filament) {
  if (filament?.multi_color_hexes) return filament.multi_color_hexes.split(',').map(normalizeHex).filter(Boolean);
  const hex = normalizeHex(filament?.color_hex);
  return hex ? [hex] : [];
}

export function sameColors(a, b) {
  return a.length > 0 && a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

// Spoolman filament fields for these colours. Multi-colour filaments leave color_hex empty
// ("the multi_color_hexes field is used instead") and need a direction.
export function colorFields(hexes, direction = null) {
  if (hexes.length > 1 && direction) return { color_hex: null, multi_color_hexes: hexes.join(','), multi_color_direction: direction };
  return { color_hex: hexes[0] ?? null };
}
