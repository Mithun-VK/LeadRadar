/**
 * Geographic search strategy.
 *
 * The naive approach — one query per city — hits the provider's 60-result
 * ceiling immediately and returns 60 dental clinics for a city with 3,000. The
 * equally naive fix — subdivide everything into a fine grid — is worse, and this
 * is the counter-intuitive part: Text Search is billed PER REQUEST regardless of
 * how many results come back, so a grid of mostly-empty cells pays full price
 * for near-empty pages and RAISES cost per business.
 *
 * The strategy is therefore adaptive: start coarse, and split a cell only when it
 * saturates (returns the provider's hard ceiling), because saturation is the only
 * evidence that a cell is hiding businesses. Unsaturated cells are never split —
 * they have already shown everything they contain.
 *
 * Nothing here is specific to any city. A city is a bounding box in a registry,
 * so adding one is data, not code.
 */
import { fingerprint } from '@/lib/ids';
import type { BoundingBox } from '@/modules/providers/contracts';

export interface CityDefinition {
  readonly name: string;
  readonly state: string;
  readonly country: string;
  /** ISO 3166-1 alpha-2, passed to the provider as a region hint. */
  readonly regionCode: string;
  readonly bounds: BoundingBox;
}

/**
 * City registry.
 *
 * Bounding boxes only — deliberately not neighbourhood lists. Hard-coding
 * "Anna Nagar, T Nagar, Adyar…" does not generalise, goes stale, and encodes one
 * analyst's mental model of a city. Subdivision derives areas from the box.
 */
export const CITY_REGISTRY: readonly CityDefinition[] = [
  { name: 'Chennai', state: 'Tamil Nadu', country: 'India', regionCode: 'IN', bounds: { south: 12.83, west: 80.05, north: 13.25, east: 80.34 } },
  { name: 'Bangalore', state: 'Karnataka', country: 'India', regionCode: 'IN', bounds: { south: 12.83, west: 77.46, north: 13.15, east: 77.78 } },
  { name: 'Mumbai', state: 'Maharashtra', country: 'India', regionCode: 'IN', bounds: { south: 18.89, west: 72.77, north: 19.28, east: 73.02 } },
  { name: 'Delhi', state: 'Delhi', country: 'India', regionCode: 'IN', bounds: { south: 28.40, west: 76.84, north: 28.89, east: 77.35 } },
  { name: 'Hyderabad', state: 'Telangana', country: 'India', regionCode: 'IN', bounds: { south: 17.20, west: 78.24, north: 17.62, east: 78.64 } },
  { name: 'Pune', state: 'Maharashtra', country: 'India', regionCode: 'IN', bounds: { south: 18.41, west: 73.74, north: 18.65, east: 73.99 } },
  { name: 'Kolkata', state: 'West Bengal', country: 'India', regionCode: 'IN', bounds: { south: 22.45, west: 88.26, north: 22.66, east: 88.44 } },
  { name: 'Ahmedabad', state: 'Gujarat', country: 'India', regionCode: 'IN', bounds: { south: 22.94, west: 72.45, north: 23.13, east: 72.68 } },
  { name: 'Jaipur', state: 'Rajasthan', country: 'India', regionCode: 'IN', bounds: { south: 26.79, west: 75.70, north: 26.99, east: 75.92 } },
  { name: 'Kochi', state: 'Kerala', country: 'India', regionCode: 'IN', bounds: { south: 9.87, west: 76.23, north: 10.07, east: 76.36 } },
  { name: 'Coimbatore', state: 'Tamil Nadu', country: 'India', regionCode: 'IN', bounds: { south: 10.90, west: 76.90, north: 11.08, east: 77.05 } },
];

/**
 * Resolves a location string to a city.
 *
 * Matches on the leading segment before a comma, so "Chennai, India" and
 * "Chennai" both resolve. Returns null rather than guessing: running a search
 * against the wrong bounding box would spend real money returning nothing.
 */
export function resolveCity(location: string): CityDefinition | null {
  const needle = location.split(',')[0]!.trim().toLowerCase();
  if (needle === '') return null;

  const exact = CITY_REGISTRY.find((city) => city.name.toLowerCase() === needle);
  if (exact) return exact;

  // Accept common alternates without maintaining a synonym table for each.
  const alternates: Record<string, string> = {
    bengaluru: 'Bangalore',
    bombay: 'Mumbai',
    madras: 'Chennai',
    calcutta: 'Kolkata',
    'new delhi': 'Delhi',
    ncr: 'Delhi',
    cochin: 'Kochi',
    poona: 'Pune',
  };
  const mapped = alternates[needle];
  return mapped ? (CITY_REGISTRY.find((city) => city.name === mapped) ?? null) : null;
}

export function knownCityNames(): string[] {
  return CITY_REGISTRY.map((city) => city.name);
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

export interface GeoCellSpec {
  /** Stable id derived from the bounds, so the same cell dedupes across runs. */
  readonly cellKey: string;
  readonly bounds: BoundingBox;
  readonly depth: number;
  readonly cityName: string;
}

export function cellKeyFor(bounds: BoundingBox): string {
  // Six decimals is ~10cm — far finer than any cell we create, so the key is
  // stable without floating-point noise creating duplicate cells.
  const round = (v: number) => v.toFixed(6);
  return fingerprint(round(bounds.south), round(bounds.west), round(bounds.north), round(bounds.east));
}

export function makeCell(bounds: BoundingBox, depth: number, cityName: string): GeoCellSpec {
  return { cellKey: cellKeyFor(bounds), bounds, depth, cityName };
}

/**
 * Depth limit.
 *
 * At depth 3 a metro is 64 cells; at depth 4 it is 256. Beyond that the cells are
 * small enough that most are empty, and each empty cell still costs a full
 * request. The limit is a cost control, not a precision limit.
 */
export const MAX_SUBDIVISION_DEPTH = 3;

/** Approximate cell width in metres, used to stop splitting below a useful size. */
export function cellWidthMetres(bounds: BoundingBox): number {
  const midLat = ((bounds.south + bounds.north) / 2) * (Math.PI / 180);
  const degToMetresLon = 111_320 * Math.cos(midLat);
  return Math.abs(bounds.east - bounds.west) * degToMetresLon;
}

/** Below this, splitting further yields mostly-empty cells. */
export const MIN_CELL_WIDTH_METRES = 800;

/** Splits a cell into four quadrants. */
export function subdivide(cell: GeoCellSpec): GeoCellSpec[] {
  const { bounds } = cell;
  const midLat = (bounds.south + bounds.north) / 2;
  const midLon = (bounds.west + bounds.east) / 2;

  const quadrants: BoundingBox[] = [
    { south: bounds.south, west: bounds.west, north: midLat, east: midLon },
    { south: bounds.south, west: midLon, north: midLat, east: bounds.east },
    { south: midLat, west: bounds.west, north: bounds.north, east: midLon },
    { south: midLat, west: midLon, north: bounds.north, east: bounds.east },
  ];

  return quadrants.map((quadrant) => makeCell(quadrant, cell.depth + 1, cell.cityName));
}

/** Whether a saturated cell is worth splitting. */
export function shouldSubdivide(cell: GeoCellSpec, saturated: boolean): boolean {
  if (!saturated) return false;
  if (cell.depth >= MAX_SUBDIVISION_DEPTH) return false;
  if (cellWidthMetres(cell.bounds) <= MIN_CELL_WIDTH_METRES * 2) return false;
  return true;
}

/**
 * Starting cells for a city.
 *
 * A metro starts at depth 1 (four cells) rather than depth 0, because a single
 * city-wide query for a common category saturates with near-certainty, and paying
 * for that guaranteed-saturated request only to split anyway is a wasted request
 * per category. A small city starts at depth 0, where one request usually
 * suffices.
 */
export function seedCells(city: CityDefinition): GeoCellSpec[] {
  const root = makeCell(city.bounds, 0, city.name);
  const isLarge = cellWidthMetres(city.bounds) > 20_000;
  return isLarge ? subdivide(root) : [root];
}

/** Total cells a city would occupy at a given depth, for cost estimation. */
export function cellCountAtDepth(city: CityDefinition, depth: number): number {
  const seeds = seedCells(city).length;
  const startDepth = seeds > 1 ? 1 : 0;
  return seeds * 4 ** Math.max(0, depth - startDepth);
}
