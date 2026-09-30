// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The towns and areas of the island, which side each is on,
// and roughly where it sits on the map.
//
// Used where a town arrives as words and has to become a place: a spreadsheet of
// cars that only says "Marigot", or a business moving its base to the other side
// of the island. The positions are the middle of each area — close enough to put
// a pin on the map; a business can move a car's pin exactly from the car form.
//
// Names are matched loosely (case, accents, punctuation and spacing ignored), and
// a few common spellings are accepted, because nobody types "Quartier d'Orléans"
// the same way twice.

export type Side = 'dutch' | 'french';
export type Town = { name: string; side: Side; latitude: number; longitude: number };

const TOWNS: (Town & { aliases?: string[] })[] = [
  // ---- THE DUTCH SIDE (Sint Maarten) ----
  { name: 'Philipsburg', side: 'dutch', latitude: 18.026, longitude: -63.045, aliases: ['Phillipsburg', 'Great Bay'] },
  { name: 'Simpson Bay', side: 'dutch', latitude: 18.035, longitude: -63.09 },
  { name: 'Princess Juliana Airport', side: 'dutch', latitude: 18.041, longitude: -63.109, aliases: ['Airport', 'SXM Airport', 'Juliana Airport', 'PJIA'] },
  { name: 'Maho', side: 'dutch', latitude: 18.043, longitude: -63.117, aliases: ['Maho Bay'] },
  { name: 'Cupecoy', side: 'dutch', latitude: 18.046, longitude: -63.152 },
  { name: 'Beacon Hill', side: 'dutch', latitude: 18.04, longitude: -63.113 },
  { name: 'Cole Bay', side: 'dutch', latitude: 18.036, longitude: -63.075 },
  { name: 'Cay Hill', side: 'dutch', latitude: 18.033, longitude: -63.06 },
  { name: 'Pelican Key', side: 'dutch', latitude: 18.023, longitude: -63.08, aliases: ['Pelican'] },
  { name: 'Cul de Sac', side: 'dutch', latitude: 18.045, longitude: -63.055 },
  { name: 'Middle Region', side: 'dutch', latitude: 18.043, longitude: -63.045 },
  { name: 'Sint Peters', side: 'dutch', latitude: 18.037, longitude: -63.052, aliases: ['St Peters', 'Saint Peters'] },
  { name: 'Dutch Quarter', side: 'dutch', latitude: 18.047, longitude: -63.028 },
  { name: 'Point Blanche', side: 'dutch', latitude: 18.012, longitude: -63.033, aliases: ['Pointe Blanche'] },
  { name: 'Guana Bay', side: 'dutch', latitude: 18.028, longitude: -63.02 },
  { name: 'Oyster Pond', side: 'dutch', latitude: 18.054, longitude: -63.017 },
  { name: 'Belair', side: 'dutch', latitude: 18.033, longitude: -63.035 },
  { name: 'Sucker Garden', side: 'dutch', latitude: 18.041, longitude: -63.03 },

  // ---- THE FRENCH SIDE (Saint-Martin) ----
  { name: 'Marigot', side: 'french', latitude: 18.067, longitude: -63.083 },
  { name: 'Sandy Ground', side: 'french', latitude: 18.072, longitude: -63.095 },
  { name: 'Baie Nettlé', side: 'french', latitude: 18.071, longitude: -63.107, aliases: ['Nettle Bay', 'Baie Nettle'] },
  { name: 'Terres Basses', side: 'french', latitude: 18.063, longitude: -63.14, aliases: ['Lowlands', 'Baie Longue', 'Baie Rouge'] },
  { name: 'Concordia', side: 'french', latitude: 18.07, longitude: -63.078 },
  { name: 'Saint-James', side: 'french', latitude: 18.065, longitude: -63.075, aliases: ['St James'] },
  { name: 'Friar’s Bay', side: 'french', latitude: 18.082, longitude: -63.073, aliases: ['Friars Bay', 'Baie des Pères'] },
  { name: 'Colombier', side: 'french', latitude: 18.08, longitude: -63.06 },
  { name: 'Grand Case', side: 'french', latitude: 18.101, longitude: -63.056, aliases: ['Grand-Case'] },
  { name: 'Grand Case Airport', side: 'french', latitude: 18.1, longitude: -63.047, aliases: ['L’Espérance Airport', 'Esperance Airport', 'SFG'] },
  { name: 'Anse Marcel', side: 'french', latitude: 18.112, longitude: -63.04 },
  { name: 'Cul-de-Sac', side: 'french', latitude: 18.098, longitude: -63.03, aliases: ['French Cul de Sac'] },
  { name: 'Orient Bay', side: 'french', latitude: 18.085, longitude: -63.02, aliases: ['Baie Orientale'] },
  { name: 'Quartier d’Orléans', side: 'french', latitude: 18.062, longitude: -63.02, aliases: ['Quartier', 'French Quarter'] },
  { name: 'Mont Vernon', side: 'french', latitude: 18.091, longitude: -63.022 },
  { name: 'Hope Estate', side: 'french', latitude: 18.093, longitude: -63.045 },
];

// "Quartier d'Orléans" and "quartier dorleans" are the same place.
function normalise(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(st|ste)\b\.?/g, 'saint')
    .replace(/[^a-z0-9]/g, '');
}

// One name can be on both sides — there is a Cul de Sac on each — so a name
// leads to every town that answers to it.
const BY_NAME = new Map<string, Town[]>();
for (const { aliases, ...town } of TOWNS) {
  for (const name of [town.name, ...(aliases ?? [])]) {
    const key = normalise(name);
    BY_NAME.set(key, [...(BY_NAME.get(key) ?? []), town]);
  }
}

// The town these words mean, or null for a place that is not on the island.
// Given a side, the town of that name on that side comes first.
export function findTown(name: string, side?: Side): Town | null {
  const found = BY_NAME.get(normalise(name)) ?? [];
  return found.find((town) => town.side === side) ?? found[0] ?? null;
}

// A few names from each side, for a message that says what would work.
export function exampleTowns(side?: Side): string {
  return TOWNS.filter((town) => !side || town.side === side)
    .slice(0, 4)
    .map((town) => town.name)
    .join(', ');
}
