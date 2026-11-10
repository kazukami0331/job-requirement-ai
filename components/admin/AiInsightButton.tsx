"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { runAiInsight, saveInsightAsMemo } from "@/app/admin/actions";
import CopyButton from "@/components/admin/CopyButton";

export default function AiInsightButton({ userId }: { userId: string }) {
  const [pending, start] = useTransition();
  const [saving, startSave] = useTransition();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const router = useRouter();

  return (
    <div className="space-y-3 border-t border-slate-100 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setError(null);
            setSaved(false);
            start(async () => {
              const res = await runAiInsight(userId);
              if (res.ok) setText(res.text);
              else setError(res.error);
            });
          }}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
        >
          {pending ? "AI が分析中…（30 秒〜1 分）" : text ? "🤖 もう一度 AI で分析" : "🤖 AI で軸を分析する"}
        </button>
        <span className="text-xs text-slate-400">Like / Pass・プロフィール・架電メモをまとめて読み、軸の仮説と探す条件を出します。</span>
      </div>
      {error && <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
      {text && (
        <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-4">
          <div className="mb-2 flex flex-wrap justify-end gap-2">
            <CopyButton text={text} label="コピー" />
            <button
              type="button"
              disabled={saving || saved}
              onClick={() =>
                startSave(async () => {
                  await saveInsightAsMemo(userId, text);
                  setSaved(true);
                  router.refresh();
                })
              }
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              {saved ? "✓ メモに保存しました" : saving ? "保存中…" : "メモとして保存"}
            </button>
          </div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{text}</p>
        </div>
      )}
    </div>
  );
}
