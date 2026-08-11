/**
 * One error type for every expected failure in the application.
 *
 * Route handlers never build error responses by hand. They throw an AppError
 * (or let a repository throw one) and the wrapper in src/server/http/handler.ts
 * turns it into a JSON body with the right HTTP status. That is what keeps
 * error shapes consistent across all eight endpoints.
 */

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "INVALID_CREDENTIALS"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RIDE_ALREADY_ASSIGNED"
  | "INVALID_STATUS_TRANSITION"
  | "DRIVER_HAS_ACTIVE_RIDE"
  | "DUPLICATE_REQUEST"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 422,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RIDE_ALREADY_ASSIGNED: 409,
  INVALID_STATUS_TRANSITION: 409,
  DRIVER_HAS_ACTIVE_RIDE: 409,
  DUPLICATE_REQUEST: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Field-level detail, e.g. { pickupAddress: "Pickup address is required" }. */
  readonly details?: Record<string, string[]>;

  constructor(code: ErrorCode, message: string, details?: Record<string, string[]>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const errors = {
  validation: (message: string, details?: Record<string, string[]>) =>
    new AppError("VALIDATION_ERROR", message, details),
  unauthenticated: (message = "Sign in to continue.") =>
    new AppError("UNAUTHENTICATED", message),
  invalidCredentials: (message = "That email and password combination is not correct.") =>
    new AppError("INVALID_CREDENTIALS", message),
  forbidden: (message = "Your account cannot perform this action.") =>
    new AppError("FORBIDDEN", message),
  notFound: (message = "We could not find what you asked for.") =>
    new AppError("NOT_FOUND", message),
  rideAlreadyAssigned: (message = "Another driver accepted this ride first.") =>
    new AppError("RIDE_ALREADY_ASSIGNED", message),
  invalidTransition: (message: string) => new AppError("INVALID_STATUS_TRANSITION", message),
  driverHasActiveRide: (
    message = "Finish or cancel your current ride before accepting another.",
  ) => new AppError("DRIVER_HAS_ACTIVE_RIDE", message),
  rateLimited: (message = "Too many attempts. Wait a minute and try again.") =>
    new AppError("RATE_LIMITED", message),
  internal: (message = "Something went wrong on our side.") =>
    new AppError("INTERNAL_ERROR", message),
};

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
