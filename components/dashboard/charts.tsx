"use client";

import { useState } from "react";
import { WeeklyPoint, FunnelStep } from "@/lib/recruiting/aggregate";
import { ChartTooltip, TooltipState, useMeasuredWidth } from "./ui";

const AXIS_W = 30;
const PAD_T = 12;
const PAD_R = 8;
const AXIS_H = 26;
const BAR_GAP = 2; // 隣り合う棒のあいだに入れる地の色の隙間
const RADIUS = 4;

const MAX_BAR_W = 44; // 週が少ないときに棒が太い塊にならないよう上限を置く

/** 目盛りを読みやすい刻みに丸める。余白を取りすぎると棒が潰れるので刻みは細かめ。 */
function niceMax(value: number): number {
  if (value <= 4) return 4;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  for (const step of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const candidate = step * pow;
    if (candidate >= value) return candidate;
  }
  return 10 * pow;
}

/**
 * 週次の応募数。1系列なのでタイトルが系列名を兼ね、凡例は置かない。
 * 数字はホバーで読ませ、直接ラベルは最新週だけに絞る。
 */
export function WeeklyTrendChart({ points }: { points: WeeklyPoint[] }) {
  const { ref, width } = useMeasuredWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TooltipState | null>(null);

  if (points.length === 0) return null;

  // 狭い画面では背を低くして、1画面に入る量を増やす
  const narrow = width < 480;
  const height = narrow ? 180 : 220;
  const plotW = Math.max(width - AXIS_W - PAD_R, 40);
  const plotH = height - PAD_T - AXIS_H;
  const max = niceMax(Math.max(...points.map((p) => p.applied), 1));
  const slot = plotW / points.length;
  const barW = Math.min(Math.max(slot - BAR_GAP, 2), MAX_BAR_W);
  const ticks = [0, max / 2, max];
  // 全週に件数を出す。週が増えたら文字を詰めて重ならないようにする。
  const valueSize = Math.max(9, Math.min(11, slot * 0.42));

  // 週が多いときは軸ラベルを間引く
  const labelStep = Math.ceil(points.length / Math.max(Math.floor(plotW / 46), 1));

  return (
    <div ref={ref} className="relative w-full">
      <svg width={width} height={height} role="img" aria-label="週ごとの応募数の推移">
        {ticks.map((t) => {
          const y = PAD_T + plotH - (t / max) * plotH;
          return (
            <g key={t}>
              <line x1={AXIS_W} x2={width - PAD_R} y1={y} y2={y} stroke="var(--gridline)" strokeWidth={1} />
              <text x={AXIS_W - 6} y={y + 3} textAnchor="end" fontSize={10} fill="var(--text-muted)" className="tabular">
                {t}
              </text>
            </g>
          );
        })}

        {points.map((p, i) => {
          const show = () =>
            setTip({
              x: AXIS_W + i * slot + slot / 2,
              y: Math.max(PAD_T + plotH - (p.applied / max) * plotH, PAD_T + 12),
              title: `${p.week.start} 〜 ${p.week.end}`,
              rows: [
                { label: "応募", value: `${p.applied}件` },
                { label: "面接設定", value: `${p.scheduled}件` },
                { label: "面接実施", value: `${p.interviewed}件` },
                { label: "採用", value: `${p.hired}件` },
                { label: "選考中", value: `${p.activePool}件` },
              ],
            });

          const h = (p.applied / max) * plotH;
          const x = AXIS_W + i * slot + (slot - barW) / 2;
          const y = PAD_T + plotH - h;

          return (
            <g key={p.week.key}>
              {/* 当たり判定は棒より広く取る */}
              <rect
                x={AXIS_W + i * slot}
                y={PAD_T}
                width={slot}
                height={plotH}
                fill="transparent"
                // マウスはホバーで、タッチはタップで出す（タップ時は離しても消さない）
                onPointerEnter={(e) => {
                  if (e.pointerType === "mouse") show();
                }}
                onPointerLeave={(e) => {
                  if (e.pointerType === "mouse") setTip(null);
                }}
                onPointerDown={show}
              />
              {p.applied > 0 && (
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={h}
                  rx={Math.min(RADIUS, barW / 2)}
                  fill="var(--series-1)"
                  pointerEvents="none"
                />
              )}
              {p.applied > 0 && (
                <text
                  x={x + barW / 2}
                  y={y - 5}
                  textAnchor="middle"
                  fontSize={valueSize}
                  fontWeight={600}
                  fill="var(--text-primary)"
                  className="tabular"
                  pointerEvents="none"
                >
                  {p.applied}
                </text>
              )}
              {i % labelStep === 0 && (
                <text
                  x={x + barW / 2}
                  y={height - 8}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--text-muted)"
                  pointerEvents="none"
                >
                  {p.week.label}
                </text>
              )}
            </g>
          );
        })}

        <line
          x1={AXIS_W}
          x2={width - PAD_R}
          y1={PAD_T + plotH}
          y2={PAD_T + plotH}
          stroke="var(--baseline)"
          strokeWidth={1}
        />
      </svg>
      <ChartTooltip state={tip} containerWidth={width} />
    </div>
  );
}

/**
 * 選考ステータス別のプール。棒ごとに段階名と件数を直接書くので、
 * 色は補助であって識別を色だけに負わせていない。
 */
export function StagePoolChart({
  rows,
  total,
}: {
  rows: { stage: string; label: string; count: number; color: string }[];
  total: number;
}) {
  const max = Math.max(...rows.map((r) => r.count), 1);

  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li
          key={r.stage}
          className="grid grid-cols-[1fr_5rem] items-center gap-x-2 gap-y-1 sm:grid-cols-[11rem_1fr_5rem]"
        >
          <span
            className="col-span-2 truncate text-xs sm:col-span-1"
            style={{ color: "var(--text-secondary)" }}
            title={r.label}
          >
            {r.label}
          </span>
          <span className="flex h-4 items-center" style={{ background: "var(--gridline)", borderRadius: RADIUS }}>
            <span
              className="h-4"
              style={{
                width: `${(r.count / max) * 100}%`,
                background: r.color,
                borderRadius: RADIUS,
                minWidth: r.count > 0 ? 3 : 0,
              }}
            />
          </span>
          <span className="text-right text-xs tabular" style={{ color: "var(--text-primary)" }}>
            {r.count}
            <span style={{ color: "var(--text-muted)" }}>
              {total > 0 ? ` / ${Math.round((r.count / total) * 100)}%` : ""}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 応募 → 面接設定 → 面接実施 → 採用 の通過ファネル */
export function FunnelChart({ steps }: { steps: FunnelStep[] }) {
  const top = steps[0]?.count ?? 0;
  const ramp = [
    "var(--stage-untouched)",
    "var(--stage-scheduling)",
    "var(--stage-interview-scheduled)",
    "var(--stage-interviewed)",
  ];

  return (
    <ol className="space-y-2.5">
      {steps.map((s, i) => (
        <li key={s.key}>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>
              {s.label}
            </span>
            <span className="text-xs tabular" style={{ color: "var(--text-secondary)" }}>
              {s.count}件
              {s.conversionFromPrev !== null && (
                <span style={{ color: "var(--text-muted)" }}>
                  {" "}
                  / 前段階から {(s.conversionFromPrev * 100).toFixed(0)}%
                </span>
              )}
            </span>
          </div>
          <div className="h-5 w-full overflow-hidden" style={{ background: "var(--gridline)", borderRadius: RADIUS }}>
            <div
              className="h-5"
              style={{
                width: `${top > 0 ? (s.count / top) * 100 : 0}%`,
                background: ramp[Math.min(i, ramp.length - 1)],
                borderRadius: RADIUS,
                minWidth: s.count > 0 ? 3 : 0,
              }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}
