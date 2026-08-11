import { z } from "zod";
import { errors } from "../errors";
import { fromZodError } from "./handler";

/**
 * Every request body is parsed by a Zod schema before it reaches a service.
 * Services can then trust their inputs, and the 422 response tells the client
 * exactly which field was wrong.
 */

export async function parseBody<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw errors.validation("The request body must be valid JSON.");
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}

export function parseQuery<S extends z.ZodTypeAny>(request: Request, schema: S): z.infer<S> {
  const params = new URL(request.url).searchParams;
  const raw: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (value !== "") raw[key] = value;
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}

/** Rejects anything that is not a UUID, so a bad path param is a 422 not a 500. */
export const uuidSchema = z.string().uuid("That is not a valid identifier.");

export function parseUuid(value: string, label = "identifier"): string {
  const result = uuidSchema.safeParse(value);
  if (!result.success) throw errors.validation(`That is not a valid ${label}.`);
  return result.data;
}
