import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError, errors, isAppError } from "../errors";
import { isUniqueViolation } from "../db/types";

/**
 * Centralised error handling for every API route.
 *
 * Each route exports `export const POST = route(async (request) => ...)`. The
 * wrapper is the only place in the codebase that decides how a failure becomes
 * an HTTP response, so every endpoint fails in the same shape:
 *
 *   { "error": { "code": "VALIDATION_ERROR", "message": "...", "details": {...} } }
 *
 * It also catches the async errors a route forgot about. Without it, a rejected
 * promise inside a handler becomes an unstyled 500 with a stack trace in the
 * body, which is both a bad experience and an information leak.
 */

export type RouteContext<P = Record<string, string>> = { params: Promise<P> };
export type RouteHandler<P = Record<string, string>> = (
  request: Request,
  context: RouteContext<P>,
) => Promise<Response>;

export function route<P = Record<string, string>>(handler: RouteHandler<P>): RouteHandler<P> {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

export function toErrorResponse(error: unknown): NextResponse {
  if (isAppError(error)) {
    return NextResponse.json(error.toJSON(), { status: error.status });
  }

  if (error instanceof ZodError) {
    const appError = fromZodError(error);
    return NextResponse.json(appError.toJSON(), { status: appError.status });
  }

  // A unique violation that reached this far is a race we did not name
  // explicitly. 409 is more truthful than 500.
  if (isUniqueViolation(error)) {
    const conflict = errors.rideAlreadyAssigned(
      "That action conflicted with another change. Refresh and try again.",
    );
    return NextResponse.json(conflict.toJSON(), { status: conflict.status });
  }

  // Anything below here is a bug. Log the detail server-side; return a generic
  // message so internals are never exposed to the client.
  const incidentId = crypto.randomUUID();
  console.error(`[${incidentId}] Unhandled error:`, error);
  const internal = errors.internal();
  return NextResponse.json(
    { error: { ...internal.toJSON().error, incidentId } },
    { status: internal.status },
  );
}

export function fromZodError(error: ZodError): AppError {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    (details[key] ??= []).push(issue.message);
  }
  const first = error.issues[0];
  return errors.validation(first ? first.message : "Some fields need attention.", details);
}

export function json<T>(body: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(body, init);
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 }) as NextResponse;
}
