import { describe, expect, it } from "vitest";
import {
  calculateFare,
  estimateDistanceKm,
  haversineKm,
  mockDistanceFromAddresses,
  formatMoney,
} from "@/domain/fare";

const config = { baseCents: 4000, perKmCents: 1450, minimumCents: 6000 };

describe("fare calculation", () => {
  it("charges base plus distance", () => {
    const fare = calculateFare(10, config);
    expect(fare.baseCents).toBe(4000);
    expect(fare.distanceCents).toBe(14_500);
    expect(fare.totalCents).toBe(18_500); // ₹185.00
    expect(fare.minimumApplied).toBe(false);
  });

  it("applies the minimum fare to very short trips", () => {
    const fare = calculateFare(0.5, config);
    expect(fare.totalCents).toBe(6000);
    expect(fare.minimumApplied).toBe(true);
  });

  it("returns whole cents, never fractions", () => {
    for (const km of [1.37, 4.29, 8.888, 19.005]) {
      const { totalCents } = calculateFare(km, config);
      expect(Number.isInteger(totalCents)).toBe(true);
    }
  });

  it("rejects a distance that is zero or negative", () => {
    expect(() => calculateFare(0, config)).toThrow(RangeError);
    expect(() => calculateFare(-4, config)).toThrow(RangeError);
  });

  it("formats money from integer cents without float drift", () => {
    expect(formatMoney(18_500).replace(/\u00a0/g, " ")).toContain("185.00");
    expect(formatMoney(10).replace(/\u00a0/g, " ")).toContain("0.10");
  });
});

describe("distance estimation", () => {
  it("prefers a distance the customer supplied", () => {
    const km = estimateDistanceKm({
      distanceKm: 12.5,
      pickup: { lat: 19.06, lng: 72.86 },
      destination: { lat: 19.11, lng: 72.87 },
      pickupAddress: "A",
      destinationAddress: "B",
    });
    expect(km).toBe(12.5);
  });

  it("uses coordinates when they are available", () => {
    const km = estimateDistanceKm({
      pickup: { lat: 19.0596, lng: 72.8295 },
      destination: { lat: 19.0896, lng: 72.8656 },
      pickupAddress: "Bandra",
      destinationAddress: "Andheri",
    });
    const straightLine = haversineKm(
      { lat: 19.0596, lng: 72.8295 },
      { lat: 19.0896, lng: 72.8656 },
    );
    expect(km).toBeGreaterThan(straightLine); // road winding factor applied
    expect(km).toBeLessThan(straightLine * 1.5);
  });

  it("falls back to a stand-in that is stable for the same addresses", () => {
    const a = mockDistanceFromAddresses("Bandra", "Airport");
    const b = mockDistanceFromAddresses("  bandra ", "AIRPORT");
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(2);
    expect(a).toBeLessThan(28);
  });
});
