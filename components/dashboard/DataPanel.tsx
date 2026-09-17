"use client";

import { useRef, useState } from "react";
import { HiringPlan, Snapshot } from "@/types/recruiting";
import { Button, Card } from "./ui";

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
}: {
  label: string;
  accept: string;
  onPick: (file: File) => void;
  variant?: "primary" | "secondary";
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant={variant} onClick={() => ref.current?.click()}>
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

export function DataPanel({
  snapshots,
  plan,
  message,
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
  message: { kind: "info" | "error"; text: string } | null;
  onUploadApplications: (file: File) => void;
  onUploadPlan: (file: File) => void;
  onImportBackup: (file: File) => void;
  onExportBackup: () => void;
  onExportWorkbook: () => void;
  onDeleteSnapshot: (id: string) => void;
  onResetPlan: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Card
      title="データの取り込みと書き出し"
      subtitle="毎週このエクセルを投げ込むと、その週の断面が履歴に積み上がります"
      actions={
        <Button onClick={() => setOpen((v) => !v)}>{open ? "閉じる" : `履歴 ${snapshots.length}件`}</Button>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <FilePicker
          label="応募データを取り込む（.xls / .xlsx / .csv）"
          accept=".xls,.xlsx,.csv,.txt"
          onPick={onUploadApplications}
          variant="primary"
        />
        <FilePicker label="不足人数マスタを取り込む" accept=".csv,.xls,.xlsx" onPick={onUploadPlan} />
        <Button onClick={onExportWorkbook} disabled={snapshots.length === 0}>
          スプレッドシートに書き出す（.xlsx）
        </Button>
        <Button onClick={onExportBackup} disabled={snapshots.length === 0}>
          バックアップ（.json）
        </Button>
        <FilePicker label="バックアップを復元" accept=".json" onPick={onImportBackup} />
      </div>

      {message && (
        <p
          className="mt-3 text-xs"
          style={{ color: message.kind === "error" ? "var(--status-critical)" : "var(--text-secondary)" }}
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      )}

      <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
        データはこのブラウザの中だけに保存されます（サーバーには送られません）。
        別の端末やメンバーと共有するときは「バックアップ」で書き出したJSONを渡してください。
      </p>

      {open && (
        <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--gridline)" }}>
          <h3 className="mb-2 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
            取り込み履歴
          </h3>
          {snapshots.length === 0 ? (
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              まだ取り込まれていません。
            </p>
          ) : (
            <ul className="space-y-1">
              {[...snapshots].reverse().map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs"
                  style={{ background: "var(--background)" }}
                >
                  <span style={{ color: "var(--text-primary)" }}>
                    {fmt(s.takenAt)} 時点 ・ {s.applications.length}件
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="max-w-[16rem] truncate" style={{ color: "var(--text-muted)" }}>
                      {s.sourceFileName}
                    </span>
                    <Button variant="danger" onClick={() => onDeleteSnapshot(s.id)}>
                      削除
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <h3 className="mb-2 mt-4 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
            採用計画（不足人数マスタ）
          </h3>
          <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
            <span>
              {plan
                ? `${plan.rows.length}行 ・ 最終更新 ${fmt(plan.updatedAt)}`
                : "未登録（校舎ごとの不足人数を取り込むと、計画対比が出せます）"}
            </span>
            {plan && (
              <Button variant="danger" onClick={onResetPlan}>
                計画をクリア
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
