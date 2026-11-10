"use client";

import { useEffect, useState } from "react";

/** ボタンを押すと開くモーダル。背景クリック・Esc・✕ で閉じる */
export default function Modal({
  buttonLabel,
  buttonClassName,
  title,
  disabled,
  wide,
  children,
}: {
  buttonLabel: React.ReactNode;
  buttonClassName?: string;
  title: string;
  disabled?: boolean;
  wide?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      <button type="button" disabled={disabled} onClick={() => setOpen(true)} className={`${buttonClassName ?? ""} disabled:cursor-not-allowed disabled:opacity-50`}>
        {buttonLabel}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 sm:p-8" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label={title} className={`w-full ${wide ? "max-w-3xl" : "max-w-xl"} rounded-2xl bg-white shadow-xl`}>
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <h3 className="font-semibold text-slate-900">{title}</h3>
              <button type="button" onClick={() => setOpen(false)} aria-label="閉じる" className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100">✕</button>
            </div>
            <div className="p-5">{children}</div>
          </div>
        </div>
      )}
    </>
  );
}
