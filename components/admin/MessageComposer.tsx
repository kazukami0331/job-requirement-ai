"use client";

import { useMemo, useState } from "react";
import CopyButton from "@/components/admin/CopyButton";

type Item = { id: string; company: string; title: string; url: string; preselect: boolean };

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

  const text = useMemo(() => {
    const list = items.filter((i) => checked.has(i.id));
    const body = list
      .map((i, n) => `${NUM[n] ?? `(${n + 1})`}${i.company}/${i.title}\n${i.url}`)
      .join("\n\n");
    return [
      `${candidateName}様`,
      "",
      `お世話になっております。転職エージェントの${staffName}です。`,
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
  }, [items, checked, candidateName, staffName, extra]);

  if (!items.length) return null;

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">✉️ 送付文を作る</div>
        <CopyButton text={text} label="文章をコピー" className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white" />
      </div>
      <div className="space-y-1">
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
              }}
            />
            <span><span className="text-slate-500">{i.company}</span> / {i.title}</span>
          </label>
        ))}
      </div>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold text-slate-600">ひとこと追加（任意）</span>
        <input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="例：特に②は年間休日と通勤時間の条件に合っています。" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
      </label>
      <textarea readOnly value={text} rows={Math.min(24, text.split("\n").length + 1)} className="w-full rounded-lg border border-slate-200 bg-slate-50 p-3 font-sans text-sm leading-relaxed text-slate-800" />
    </div>
  );
}
