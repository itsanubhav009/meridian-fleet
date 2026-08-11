"use client";

import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";

/**
 * The primitives every screen is assembled from.
 *
 * Kept deliberately small: a button, a field, four state views. Every screen in
 * the app uses these rather than styling its own controls, so a change to focus
 * rings or disabled states happens once.
 */

function cx(...values: Array<string | false | undefined | null>): string {
  return values.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Shows a spinner and blocks further clicks — the first line of defence
   *  against double submission. */
  loading?: boolean;
  size?: "sm" | "md";
}

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: "bg-signal text-white hover:bg-signal-dark border-transparent",
  secondary: "bg-surface text-ink hover:bg-line-soft border-line",
  ghost: "bg-transparent text-muted hover:text-ink hover:bg-line-soft border-transparent",
  danger: "bg-surface text-halt hover:bg-halt-soft border-halt/30",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", loading = false, size = "md", className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md border font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "px-3 py-1.5 text-[13px]" : "px-4 py-2.5 text-sm",
        BUTTON_STYLES[variant],
        className,
      )}
      {...rest}
    >
      {loading && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------
export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-ink-soft">
        {label}
        {required && <span className="ml-1 text-halt">*</span>}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="text-[12px] text-halt">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12px] text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

const CONTROL_CLASSES =
  "w-full rounded-md border bg-surface px-3 py-2.5 text-sm text-ink placeholder:text-muted/60 " +
  "transition-colors focus:border-signal disabled:bg-line-soft disabled:text-muted";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className, invalid, ...rest }, ref) {
    return (
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${rest.id}-error` : undefined}
        className={cx(CONTROL_CLASSES, invalid ? "border-halt" : "border-line", className)}
        {...rest}
      />
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ className, invalid, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cx(CONTROL_CLASSES, "resize-y", invalid ? "border-halt" : "border-line", className)}
        {...rest}
      />
    );
  },
);

export function Select({
  className,
  invalid,
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select
      className={cx(CONTROL_CLASSES, "cursor-pointer", invalid ? "border-halt" : "border-line", className)}
      {...rest}
    >
      {children}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Messages and the four states every data view needs
// ---------------------------------------------------------------------------
export function Alert({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: "info" | "error" | "success";
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const tones = {
    info: "border-line bg-line-soft text-ink-soft",
    error: "border-halt/25 bg-halt-soft text-halt",
    success: "border-signal/25 bg-signal-soft text-signal-dark",
  };
  return (
    <div role={tone === "error" ? "alert" : undefined} className={cx("rounded-md border px-3.5 py-3 text-[13px]", tones[tone])}>
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={title ? "mt-0.5" : undefined}>{children}</div>}
      {action && <div className="mt-2.5">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-md bg-line-soft", className)} />;
}

export function LoadingRows({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="card p-4">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="mt-3 h-4 w-2/3" />
          <Skeleton className="mt-2 h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center px-6 py-12 text-center">
      <div className="mb-3 h-8 w-8 rounded-full border-2 border-dashed border-line" />
      <p className="text-sm font-semibold text-ink">{title}</p>
      <p className="mt-1 max-w-sm text-[13px] text-muted">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = "That did not load",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="card border-halt/25 px-6 py-10 text-center">
      <p className="text-sm font-semibold text-halt">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export { cx };
