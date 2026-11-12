"use client";

import { useState } from "react";

export default function CopyButton({ text, label = "コピー", className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className={className ?? "rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"}
    >
      {done ? "✓ コピーしました" : label}
    </button>
  );
}
