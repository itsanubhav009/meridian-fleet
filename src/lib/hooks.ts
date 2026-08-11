"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api";
import type { AdminMetrics, Paginated, Ride, UserSummary } from "@/domain/types";
import type { RideStatus, TransitionRule } from "@/domain/rideStatus";
import { ACTIVE_STATUSES } from "@/domain/rideStatus";
import type { CreateRideInput } from "./schemas";

/**
 * Server state lives in React Query; local state (form fields, which tab is
 * open, whether a dialog is showing) lives in component useState. Keeping the
 * two apart is the reason none of these screens hold a copy of a ride in state
 * that can drift out of date.
 *
 * Freshness comes from polling. Every ride view refetches on an interval while
 * the ride is moving, and stops once it reaches a terminal status — there is
 * nothing left to watch on a completed ride, so we stop asking. See
 * docs/ARCHITECTURE.md for how this would become a WebSocket or SSE stream.
 */

export interface RideWithActions extends Ride {
  availableActions: TransitionRule[];
  canAccept: boolean;
}

const LIVE_POLL_MS = 5_000;
const QUIET_POLL_MS = 15_000;

export const queryKeys = {
  session: ["session"] as const,
  rides: (params: Record<string, unknown>) => ["rides", params] as const,
  ride: (id: string) => ["ride", id] as const,
  metrics: (params: Record<string, unknown>) => ["metrics", params] as const,
  directory: ["directory"] as const,
};

function isMoving(status: RideStatus | undefined): boolean {
  if (!status) return false;
  return status === "REQUESTED" || (ACTIVE_STATUSES as readonly string[]).includes(status);
}

function toQueryString(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
export function useSession() {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: () => api.get<{ user: UserSummary }>("/api/auth/me"),
    // A 401 here means "not signed in", which is an answer, not a failure.
    retry: false,
    staleTime: 60_000,
  });
}

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      api.post<{ user: UserSummary }>("/api/auth/login", input),
    onSuccess: (data) => {
      client.setQueryData(queryKeys.session, data);
    },
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: true }>("/api/auth/logout"),
    onSuccess: () => client.clear(),
  });
}

// ---------------------------------------------------------------------------
// Rides
// ---------------------------------------------------------------------------
export interface RideListParams {
  scope?: "mine" | "available" | "all";
  status?: RideStatus[] | string;
  customerId?: string;
  driverId?: string;
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export function useRides(params: RideListParams = {}, options: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.rides(params as Record<string, unknown>),
    queryFn: () =>
      api.get<Paginated<RideWithActions>>(`/api/rides${toQueryString(params as Record<string, unknown>)}`),
    // Lists refresh on a slower beat than a single ride being watched.
    refetchInterval: options.poll === false ? false : QUIET_POLL_MS,
    placeholderData: (previous) => previous, // no flash of empty state when filters change
  });
}

export function useRide(rideId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.ride(rideId ?? "none"),
    queryFn: () => api.get<{ ride: RideWithActions }>(`/api/rides/${rideId}`),
    enabled: Boolean(rideId),
    // Poll only while the ride can still change.
    refetchInterval: (query) => (isMoving(query.state.data?.ride.status) ? LIVE_POLL_MS : false),
  });
}

/** Everything a ride change touches: the ride itself, every list, the metrics. */
function invalidateRideViews(client: QueryClient, rideId?: string) {
  if (rideId) void client.invalidateQueries({ queryKey: queryKeys.ride(rideId) });
  void client.invalidateQueries({ queryKey: ["rides"] });
  void client.invalidateQueries({ queryKey: ["metrics"] });
}

export function useCreateRide() {
  const client = useQueryClient();
  return useMutation({
    /**
     * The idempotency key is generated once per submission attempt and sent as
     * a header. If the response is lost and the customer taps again, the server
     * recognises the key and returns the original booking instead of making a
     * second one.
     */
    mutationFn: (input: CreateRideInput & { idempotencyKey: string }) => {
      const { idempotencyKey, ...body } = input;
      return api.post<{ ride: RideWithActions; duplicate: boolean }>("/api/rides", body, {
        "Idempotency-Key": idempotencyKey,
      });
    },
    onSuccess: (data) => invalidateRideViews(client, data.ride.id),
  });
}

export function useAcceptRide() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (rideId: string) =>
      api.post<{ ride: RideWithActions }>(`/api/rides/${rideId}/accept`),
    onSuccess: (data) => invalidateRideViews(client, data.ride.id),
    // Losing the race is an expected outcome, not a transient failure, so
    // there is nothing to gain from retrying it.
    retry: false,
  });
}

export function useUpdateStatus() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { rideId: string; status: RideStatus; expectedStatus?: RideStatus; note?: string }) =>
      api.patch<{ ride: RideWithActions }>(`/api/rides/${input.rideId}/status`, {
        status: input.status,
        expectedStatus: input.expectedStatus,
        note: input.note,
      }),
    onSuccess: (data) => invalidateRideViews(client, data.ride.id),
    retry: false,
  });
}

export function useCancelRide() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { rideId: string; reason?: string }) =>
      api.post<{ ride: RideWithActions }>(`/api/rides/${input.rideId}/cancel`, {
        reason: input.reason,
      }),
    onSuccess: (data) => invalidateRideViews(client, data.ride.id),
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
export function useMetrics(params: { from?: string; to?: string; driverId?: string; customerId?: string } = {}) {
  return useQuery({
    queryKey: queryKeys.metrics(params),
    queryFn: () => api.get<AdminMetrics>(`/api/admin/metrics${toQueryString(params)}`),
    refetchInterval: QUIET_POLL_MS,
    placeholderData: (previous) => previous,
  });
}

export function useDirectory() {
  return useQuery({
    queryKey: queryKeys.directory,
    queryFn: () => api.get<{ drivers: UserSummary[]; customers: UserSummary[] }>("/api/users"),
    staleTime: 5 * 60_000, // the roster barely changes
  });
}

export { ApiError };
