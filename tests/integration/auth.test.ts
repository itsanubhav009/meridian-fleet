import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { GET as meRoute } from "@/app/api/auth/me/route";
import { GET as metricsRoute } from "@/app/api/admin/metrics/route";
import { POST as createRideRoute } from "@/app/api/rides/route";
import { SignJWT } from "jose";
import { call, createHarness, rideRequest, TEST_PASSWORD, type Harness } from "../helpers/harness";
import { resetLoginThrottle } from "@/server/services/authService";

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  resetLoginThrottle();
});

describe("POST /api/auth/login", () => {
  it("returns a token and the user for correct credentials", async () => {
    const res = await call(loginRoute, {
      method: "POST",
      url: "/api/auth/login",
      body: { email: h.customer.email, password: TEST_PASSWORD },
    });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(h.customer.email);
    expect(res.body.token).toBeTypeOf("string");
    // The password hash must never leave the server.
    expect(JSON.stringify(res.body)).not.toContain("$2a$");
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it("sets an httpOnly session cookie that JavaScript cannot read", async () => {
    const res = await call(loginRoute, {
      method: "POST",
      url: "/api/auth/login",
      body: { email: h.admin.email, password: TEST_PASSWORD },
    });

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("fleet_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("rejects a wrong password", async () => {
    const res = await call(loginRoute, {
      method: "POST",
      url: "/api/auth/login",
      body: { email: h.customer.email, password: "not-the-password" },
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("gives an unknown email the same answer as a wrong password", async () => {
    const unknown = await call(loginRoute, {
      method: "POST",
      url: "/api/auth/login",
      body: { email: "nobody@test.local", password: TEST_PASSWORD },
    });
    const wrongPassword = await call(loginRoute, {
      method: "POST",
      url: "/api/auth/login",
      body: { email: h.customer.email, password: "wrong" },
    });

    // Identical status and message, so the form cannot be used to discover
    // which email addresses have accounts.
    expect(unknown.status).toBe(wrongPassword.status);
    expect(unknown.body.error.message).toBe(wrongPassword.body.error.message);
  });

  it("rejects a malformed body with field-level detail", async () => {
    const res = await call(loginRoute, {
      method: "POST",
      url: "/api/auth/login",
      body: { email: "not-an-email", password: "" },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details).toHaveProperty("email");
    expect(res.body.error.details).toHaveProperty("password");
  });

  it("throttles repeated failures for one account", async () => {
    for (let i = 0; i < 8; i += 1) {
      await call(loginRoute, {
        method: "POST",
        url: "/api/auth/login",
        body: { email: h.driver.email, password: "wrong" },
      });
    }
    const res = await call(loginRoute, {
      method: "POST",
      url: "/api/auth/login",
      body: { email: h.driver.email, password: TEST_PASSWORD },
    });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
  });
});

describe("token verification", () => {
  it("accepts a valid token", async () => {
    const res = await call(meRoute, { url: "/api/auth/me", token: h.customer.token });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(h.customer.id);
  });

  it("rejects a request with no token", async () => {
    const res = await call(meRoute, { url: "/api/auth/me" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a token signed with the wrong secret", async () => {
    const forged = await new SignJWT({ role: "ADMIN", name: "Mallory", email: "m@test.local" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(h.customer.id)
      .setIssuer("meridian-fleet")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("a-completely-different-secret-key-32-chars"));

    const res = await call(meRoute, { url: "/api/auth/me", token: forged });
    expect(res.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const expired = await new SignJWT({ role: "CUSTOMER", name: "Cara", email: h.customer.email })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(h.customer.id)
      .setIssuer("meridian-fleet")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(process.env.JWT_SECRET!));

    const res = await call(meRoute, { url: "/api/auth/me", token: expired });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a token whose payload has been tampered with", async () => {
    const [header, payload, signature] = h.customer.token.split(".");
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString());
    decoded.role = "ADMIN"; // privilege escalation attempt
    const tampered = [
      header,
      Buffer.from(JSON.stringify(decoded)).toString("base64url"),
      signature,
    ].join(".");

    const res = await call(metricsRoute, { url: "/api/admin/metrics", token: tampered });
    expect(res.status).toBe(401);
  });
});

describe("role-based authorization on the server", () => {
  it("stops a customer from reading admin metrics", async () => {
    const res = await call(metricsRoute, { url: "/api/admin/metrics", token: h.customer.token });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("stops a driver from reading admin metrics", async () => {
    const res = await call(metricsRoute, { url: "/api/admin/metrics", token: h.driver.token });
    expect(res.status).toBe(403);
  });

  it("lets an admin read them", async () => {
    const res = await call(metricsRoute, { url: "/api/admin/metrics", token: h.admin.token });
    expect(res.status).toBe(200);
  });

  it("stops a driver from creating a booking", async () => {
    const res = await call(createRideRoute, {
      method: "POST",
      url: "/api/rides",
      token: h.driver.token,
      body: rideRequest(),
    });
    expect(res.status).toBe(403);
  });
});
