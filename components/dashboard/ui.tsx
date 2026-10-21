"use client";

import { ReactNode, useEffect, useRef, useState } from "react";

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border p-3.5 sm:p-5 ${className}`}
      style={{ background: "var(--surface-1)", borderColor: "var(--hairline)" }}
    >
      {(title || actions) && (
        <header className="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div>
            {title && (
              <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="mt-0.5 text-xs" style={{ color: "var(--text-secondary)" }}>
                {subtitle}
              </p>
            )}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

/** 数字そのものが主役のときに使うタイル（1本だけの棒グラフは作らない） */
export function StatTile({
  label,
  value,
  unit,
  delta,
  deltaLabel,
  hint,
  tone = "neutral",
  className = "",
}: {
  label: string;
  value: string | number;
  unit?: string;
  /** 前週差など。正が良い前提で色を付ける。 */
  delta?: number | null;
  deltaLabel?: string;
  /** 補足。配列で渡すと1行ずつ縦に並べる（1行に詰め込むと読めないため）。 */
  hint?: string | string[];
  tone?: "neutral" | "good" | "critical";
  className?: string;
}) {
  const toneColor =
    tone === "good" ? "var(--status-good)" : tone === "critical" ? "var(--status-critical)" : "var(--text-primary)";

  return (
    <div
      className={`rounded-xl border p-3 sm:p-4 ${className}`}
      style={{ background: "var(--surface-1)", borderColor: "var(--hairline)" }}
    >
      <div className="text-[11px] leading-snug sm:text-xs" style={{ color: "var(--text-secondary)" }}>
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-xl font-semibold tracking-tight sm:text-2xl" style={{ color: toneColor }}>
          {value}
        </span>
        {unit && (
          <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
            {unit}
          </span>
        )}
      </div>
      {delta !== undefined && delta !== null && (
        <div className="mt-1 flex items-center gap-1 text-xs tabular">
          <span style={{ color: delta > 0 ? "var(--delta-up)" : delta < 0 ? "var(--delta-down)" : "var(--text-muted)" }}>
            {delta > 0 ? "▲" : delta < 0 ? "▼" : "±"} {Math.abs(delta)}
          </span>
          {deltaLabel && <span style={{ color: "var(--text-muted)" }}>{deltaLabel}</span>}
        </div>
      )}
      {hint && (
        <div className="mt-1 space-y-0.5 text-[11px] leading-snug" style={{ color: "var(--text-muted)" }}>
          {(Array.isArray(hint) ? hint : [hint]).map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
          <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: it.color }} aria-hidden />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

/** チャートの実ピクセル幅を測る（viewBoxの引き伸ばしで文字が潰れるのを避けるため） */
export function useMeasuredWidth<T extends HTMLElement>(fallback = 720) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

export interface TooltipState {
  x: number;
  y: number;
  rows: { label: string; value: string }[];
  title: string;
}

export function ChartTooltip({ state, containerWidth }: { state: TooltipState | null; containerWidth: number }) {
  if (!state) return null;
  // 右端でカードからはみ出さないよう、位置を内側に寄せる
  const clampedLeft = Math.min(Math.max(state.x, 76), Math.max(containerWidth - 76, 76));

  return (
    <div
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border px-2.5 py-1.5 text-xs shadow-lg"
      style={{
        left: clampedLeft,
        top: state.y - 8,
        background: "var(--surface-1)",
        borderColor: "var(--hairline)",
        color: "var(--text-primary)",
        minWidth: 120,
      }}
      role="status"
    >
      <div className="mb-0.5 font-semibold">{state.title}</div>
      {state.rows.map((r) => (
        <div key={r.label} className="flex justify-between gap-3 tabular">
          <span style={{ color: "var(--text-secondary)" }}>{r.label}</span>
          <span>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div
      className="rounded-xl border border-dashed px-6 py-10 text-center"
      style={{ borderColor: "var(--baseline)" }}
    >
      <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
        {title}
      </p>
      {children && (
        <div className="mx-auto mt-2 max-w-md text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * 前提情報を畳んでおくためのモーダル。
 *
 * 数字の定義や凡例は、見るのは最初の1回か、数字を疑ったときだけ。
 * 画面に常に置いておくと本題の表やグラフが埋もれるので、押したときだけ出す。
 */
export function Modal({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  // Escで閉じられないと、スマホでは戻る手段が分かりにくい
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // 背面が一緒にスクロールすると、どこを見ているか分からなくなる
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-t-2xl border sm:rounded-2xl"
        style={{ background: "var(--surface-1)", borderColor: "var(--hairline)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="flex items-center justify-between gap-3 border-b px-4 py-3"
          style={{ borderColor: "var(--gridline)" }}
        >
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="rounded-lg border px-2.5 py-1 text-xs"
            style={{ borderColor: "var(--hairline)", color: "var(--text-secondary)" }}
          >
            閉じる
          </button>
        </header>
        <div className="overflow-y-auto px-4 py-4">{children}</div>
      </div>
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "secondary",
  disabled,
  type = "button",
  block = false,
  "aria-expanded": ariaExpanded,
  "aria-haspopup": ariaHasPopup,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
  /** メニュー内など、横幅いっぱいに広げたいとき */
  block?: boolean;
  "aria-expanded"?: boolean;
  "aria-haspopup"?: boolean | "menu";
}) {
  const styles =
    variant === "primary"
      ? { background: "var(--series-1)", color: "#ffffff", borderColor: "transparent" }
      : variant === "danger"
        ? { background: "transparent", color: "var(--status-critical)", borderColor: "var(--hairline)" }
        : { background: "transparent", color: "var(--text-primary)", borderColor: "var(--hairline)" };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHasPopup}
      className={`min-h-9 whitespace-nowrap rounded-lg border px-3 py-2 text-xs font-medium transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0 sm:py-1.5 ${block ? "w-full text-left" : ""}`}
      style={styles}
    >
      {children}
    </button>
  );
}
