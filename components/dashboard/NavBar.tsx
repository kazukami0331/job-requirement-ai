"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/dashboard", label: "採用モニタリング", short: "モニタリング" },
  { href: "/", label: "求人要件ヒアリングAI", short: "求人要件AI" },
];

export default function NavBar() {
  const pathname = usePathname();

  return (
    <nav
      className="sticky top-0 z-20 border-b backdrop-blur"
      style={{ borderColor: "var(--hairline)", background: "color-mix(in srgb, var(--background) 88%, transparent)" }}
    >
      <div className="mx-auto flex w-full max-w-6xl items-center gap-1 px-4 py-2">
        <span className="mr-2 hidden text-xs font-semibold sm:inline" style={{ color: "var(--text-muted)" }}>
          採用ダッシュボード
        </span>
        {LINKS.map((l) => {
          const active = pathname === l.href;
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              className="whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs transition-opacity hover:opacity-80"
              style={{
                color: active ? "var(--series-1)" : "var(--text-secondary)",
                fontWeight: active ? 600 : 400,
                background: active ? "color-mix(in srgb, var(--series-1) 10%, transparent)" : "transparent",
              }}
            >
              <span className="sm:hidden">{l.short}</span>
              <span className="hidden sm:inline">{l.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
