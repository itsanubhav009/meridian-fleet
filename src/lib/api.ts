/**
 * The single place the browser talks to the API.
 *
 * Every component and hook goes through this file, so error handling, the JSON
 * contract and credential handling are defined once. UI code never calls fetch
 * directly — that separation is what keeps components about rendering.
 */

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, string[]>;
    incidentId?: string;
  };
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, string[]>;
  readonly incidentId?: string;

  constructor(status: number, body: ApiErrorBody["error"]) {
    super(body.message);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code;
    this.details = body.details;
    this.incidentId = body.incidentId;
  }

  /** True for failures a retry might fix. Drives whether we show "Try again". */
  get isRetryable(): boolean {
    return this.status >= 500 || this.code === "NETWORK_ERROR" || this.code === "TIMEOUT";
  }
}

const TIMEOUT_MS = 15_000;

export async function apiFetch<T>(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      signal: controller.signal,
      credentials: "same-origin", // send the httpOnly session cookie
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    // A dropped connection or a timeout never reaches the server, so there is
    // no JSON body to read. Surface it as a first-class error the UI can
    // explain, rather than an unhandled rejection.
    const aborted = error instanceof DOMException && error.name === "AbortError";
    throw new ApiError(0, {
      code: aborted ? "TIMEOUT" : "NETWORK_ERROR",
      message: aborted
        ? "That took too long. Check your connection and try again."
        : "Could not reach the server. Check your connection and try again.",
    });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const errorBody = (body as ApiErrorBody | null)?.error;
    throw new ApiError(
      response.status,
      errorBody ?? { code: "INTERNAL_ERROR", message: "Something went wrong. Try again." },
    );
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    apiFetch<T>(path, { method: "POST", body: JSON.stringify(body ?? {}), headers }),
  patch: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
};

/** Turns an unknown thrown value into something safe to show a person. */
export function errorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/** Field-level messages from a 422, keyed by field name. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || !error.details) return {};
  return Object.fromEntries(
    Object.entries(error.details).map(([field, messages]) => [field, messages[0] ?? ""]),
  );
}
