import { formatMoney } from "@/domain/fare";

/** Presentation helpers shared across the three role interfaces. */

export { formatMoney };

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);

  if (Math.abs(minutes) < 1) return "just now";
  if (minutes > 0) {
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} hr ago`;
    return `${Math.round(hours / 24)} d ago`;
  }
  const ahead = Math.abs(minutes);
  if (ahead < 60) return `in ${ahead} min`;
  const hours = Math.round(ahead / 60);
  if (hours < 24) return `in ${hours} hr`;
  return `in ${Math.round(hours / 24)} d`;
}

export function formatDistance(km: number): string {
  return `${km.toFixed(1)} km`;
}

/** Value for a datetime-local input, offset to the browser's timezone. */
export function toLocalInputValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
