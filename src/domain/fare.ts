/**
 * Fare estimation.
 *
 * Two rules that matter more than the arithmetic:
 *   1. Money is integer paise. Never store or compute money as a float.
 *   2. The server always recalculates the fare. The browser shows an estimate
 *      using this same module so the number matches, but a fare arriving in a
 *      request body is ignored — otherwise a customer could book a 40 km ride
 *      for one rupee by editing the payload.
 */

export interface FareConfig {
  baseCents: number;
  perKmCents: number;
  minimumCents: number;
}

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface FareBreakdown {
  distanceKm: number;
  baseCents: number;
  distanceCents: number;
  totalCents: number;
  /** True when the minimum fare was applied instead of the metered total. */
  minimumApplied: boolean;
}

export const DEFAULT_FARE_CONFIG: FareConfig = {
  baseCents: 4000, //  ₹40.00 flag-down
  perKmCents: 1450, //  ₹14.50 per kilometre
  minimumCents: 6000, //  ₹60.00 minimum
};

export function fareConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FareConfig {
  const read = (key: string, fallback: number) => {
    const raw = env[key];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    baseCents: read("FARE_BASE_CENTS", DEFAULT_FARE_CONFIG.baseCents),
    perKmCents: read("FARE_PER_KM_CENTS", DEFAULT_FARE_CONFIG.perKmCents),
    minimumCents: read("FARE_MINIMUM_CENTS", DEFAULT_FARE_CONFIG.minimumCents),
  };
}

/**
 * Fare = base + (distance x per-km rate), floored at the minimum fare.
 * Changing this rule — a likely live-coding request — means changing only this
 * function; the form preview and the stored fare both go through it.
 */
export function calculateFare(
  distanceKm: number,
  config: FareConfig = DEFAULT_FARE_CONFIG,
): FareBreakdown {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    throw new RangeError("Distance must be a positive number of kilometres.");
  }
  const distanceCents = Math.round(distanceKm * config.perKmCents);
  const metered = config.baseCents + distanceCents;
  const totalCents = Math.max(metered, config.minimumCents);
  return {
    distanceKm: roundTo(distanceKm, 2),
    baseCents: config.baseCents,
    distanceCents,
    totalCents,
    minimumApplied: totalCents !== metered,
  };
}

const EARTH_RADIUS_KM = 6371;
/** Straight-line distance underestimates driving distance; scale it up a bit. */
const ROAD_WINDING_FACTOR = 1.25;

export function haversineKm(from: Coordinates, to: Coordinates): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Stand-in for a routing provider (Google Distance Matrix, OSRM).
 *
 * Order of preference:
 *   1. a distance the customer typed in
 *   2. great-circle distance between supplied coordinates, scaled for roads
 *   3. a deterministic pseudo-distance derived from the two address strings
 *
 * Option 3 is a mock, and it is deterministic on purpose: the same two
 * addresses always estimate the same distance, so the demo and the tests are
 * repeatable. Swapping in a real provider means replacing this one function.
 */
export function estimateDistanceKm(input: {
  distanceKm?: number | null;
  pickup?: Coordinates | null;
  destination?: Coordinates | null;
  pickupAddress: string;
  destinationAddress: string;
}): number {
  if (typeof input.distanceKm === "number" && input.distanceKm > 0) {
    return roundTo(input.distanceKm, 2);
  }
  if (input.pickup && input.destination) {
    const km = haversineKm(input.pickup, input.destination) * ROAD_WINDING_FACTOR;
    return roundTo(Math.max(km, 0.5), 2);
  }
  return mockDistanceFromAddresses(input.pickupAddress, input.destinationAddress);
}

/** Deterministic 2.0–28.0 km stand-in derived from the address text. */
export function mockDistanceFromAddresses(pickup: string, destination: string): number {
  const seed = hash32(`${pickup.trim().toLowerCase()}|${destination.trim().toLowerCase()}`);
  const km = 2 + (seed % 2600) / 100; // 2.00 .. 27.99
  return roundTo(km, 2);
}

function hash32(value: string): number {
  // FNV-1a: small, dependency-free, and stable across runs.
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** 125050 -> "₹1,250.50". Kept server-side and client-side identical. */
export function formatMoney(cents: number, currency = "INR", locale = "en-IN"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}
