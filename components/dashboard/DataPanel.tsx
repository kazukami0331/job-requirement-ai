"use client";

import { useEffect, useRef, useState } from "react";
import { HiringPlan, Snapshot } from "@/types/recruiting";
import { Button } from "./ui";

function fmt(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function FilePicker({
  label,
  accept,
  onPick,
  variant = "secondary",
  block = false,
}: {
  label: string;
  accept: string;
  onPick: (file: File) => void;
  variant?: "primary" | "secondary";
  block?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant={variant} onClick={() => ref.current?.click()} block={block}>
        {label}
      </Button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
          // 同じファイルを続けて選べるようにリセットする
          e.target.value = "";
        }}
      />
    </>
  );
}

/**
 * 画面右上に置くデータ操作。
 * 普段は「取り込み」だけを出し、書き出しや履歴はメニューに畳んでおく。
 */
export function DataMenu({
  snapshots,
  plan,
  onUploadApplications,
  onUploadPlan,
  onImportBackup,
  onExportBackup,
  onExportWorkbook,
  onDeleteSnapshot,
  onResetPlan,
}: {
  snapshots: Snapshot[];
  plan: HiringPlan | null;
  onUploadApplications: (file: File) => void;
  onUploadPlan: (file: File) => void;
  onImportBackup: (file: File) => void;
  onExportBackup: () => void;
  onExportWorkbook: () => void;
  onDeleteSnapshot: (id: string) => void;
  onResetPlan: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // メニューの外を触ったら閉じる
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div className="relative flex items-center gap-1.5" ref={box}>
      <FilePicker
        label="データ取り込み"
        accept=".xls,.xlsx,.csv,.txt"
        onPick={onUploadApplications}
        variant="primary"
      />
      <Button onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu">
        その他 ▾
      </Button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1.5 w-72 rounded-xl border p-3 shadow-lg"
          style={{ background: "var(--surface-1)", borderColor: "var(--hairline)" }}
        >
          <div className="space-y-1.5">
            <FilePicker label="不足人数マスタを取り込む" accept=".csv,.xls,.xlsx" onPick={onUploadPlan} block />
            <Button onClick={onExportWorkbook} disabled={snapshots.length === 0} block>
              スプレッドシートに書き出す（.xlsx）
            </Button>
            <Button onClick={onExportBackup} disabled={snapshots.length === 0} block>
              バックアップ（.json）
            </Button>
            <FilePicker label="バックアップを復元" accept=".json" onPick={onImportBackup} block />
          </div>

          <div className="mt-3 border-t pt-2.5" style={{ borderColor: "var(--gridline)" }}>
            <h3 className="mb-1.5 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
              取り込み履歴 {snapshots.length}件
            </h3>
            {snapshots.length === 0 ? (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                まだ取り込まれていません。
              </p>
            ) : (
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {[...snapshots].reverse().map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs"
                    style={{ background: "var(--background)" }}
                  >
                    <span className="min-w-0" style={{ color: "var(--text-primary)" }}>
                      <span className="block truncate">{fmt(s.takenAt)} 時点</span>
                      <span style={{ color: "var(--text-muted)" }}>{s.applications.length}件</span>
                    </span>
                    <Button variant="danger" onClick={() => onDeleteSnapshot(s.id)}>
                      削除
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {plan && (
              <div className="mt-2 flex items-center justify-between gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
                <span>採用計画 {plan.rows.length}行</span>
                <Button variant="danger" onClick={onResetPlan}>
                  計画をクリア
                </Button>
              </div>
            )}
          </div>

          <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
            データはこのブラウザの中だけに保存されます。別の端末と共有するときはバックアップのJSONを渡してください。
          </p>
        </div>
      )}
    </div>
  );
}
