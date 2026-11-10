"use client";

import { useRef, useState, useTransition } from "react";
import { addJobForCandidate, getPdfUploadUrl } from "@/app/admin/actions";
import { btnCls, inputCls } from "@/components/admin/bits";

/** 提案求人の追加。PDF はブラウザから Storage に直接アップロードしてから登録する */
export default function AddJobForm({ userId }: { userId: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const file = fileRef.current?.files?.[0];
        setMsg(null);
        start(async () => {
          if (file) {
            if (file.size > 20 * 1024 * 1024) return setMsg("PDF は 20MB までにしてください");
            setMsg("PDF をアップロード中…");
            const up = await getPdfUploadUrl(userId, file.name);
            if (!up.ok) return setMsg(up.error);
            const res = await fetch(up.uploadUrl, {
              method: "PUT",
              headers: { "Content-Type": "application/pdf", "x-upsert": "false" },
              body: file,
            });
            if (!res.ok) return setMsg(`PDF のアップロードに失敗しました (${res.status})`);
            form.set("pdfPath", up.path);
          }
          form.delete("pdf");
          setMsg("登録中…");
          await addJobForCandidate(form);
        });
      }}
      className="space-y-3"
    >
      <input type="hidden" name="userId" value={userId} />
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-600">求人 ID（あれば）</span>
          <input name="jobId" placeholder="hl-ap-181482" className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-600">会社名</span>
          <input name="company" placeholder="ID があれば自動で入ります" className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-600">求人タイトル</span>
          <input name="title" placeholder="ID があれば自動で入ります" className={inputCls} />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-600">求人票 PDF</span>
          <input ref={fileRef} type="file" name="pdf" accept="application/pdf,.pdf" className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-white" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-600">メモ（社内用）</span>
          <input name="note" placeholder="提案理由など" className={inputCls} />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button disabled={pending} className={`${btnCls} disabled:opacity-60`}>{pending ? "登録中…" : "追加する"}</button>
        {msg && <span className="text-sm text-slate-600">{msg}</span>}
      </div>
      <p className="text-xs text-slate-400">
        求人 ID だけ入れれば、会社名・タイトル・求人内容は SwipeJob の求人データから自動で入ります。PDF を付けると、共有リンクで PDF が表示されます。
      </p>
    </form>
  );
}
