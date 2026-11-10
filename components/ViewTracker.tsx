"use client";

import { useEffect } from "react";

/** 共有求人ページの閲覧を記録する（開いた・滞在時間・最大スクロール・PDF を開いたか） */
export default function ViewTracker({ token }: { token: string }) {
  useEffect(() => {
    const url = `/j/${encodeURIComponent(token)}/track`;
    const visitId = crypto.randomUUID();
    let maxScroll = 0;
    let pdf = false;
    let visibleMs = 0;
    let since = document.visibilityState === "visible" ? Date.now() : 0;

    const scrollPct = () => {
      const h = document.documentElement.scrollHeight - window.innerHeight;
      return h <= 0 ? 100 : Math.round(((window.scrollY + 0) / h) * 100);
    };
    const duration = () => Math.round((visibleMs + (since ? Date.now() - since : 0)) / 1000);
    const send = (event: "start" | "ping") => {
      const body = JSON.stringify({ visitId, event, scroll: maxScroll, duration: duration(), pdf });
      if (!navigator.sendBeacon?.(url, body)) {
        fetch(url, { method: "POST", body, keepalive: true }).catch(() => {});
      }
    };

    maxScroll = scrollPct();
    send("start");

    const onScroll = () => {
      maxScroll = Math.max(maxScroll, scrollPct());
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (since) visibleMs += Date.now() - since;
        since = 0;
        send("ping");
      } else {
        since = Date.now();
      }
    };
    const onClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest("[data-track='pdf']")) {
        pdf = true;
        send("ping");
      }
    };
    const timer = window.setInterval(() => document.visibilityState === "visible" && send("ping"), 15000);

    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("click", onClick);
    window.addEventListener("pagehide", () => send("ping"));
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("click", onClick);
    };
  }, [token]);
  return null;
}
