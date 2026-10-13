// Spoolman objects shaped like GET /api/v1/spool responses (v0.27.0), extra values JSON-encoded.

export const vendor = { id: 1, name: 'Bambu Lab', external_id: 'Bambu Lab', extra: {} };

export function filament({ id, name, material = 'PLA', colorHex, bambuId, weight = 1000 }) {
  return {
    id,
    name,
    vendor,
    material,
    density: 1.24,
    diameter: 1.75,
    weight,
    color_hex: colorHex,
    extra: bambuId ? { bambu_filament_id: JSON.stringify(bambuId) } : {},
  };
}

export function spool({ id, filament: f, remaining = 1000, firstUsed = null, rfid = null, tags = [], archived = false, location = null }) {
  return {
    id,
    registered: '2026-10-01T00:00:00Z',
    first_used: firstUsed,
    last_used: firstUsed,
    filament: f,
    remaining_weight: remaining,
    initial_weight: 1000,
    used_weight: 1000 - (remaining ?? 0),
    location,
    archived,
    extra: rfid ? { rfid_uuid: JSON.stringify(rfid) } : {},
    tags: tags.map((uid) => ({ uid, format: 'bambu', added: '2026-10-01T00:00:00Z' })),
  };
}

// Shaped exactly like a live Spoolman response (rfid_uuid anonymized).
export const goldFilament = {
  id: 1,
  registered: '2026-10-12T23:02:16Z',
  name: 'Gold',
  vendor,
  material: 'PLA',
  density: 1.24,
  diameter: 1.75,
  weight: 1000.0,
  spool_weight: 250.0,
  settings_extruder_temp: 220,
  settings_bed_temp: 60,
  color_hex: 'E4BD68',
  external_id: 'bambulab_pla_gold_1000_175_n',
  extra: { bambu_filament_id: '"GFA00"', bambu_color_code: '"10401"' },
  tags: [],
};

export const goldSpool = {
  id: 1,
  registered: '2026-10-12T23:02:16Z',
  first_used: '2026-10-11T22:00:00Z',
  filament: goldFilament,
  remaining_weight: 850.0,
  initial_weight: 1000.0,
  spool_weight: 250.0,
  used_weight: 150.0,
  location: 'Shelf',
  archived: false,
  extra: { rfid_uuid: '"A1B2C3D4E5F60718293A4B5C6D7E8F90"' },
  tags: [],
};
