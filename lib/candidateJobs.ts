import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { crmSelect } from "@/lib/crm";
import {
  enc,
  JOB_DETAIL_COLS,
  selectIn,
  writeRows,
  type JobDetail,
} from "@/lib/swipeAdmin";

export const PDF_BUCKET = "crm-job-pdfs";

export type CandidateJob = {
  id: string;
  user_id: string;
  source: "proposal" | "swipe" | "swipe_apply";
  job_id: string | null;
  company: string | null;
  title: string | null;
  pdf_path: string | null;
  share_token: string;
  stage: string;
  note: string | null;
  staff_id: string | null;
  created_at: string;
  updated_at: string;
};

const COLS = "id,user_id,source,job_id,company,title,pdf_path,share_token,stage,note,staff_id,created_at,updated_at";

export function newShareToken() {
  return randomBytes(16).toString("base64url");
}

export async function listCandidateJobs(userId: string) {
  return crmSelect<CandidateJob>("crm_candidate_jobs", `select=${COLS}&user_id=eq.${enc(userId)}&order=created_at.asc`);
}

export async function getCandidateJobByToken(token: string) {
  const rows = await crmSelect<CandidateJob>("crm_candidate_jobs", `select=${COLS}&share_token=eq.${enc(token)}`);
  return rows[0] ?? null;
}

export async function getCandidateJob(id: string) {
  const rows = await crmSelect<CandidateJob>("crm_candidate_jobs", `select=${COLS}&id=eq.${enc(id)}`);
  return rows[0] ?? null;
}

/** jobs テーブルから会社名・タイトルなどを引く */
export async function lookupJobs(jobIds: string[]) {
  const ids = jobIds.filter(Boolean);
  if (!ids.length) return new Map<string, JobDetail>();
  const rows = await selectIn<JobDetail>("jobs", JOB_DETAIL_COLS, "id", ids);
  return new Map(rows.map((j) => [j.id, j]));
}

/**
 * 求人を候補者のリストに入れる。同じ求人 ID がすでにあれば、空いている項目だけ埋める。
 */
export async function addCandidateJob(input: {
  userId: string;
  source: CandidateJob["source"];
  jobId?: string | null;
  company?: string | null;
  title?: string | null;
  pdfPath?: string | null;
  note?: string | null;
  stage?: string;
  staffId?: string | null;
}) {
  const jobId = input.jobId?.trim() || null;
  let company = input.company?.trim() || null;
  let title = input.title?.trim() || null;
  if (jobId && (!company || !title)) {
    const job = (await lookupJobs([jobId])).get(jobId);
    company = company || job?.company || null;
    title = title || job?.title || null;
  }

  if (jobId) {
    const existing = (
      await crmSelect<CandidateJob>(
        "crm_candidate_jobs",
        `select=${COLS}&user_id=eq.${enc(input.userId)}&job_id=eq.${enc(jobId)}`,
      )
    )[0];
    if (existing) {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (input.pdfPath) patch.pdf_path = input.pdfPath;
      if (input.note) patch.note = input.note;
      if (!existing.company && company) patch.company = company;
      if (!existing.title && title) patch.title = title;
      // スワイプ由来の求人を改めて提案したら「提案」として扱う
      if (input.source === "proposal" && existing.source === "swipe") patch.source = "proposal";
      await writeRows("PATCH", "crm_candidate_jobs", `id=eq.${enc(existing.id)}`, patch);
      return existing.id;
    }
  }

  const id = randomUUID();
  await writeRows(
    "POST",
    "crm_candidate_jobs",
    "on_conflict=user_id,job_id",
    {
      id,
      user_id: input.userId,
      source: input.source,
      job_id: jobId,
      company,
      title,
      pdf_path: input.pdfPath || null,
      share_token: newShareToken(),
      stage: input.stage ?? "proposed",
      note: input.note || null,
      staff_id: input.staffId ?? null,
    },
    { ignoreDuplicates: true },
  );
  return id;
}

/** SwipeJob で応募した求人を、選考管理のリストに自動で入れる（すでにあれば何もしない） */
export async function syncSwipeApplications(userId: string, appliedJobIds: string[]) {
  if (!appliedJobIds.length) return;
  const existing = await crmSelect<{ job_id: string | null }>(
    "crm_candidate_jobs",
    `select=job_id&user_id=eq.${enc(userId)}`,
  );
  const have = new Set(existing.map((r) => r.job_id));
  const missing = [...new Set(appliedJobIds)].filter((id) => !have.has(id));
  if (!missing.length) return;
  const jobs = await lookupJobs(missing);
  await writeRows(
    "POST",
    "crm_candidate_jobs",
    "on_conflict=user_id,job_id",
    missing.map((jobId) => ({
      id: randomUUID(),
      user_id: userId,
      source: "swipe_apply",
      job_id: jobId,
      company: jobs.get(jobId)?.company ?? null,
      title: jobs.get(jobId)?.title ?? null,
      share_token: newShareToken(),
      stage: "applied",
    })),
    { ignoreDuplicates: true },
  );
}

export type ViewStats = {
  views: number;
  firstAt: string;
  lastAt: string;
  maxScroll: number;
  totalSec: number;
  pdfOpened: boolean;
};

/** 共有リンクの閲覧のまとめ（求人ごと）。表がまだなければ空 */
export async function viewStats(candidateJobIds: string[]): Promise<Map<string, ViewStats>> {
  const out = new Map<string, ViewStats>();
  if (!candidateJobIds.length) return out;
  const rows = await selectIn<{
    candidate_job_id: string;
    viewed_at: string;
    last_seen_at: string;
    duration_sec: number;
    max_scroll: number;
    pdf_opened: boolean;
  }>("crm_job_views", "candidate_job_id,viewed_at,last_seen_at,duration_sec,max_scroll,pdf_opened", "candidate_job_id", candidateJobIds).catch(() => []);
  for (const r of rows) {
    const s = out.get(r.candidate_job_id) ?? {
      views: 0,
      firstAt: r.viewed_at,
      lastAt: r.viewed_at,
      maxScroll: 0,
      totalSec: 0,
      pdfOpened: false,
    };
    s.views++;
    if (r.viewed_at < s.firstAt) s.firstAt = r.viewed_at;
    if (r.last_seen_at > s.lastAt) s.lastAt = r.last_seen_at;
    s.maxScroll = Math.max(s.maxScroll, r.max_scroll);
    s.totalSec += r.duration_sec;
    s.pdfOpened ||= r.pdf_opened;
    out.set(r.candidate_job_id, s);
  }
  return out;
}
