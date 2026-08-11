"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useLogout, useSession } from "@/lib/hooks";
import type { Role } from "@/domain/rideStatus";
import { Button, LoadingRows, cx } from "./ui";

/**
 * The frame around every signed-in screen.
 *
 * It also does a client-side guard: if the session query comes back
 * unauthenticated, or the signed-in role does not match the area being viewed,
 * it sends the person somewhere they belong. This is a convenience, not a
 * security control — every API route re-checks the session and the role on the
 * server, so bypassing this redirect gets you an empty screen and 401s.
 */

const HOME_FOR_ROLE: Record<Role, string> = {
  CUSTOMER: "/customer",
  DRIVER: "/driver",
  ADMIN: "/admin",
};

const ROLE_LABEL: Record<Role, string> = {
  CUSTOMER: "Customer",
  DRIVER: "Driver",
  ADMIN: "Dispatch",
};

export function AppShell({
  allow,
  title,
  subtitle,
  actions,
  children,
}: {
  /** Roles permitted to see this screen. Others are redirected home. */
  allow?: Role[];
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const router = useRouter();
  const { data, isLoading, isError } = useSession();
  const logout = useLogout();
  const user = data?.user;

  useEffect(() => {
    if (isLoading) return;
    if (isError || !user) {
      router.replace("/");
      return;
    }
    if (allow && !allow.includes(user.role)) {
      router.replace(HOME_FOR_ROLE[user.role]);
    }
  }, [allow, isError, isLoading, router, user]);

  if (isLoading || !user) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-16">
        <LoadingRows count={2} />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">
          <Link href={HOME_FOR_ROLE[user.role]} className="flex items-baseline gap-2">
            <span className="font-mono text-[13px] font-bold tracking-[0.16em] text-signal">
              MERIDIAN
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
              Fleet
            </span>
          </Link>

          <span className="ml-auto hidden text-right sm:block">
            <span className="block text-[13px] font-medium text-ink">{user.name}</span>
            <span className="eyebrow">{ROLE_LABEL[user.role]}</span>
          </span>

          <Button
            variant="ghost"
            size="sm"
            loading={logout.isPending}
            onClick={() => logout.mutate(undefined, { onSuccess: () => router.replace("/") })}
          >
            Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6 sm:py-8">
        <div className={cx("mb-6 flex flex-wrap items-end justify-between gap-3")}>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">{title}</h1>
            {subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
          </div>
          {actions}
        </div>
        {children}
      </main>
    </div>
  );
}
