"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { useLogin, useSession } from "@/lib/hooks";
import { errorMessage, fieldErrors } from "@/lib/api";
import { loginSchema } from "@/lib/schemas";
import { Alert, Button, Field, Input, Spinner } from "@/components/ui";

const HOME_FOR_ROLE = {
  CUSTOMER: "/customer",
  DRIVER: "/driver",
  ADMIN: "/admin",
} as const;

/**
 * The demo accounts panel is a convenience for reviewers.
 * The password is read from an environment variable rather than written into
 * the source, so no credential is committed to the repository. When it is not
 * set, the emails still show and the password is typed by hand.
 */
const DEMO_PASSWORD = process.env.NEXT_PUBLIC_DEMO_PASSWORD ?? "";

const DEMO_ACCOUNTS = [
  { role: "Customer", email: "priya@meridianfleet.test", blurb: "Books rides, watches status, cancels" },
  { role: "Driver", email: "rahul@meridianfleet.test", blurb: "Takes jobs from the open queue" },
  { role: "Dispatch", email: "admin@meridianfleet.test", blurb: "Sees the whole fleet and the numbers" },
];

export default function SignInPage() {
  const router = useRouter();
  const session = useSession();
  const login = useLogin();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});

  // Already signed in? Go straight to the right home screen.
  useEffect(() => {
    if (session.data?.user) router.replace(HOME_FOR_ROLE[session.data.user.role]);
  }, [router, session.data]);

  const serverErrors = fieldErrors(login.error);
  const errors = { ...serverErrors, ...clientErrors };

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (login.isPending) return; // a second submit while one is in flight does nothing

    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join(".");
        if (!next[key]) next[key] = issue.message;
      }
      setClientErrors(next);
      return;
    }

    setClientErrors({});
    login.mutate(parsed.data, {
      onSuccess: (data) => router.replace(HOME_FOR_ROLE[data.user.role]),
    });
  }

  if (session.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-5 w-5 text-muted" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col justify-center px-4 py-10">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-8">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-sm font-bold tracking-[0.2em] text-signal">MERIDIAN</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted">Fleet</span>
          </div>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink">
            Book a ride, take a job, run the fleet.
          </h1>
          <p className="mt-2 text-[13px] text-muted">
            One board, three views. Sign in to see yours.
          </p>
        </div>

        <form onSubmit={handleSubmit} noValidate className="card space-y-4 p-5">
          {login.isError && Object.keys(serverErrors).length === 0 && (
            <Alert tone="error">{errorMessage(login.error)}</Alert>
          )}

          <Field label="Email" htmlFor="email" error={errors.email} required>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              autoFocus
              placeholder="you@example.com"
              value={email}
              invalid={Boolean(errors.email)}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>

          <Field label="Password" htmlFor="password" error={errors.password} required>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              invalid={Boolean(errors.password)}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>

          <Button type="submit" variant="primary" className="w-full" loading={login.isPending}>
            {login.isPending ? "Signing in" : "Sign in"}
          </Button>
        </form>

        <div className="mt-6">
          <p className="eyebrow mb-2">Demo accounts</p>
          <div className="space-y-1.5">
            {DEMO_ACCOUNTS.map((account) => (
              <button
                key={account.email}
                type="button"
                className="card flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:border-signal/40"
                onClick={() => {
                  setEmail(account.email);
                  if (DEMO_PASSWORD) setPassword(DEMO_PASSWORD);
                  setClientErrors({});
                }}
              >
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-signal">
                  {account.role}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{account.blurb}</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted">
            {DEMO_PASSWORD
              ? "Tap an account to fill the form, then sign in."
              : "Tap an account to fill the email. The password is the SEED_PASSWORD from your environment file."}
          </p>
        </div>
      </div>
    </div>
  );
}
