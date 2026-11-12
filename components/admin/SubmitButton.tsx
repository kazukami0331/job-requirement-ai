"use client";

import { useFormStatus } from "react-dom";

/** 送信中は押せなくして「保存中…」と表示するボタン（二重送信を防ぐ） */
export default function SubmitButton({
  children,
  pendingText = "保存中…",
  className,
  name,
  value,
}: {
  children: React.ReactNode;
  pendingText?: string;
  className?: string;
  name?: string;
  value?: string;
}) {
  const { pending, data } = useFormStatus();
  // 同じフォームの別ボタンが押されたときも押せなくする。表示を変えるのは押したボタンだけ
  const mine = pending && (!name || data?.get(name) === value);
  return (
    <button
      name={name}
      value={value}
      disabled={pending}
      aria-busy={mine}
      className={`${className ?? ""} disabled:cursor-not-allowed disabled:opacity-60`}
    >
      {mine ? pendingText : children}
    </button>
  );
}
