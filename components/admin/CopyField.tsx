"use client";

import { useState } from "react";

export default function CopyField({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex gap-2">
      <input readOnly value={value} onFocus={(e) => e.target.select()} className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs" />
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }}
        className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white"
      >
        {done ? "コピーしました" : "コピー"}
      </button>
    </div>
  );
}
