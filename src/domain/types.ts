import type { Role, RideStatus } from "./rideStatus";

/** A user as the API exposes it. Note the absence of password_hash. */
export interface UserSummary {
  id: string;
  name: string;
  email: string;
  role: Role;
  phone: string | null;
  vehicle: string | null;
}

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface RideHistoryEntry {
  id: string;
  rideId: string;
  previousStatus: RideStatus | null;
  newStatus: RideStatus;
  changedBy: { id: string; name: string; role: Role };
  note: string | null;
  createdAt: string;
}

export interface Ride {
  id: string;
  reference: string;
  status: RideStatus;
  customer: Pick<UserSummary, "id" | "name" | "email" | "phone">;
  driver: Pick<UserSummary, "id" | "name" | "email" | "phone" | "vehicle"> | null;
  pickupAddress: string;
  destinationAddress: string;
  pickup: Coordinates | null;
  destination: Coordinates | null;
  estimatedDistanceKm: number;
  estimatedFareCents: number;
  notes: string | null;
  cancellationReason: string | null;
  requestedAt: string;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  /** Present on GET /api/rides/:id only. */
  history?: RideHistoryEntry[];
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface AdminMetrics {
  totals: {
    all: number;
    requested: number;
    active: number;
    completed: number;
    cancelled: number;
  };
  byStatus: Record<RideStatus, number>;
  revenue: {
    completedRideRevenueCents: number;
    averageCompletedFareCents: number;
    currency: string;
  };
  fleet: {
    totalDrivers: number;
    driversOnTrip: number;
    totalCustomers: number;
  };
  generatedAt: string;
}
