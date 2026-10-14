// Facts from Bambu's filament profiles in bambulab/BambuStudio
// (resources/profiles/BBL/filament, commit 804d93bb5d): filament_id from each "<name> @base.json",
// filament_type and density resolved through its "inherits" chain. Only identifiers and numbers
// are kept here; scripts/verify-profiles.mjs re-checks every row against the repository.
//
// BAMBU: Bambu Lab product lines, keyed by the filament_id the RFID reports.
// GENERIC: what the printer reports when a non-Bambu filament is selected on its screen,
// e.g. "Generic PETG" -> GFG99 (confirmed on an A1).

// [profile file name without "Bambu " / "Generic " and " @base", filament_id, filament_type, density g/cm3]
const BAMBU_ROWS = [
  ['PLA Basic', 'GFA00', 'PLA', 1.26],
  ['PLA Matte', 'GFA01', 'PLA', 1.32],
  ['PLA Metal', 'GFA02', 'PLA', 1.25],
  ['PLA Silk', 'GFA05', 'PLA', 1.32],
  ['PLA Silk+', 'GFA06', 'PLA', 1.27],
  ['PLA Marble', 'GFA07', 'PLA', 1.22],
  ['PLA Sparkle', 'GFA08', 'PLA', 1.26],
  ['PLA Tough', 'GFA09', 'PLA', 1.26],
  ['PLA Tough+', 'GFA10', 'PLA', 1.21],
  ['PLA Aero', 'GFA11', 'PLA-AERO', 1.21],
  ['PLA Glow', 'GFA12', 'PLA', 1.26],
  ['PLA Dynamic', 'GFA13', 'PLA', 1.26],
  ['PLA Galaxy', 'GFA15', 'PLA', 1.19],
  ['PLA Wood', 'GFA16', 'PLA', 1.21],
  ['PLA Translucent', 'GFA17', 'PLA', 1.22],
  ['PLA Lite', 'GFA18', 'PLA', 1.4],
  ['PLA Pure', 'GFA19', 'PLA', 1.24],
  ['PLA-CF', 'GFA50', 'PLA-CF', 1.22],
  ['ABS', 'GFB00', 'ABS', 1.04],
  ['ASA', 'GFB01', 'ASA', 1.05],
  ['ASA-Aero', 'GFB02', 'ASA-AERO', 0.99],
  ['ABS-GF', 'GFB50', 'ABS-GF', 1.08],
  ['ASA-CF', 'GFB51', 'ASA-CF', 1.02],
  ['PC', 'GFC00', 'PC', 1.185],
  ['PC FR', 'GFC01', 'PC', 1.19],
  ['PETG Basic', 'GFG00', 'PETG', 1.25],
  ['PETG Translucent', 'GFG01', 'PETG', 1.25],
  ['PETG HF', 'GFG02', 'PETG', 1.28],
  ['PETG Matte', 'GFG03', 'PETG', 1.25],
  ['PETG-CF', 'GFG50', 'PETG-CF', 1.25],
  ['PA-CF', 'GFN03', 'PA-CF', 1.09],
  ['PAHT-CF', 'GFN04', 'PA-CF', 1.06],
  ['PA6-CF', 'GFN05', 'PA6-CF', 1.1],
  ['PPA-CF', 'GFN06', 'PPA-CF', 1.17],
  ['PA6-GF', 'GFN08', 'PA-GF', 1.14],
  ['Support W', 'GFS00', 'PLA', 1.3],
  ['Support G', 'GFS01', 'PA', 1.22],
  ['Support For PLA', 'GFS02', 'PLA', 1.3],
  ['Support For PA PET', 'GFS03', 'PA', 1.22],
  ['PVA', 'GFS04', 'PVA', 1.27],
  ['Support For PLA-PETG', 'GFS05', 'PLA', 1.19],
  ['Support for ABS', 'GFS06', 'ABS', 1.16],
  ['PET-CF', 'GFT01', 'PET-CF', 1.29],
  ['PPS-CF', 'GFT02', 'PPS-CF', 1.26],
  ['TPU 95A HF', 'GFU00', 'TPU', 1.22],
  ['TPU 95A', 'GFU01', 'TPU', 1.22],
  ['TPU for AMS', 'GFU02', 'TPU-AMS', 1.26],
  ['TPU 90A', 'GFU03', 'TPU', 1.24],
  ['TPU 85A', 'GFU04', 'TPU', 1.18],
];

const GENERIC_ROWS = [
  ['PLA', 'GFL99', 'PLA', 1.24],
  ['PLA Silk', 'GFL96', 'PLA', 1.24],
  ['PLA High Speed', 'GFL95', 'PLA', 1.24],
  ['PLA-CF', 'GFL98', 'PLA-CF', 1.24],
  ['PETG', 'GFG99', 'PETG', 1.27],
  ['PETG HF', 'GFG96', 'PETG', 1.28],
  ['PETG-CF', 'GFG98', 'PETG-CF', 1.25],
  ['PCTG', 'GFG97', 'PCTG', 1.29],
  ['ABS', 'GFB99', 'ABS', 1.04],
  ['ASA', 'GFB98', 'ASA', 1.04],
  ['PC', 'GFC99', 'PC', 1.04],
  ['PA', 'GFN99', 'PA', 1.04],
  ['PA-CF', 'GFN98', 'PA-CF', 1.04],
  ['PPA-CF', 'GFN97', 'PPA-CF', 1.17],
  ['PPA-GF', 'GFN96', 'PPA-GF', 1.17],
  ['TPU', 'GFU99', 'TPU', 1.24],
  ['TPU for AMS', 'GFU98', 'TPU-AMS', 1.26],
  ['PVA', 'GFS99', 'PVA', 1.24],
  ['HIPS', 'GFS98', 'HIPS', 1.06],
  ['BVOH', 'GFS97', 'BVOH', 1.13],
  ['PP', 'GFP97', 'PP', 0.93],
  ['PP-CF', 'GFP96', 'PP-CF', 1.01],
  ['PP-GF', 'GFP95', 'PP-GF', 1.05],
  ['PE', 'GFP99', 'PE', 0.95],
  ['PE-CF', 'GFP98', 'PE-CF', 0.95],
  ['PHA', 'GFR98', 'PHA', 1.24],
  ['EVA', 'GFR99', 'EVA', 0.94],
  ['PPS', 'GFT97', 'PPS', 1.36],
  ['PPS-CF', 'GFT98', 'PPS-CF', 1.26],
];

const toProfile = (prefix) => ([name, filamentId, material, density]) => ({ profile: `${prefix} ${name}`, name, filamentId, material, density });
export const BAMBU_PROFILES = BAMBU_ROWS.map(toProfile('Bambu'));
export const GENERIC_PROFILES = GENERIC_ROWS.map(toProfile('Generic'));

const bambuById = new Map(BAMBU_PROFILES.map((p) => [p.filamentId, p]));
const genericByName = new Map(GENERIC_PROFILES.map((p) => [p.name.toLowerCase(), p]));

/** GFA01 -> { profile: 'Bambu PLA Matte', material: 'PLA', density: 1.32 } | null */
export const bambuProfile = (filamentId) => bambuById.get(filamentId) ?? null;

/** "PETG", "petg hf" or "Generic PETG" -> { profile, filamentId, material, density } | null */
export function genericProfile(name) {
  const key = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/^generic\s+/, '');
  return genericByName.get(key) ?? null;
}

export const genericProfileNames = () => GENERIC_PROFILES.map((p) => p.name);

/** Density for a filament id (Bambu or generic), or null. */
export function densityFor(filamentId) {
  return bambuById.get(filamentId)?.density ?? GENERIC_PROFILES.find((p) => p.filamentId === filamentId)?.density ?? null;
}
