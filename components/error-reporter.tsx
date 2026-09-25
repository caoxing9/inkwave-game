"use client";

import { useEffect, ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";

// Next.js signals control-flow via thrown errors with digest prefixes (redirect, notFound, etc).
// These are NOT actual errors — Next.js runtime handles them upstream.
const NEXT_CONTROL_FLOW_DIGESTS = ["NEXT_REDIRECT", "NEXT_NOT_FOUND", "NEXT_HTTP_ERROR_FALLBACK"];

const isNextControlFlow = (err: unknown): boolean => {
  if (!err || typeof err !== "object") return false;
  const e = err as { digest?: string; name?: string; message?: string };
  if (typeof e.digest === "string" && NEXT_CONTROL_FLOW_DIGESTS.some((p) => e.digest!.startsWith(p))) return true;
  if (e.name === "AbortError" || e.message === "aborted") return true;
  return false;
};

const isTeablePreview = () =>
  (process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_TEABLE_PREVIEW === "1") &&
  typeof window !== "undefined" &&
  window.parent !== window;

if (isTeablePreview()) {
  const s = document.createElement("style");
  s.textContent = "nextjs-portal, script[data-nextjs-dev-overlay] { display: none !important; }";
  document.head.appendChild(s);
}

const toErrorPayload = (payload: unknown): Record<string, unknown> => {
  if (payload && typeof payload === "object") {
    return payload as Record<string, unknown>;
  }

  return {
    detail: typeof payload === "string" ? payload : String(payload),
  };
};

const postError = (payload: unknown) => {
  if (!isTeablePreview()) return;
  try {
    window.parent?.postMessage(
      {
        source: "APP_RUNTIME_ERROR",
        ...toErrorPayload(payload),
      },
      "*"
    );
  } catch {
    // ignore
  }
};

function ErrorFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center p-8">
        <h1 className="text-xl font-semibold text-gray-900 mb-2">Something went wrong</h1>
        <p className="text-gray-500 mb-6">An unexpected error occurred.</p>
      </div>
    </div>
  );
}

export function ReactErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      onError={(error, errorInfo) => {
        if (isNextControlFlow(error)) return;
        postError({
          type: "react-error",
          message: error.message,
          stack: error.stack,
          componentStack: errorInfo.componentStack,
        });
      }}
      FallbackComponent={({ error }) => {
        // Let Next.js runtime handle its own control-flow errors
        if (isNextControlFlow(error)) throw error;
        return <ErrorFallback />;
      }}
    >
      {children}
    </ErrorBoundary>
  );
}

export function ErrorReporter() {
  useEffect(() => {
    if (!isTeablePreview()) return;

    const post = (payload: unknown) => {
      try {
        window.parent?.postMessage(
          {
            source: "APP_RUNTIME_ERROR",
            ...toErrorPayload(payload),
          },
          "*"
        );
      } catch {
        // ignore
      }
    };

    const onError = (event: ErrorEvent) => {
      if (isNextControlFlow(event.error)) return;
      post({
        type: "runtime-error",
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error?.stack,
      });
    };

    const onRejection = (event: PromiseRejectionEvent) => {
      if (isNextControlFlow(event.reason)) return;
      if (event.reason === "aborted") return;
      const reason = event.reason as { message?: string; stack?: string } | string;

      post({
        type: "unhandled-rejection",
        message: typeof reason === "string" ? reason : reason?.message ?? "Unknown error",
        stack: typeof reason === "string" ? undefined : reason?.stack,
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}

export function ConsoleReporter() {
  useEffect(() => {
    if (!isTeablePreview()) return;

    const MAX_ARG_LEN = 2000;

    const stringify = (arg: unknown): string => {
      if (arg === null) return "null";
      if (arg === undefined) return "undefined";
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.stack || arg.message;
      try {
        const s = JSON.stringify(arg, null, 2);
        return s.length > MAX_ARG_LEN ? s.slice(0, MAX_ARG_LEN) + "..." : s;
      } catch {
        return String(arg);
      }
    };

    const levels = ["log", "info", "warn", "error"] as const;
    const originals = Object.fromEntries(
      levels.map((l) => [l, console[l].bind(console)])
    ) as Record<typeof levels[number], (...args: unknown[]) => void>;

    for (const level of levels) {
      console[level] = (...args: unknown[]) => {
        originals[level](...args);
        try {
          window.parent.postMessage(
            { source: "APP_CONSOLE", level, args: args.map(stringify) },
            "*"
          );
        } catch {
          // ignore
        }
      };
    }

    return () => {
      for (const level of levels) {
        console[level] = originals[level];
      }
    };
  }, []);

  return null;
}

