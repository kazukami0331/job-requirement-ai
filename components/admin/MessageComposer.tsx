"use client";

import { useMemo, useState } from "react";
import CopyButton from "@/components/admin/CopyButton";

type Item = { id: string; company: string; title: string; url: string; preselect: boolean };

/** 登録名から苗字を推測（「紙谷 和彦」→ 紙谷、「紙谷和彦」→ 紙谷） */
export function guessSurname(name: string) {
  const n = name.trim();
  const parts = n.split(/[\s　]+/);
  if (parts.length > 1) return parts[0];
  if (/^[\p{Script=Han}々]{3,}$/u.test(n)) return n.slice(0, 2);
  return n;
}

const NUM = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮"];

export default function MessageComposer({
  candidateName,
  staffName,
  items,
}: {
  candidateName: string;
  staffName: string;
  items: Item[];
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set(items.filter((i) => i.preselect).map((i) => i.id)));
  const [extra, setExtra] = useState("");
  const [sender, setSender] = useState(guessSurname(staffName));

  const generated = useMemo(() => {
    const list = items.filter((i) => checked.has(i.id));
    const body = list
      .map((i, n) => `${NUM[n] ?? `(${n + 1})`}${i.company}/${i.title}\n${i.url}`)
      .join("\n\n");
    return [
      `${candidateName}様`,
      "",
      `お世話になっております。転職エージェントの${sender}です。`,
      "先ほどはお電話にてありがとうございました。",
      `先日のお話を踏まえて、${candidateName}様にマッチしそうな求人をピックアップしましたので、ご確認ください。`,
      ...(extra.trim() ? ["", extra.trim()] : []),
      "",
      "==================",
      body || "（求人を選んでください）",
      "==================",
      "",
      "ご希望と異なる部分などあれば遠慮なくお申し付けください。",
      "",
      "何卒よろしくお願いいたします。",
    ].join("\n");
  }, [items, checked, candidateName, sender, extra]);

  // 本文は自由に書き換えられる。求人の選択・差出人・ひとことを変えたら作り直す
  const [override, setOverride] = useState<string | null>(null);
  const text = override ?? generated;
  const edited = override !== null;
  const reset = () => setOverride(null);

  if (!items.length) return null;

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-600">
            送る求人を選ぶ（複数選べます・{checked.size} 件選択中）
          </span>
          <span className="flex gap-3 text-xs">
            <button type="button" className="text-indigo-700 hover:underline" onClick={() => { setChecked(new Set(items.map((i) => i.id))); reset(); }}>すべて選択</button>
            <button type="button" className="text-slate-500 hover:underline" onClick={() => { setChecked(new Set()); reset(); }}>すべて外す</button>
          </span>
        </div>
      <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
        {items.map((i) => (
          <label key={i.id} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={checked.has(i.id)}
              onChange={(e) => {
                const next = new Set(checked);
                if (e.target.checked) next.add(i.id);
                else next.delete(i.id);
                setChecked(next);
                reset();
              }}
            />
            <span><span className="text-slate-500">{i.company}</span> / {i.title}</span>
          </label>
        ))}
      </div>
      </div>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold text-slate-600">差出人（苗字）</span>
        <input value={sender} onChange={(e) => { setSender(e.target.value); reset(); }} className="w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm" />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold text-slate-600">ひとこと追加（任意）</span>
        <input value={extra} onChange={(e) => { setExtra(e.target.value); reset(); }} placeholder="例：特に②は年間休日と通勤時間の条件に合っています。" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
      </label>
      <div>
        <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
          <span className="font-semibold text-slate-600">本文（そのまま書き換えられます）</span>
          {edited && (
            <button type="button" onClick={reset} className="text-indigo-700 hover:underline">
              書き換えを戻す
            </button>
          )}
        </div>
        <textarea
          value={text}
          onChange={(e) => setOverride(e.target.value)}
          rows={Math.min(18, text.split("\n").length + 1)}
          className="w-full rounded-lg border border-slate-300 bg-white p-3 font-sans text-sm leading-relaxed text-slate-800 outline-none focus:border-slate-500"
        />
        <p className="mt-1 text-xs text-slate-400">求人のチェック・差出人・ひとことを変えると、本文は作り直されます。</p>
      </div>
      <div className="flex justify-end">
        <CopyButton text={text} label="✉️ 文章をコピー" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white" />
      </div>
    </div>
  );
}
