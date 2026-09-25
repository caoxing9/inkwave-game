"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

export function AppAnalytics() {
  const pathname = usePathname();
  const lastPathRef = useRef<string>("");

  useEffect(() => {
    if (pathname === lastPathRef.current) return;
    lastPathRef.current = pathname;

    const data: Record<string, string> = {
      page: pathname,
      referrer: document.referrer || "",
      screen: window.innerWidth + "x" + window.innerHeight,
      lang: navigator.language || "",
    };

    try {
      const perf = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      if (perf?.loadEventEnd) {
        data.loadTime = String(Math.round(perf.loadEventEnd - perf.startTime));
      }
    } catch {
      // ignore
    }

    const payload = JSON.stringify(data);
    try {
      const blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon?.("/api/beacon", blob)) return;
    } catch {
      // fallback
    }
    fetch("/api/beacon", {
      method: "POST",
      body: payload,
      keepalive: true,
      headers: { "Content-Type": "application/json" },
    }).catch(() => {});
  }, [pathname]);

  return null;
}
