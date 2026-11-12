"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateJobStage } from "@/app/admin/actions";
import { JOB_STAGES, jobStageInfo } from "@/lib/crmConstants";

export default function JobStageSelect({ id, stage }: { id: string; stage: string }) {
  const [value, setValue] = useState(stage);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <select
      aria-label="選考ステージ"
      value={value}
      disabled={pending}
      onChange={(e) => {
        const next = e.target.value;
        const prev = value;
        setValue(next);
        start(async () => {
          const res = await updateJobStage(id, next);
          if (!res.ok) {
            setValue(prev);
            alert(res.error ?? "保存に失敗しました");
          }
          router.refresh();
        });
      }}
      className={`cursor-pointer rounded-full border-0 py-1 pl-2.5 pr-7 text-xs font-semibold disabled:opacity-60 ${jobStageInfo(value).tone}`}
    >
      {JOB_STAGES.map((s) => (
        <option key={s.key} value={s.key}>{s.label}</option>
      ))}
    </select>
  );
}
