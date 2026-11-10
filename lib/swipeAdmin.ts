// SwipeJob 管理ダッシュボード用の Supabase（PostgREST）読み取りヘルパー。
// サーバー側でのみ使う（service_role キーをブラウザに出さない）。
import "server-only";

export type SwipeAction = "like" | "pass" | string;

export type AdminUser = {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  createdAt: string;
  interviewCompleted: boolean | null;
  utmSource: string | null;
  utmCampaign: string | null;
  lp: string | null;
};

export type AdminProfile = {
  userId: string;
  desiredJobType: string | null;
  desiredLocations: string[] | null;
  desiredSalary: string | null;
  currentSalary: string | null;
  desiredIndustries: string[] | null;
  desiredWorkStyle: string[] | null;
  desiredJobTypeLargeCategories: string[] | null;
  desiredJobTypeSmallCategories: string[] | null;
  workHistory: unknown[] | null;
  skills: string[] | null;
  resumeFileUrl: string | null;
  resumeFileName: string | null;
  cvFileUrl: string | null;
  cvFileName: string | null;
};

export type Swipe = {
  id: string;
  userId: string;
  jobId: string;
  action: SwipeAction;
  createdAt: string;
};

export type JobSummary = {
  id: string;
  title: string | null;
  company: string | null;
  location: string | null;
  salary: string | null;
  jobType: string | null;
  industry: string | null;
  source: string | null;
  status: string | null;
};

export type JobDetail = JobSummary & {
  companyUrl: string | null;
  description: string | null;
  employmentType: string | null;
  employeeCount: number | null;
  tags: string[] | null;
  requiredExperience: string[] | null;
  preferredExperience: string[] | null;
  education: string | null;
  prefecture: string | null;
  selectionProcess: string | null;
  workLocation: string | null;
  workingHours: string | null;
  salaryDetails: string | null;
  smokingPolicy: string | null;
  employmentBenefits: string | null;
  companyDescription: string | null;
  applicationRequirements: string | null;
  industryCategory: string | null;
  workStyle: string | null;
  jobTypeLargeCategory: string | null;
  jobTypeSmallCategory: string | null;
  jobUrl: string | null;
  createdAt: string | null;
};

export type Application = {
  id: string;
  userId: string;
  jobId: string;
  status: string | null;
  motivation: string | null;
};

const USER_COLS =
  "id,email,name,phone,createdAt,interviewCompleted,utmSource,utmCampaign,lp";
const PROFILE_COLS =
  "userId,desiredJobType,desiredLocations,desiredSalary,currentSalary,desiredIndustries,desiredWorkStyle,desiredJobTypeLargeCategories,desiredJobTypeSmallCategories,workHistory,skills,resumeFileUrl,resumeFileName,cvFileUrl,cvFileName";
const JOB_SUMMARY_COLS =
  "id,title,company,location,salary,jobType,industry,source,status";
// embedding（ベクトル）は巨大なので絶対に取らない
const JOB_DETAIL_COLS =
  JOB_SUMMARY_COLS +
  ",companyUrl,description,employmentType,employeeCount,tags,requiredExperience,preferredExperience,education,prefecture,selectionProcess,workLocation,workingHours,salaryDetails,smokingPolicy,employmentBenefits,companyDescription,applicationRequirements,industryCategory,workStyle,jobTypeLargeCategory,jobTypeSmallCategory,jobUrl,createdAt";

export class ConfigError extends Error {}

/**
 * 検証のスコープ：この日時（JST）以降に登録したユーザーだけを表示する。
 * 環境変数 ADMIN_SCOPE_START（例: 2026-10-01）で変更できる。
 */
const SCOPE_START_JST = process.env.ADMIN_SCOPE_START || "2026-10-01";

/** DB（UTC 保存）と比較するための UTC 文字列 "YYYY-MM-DD HH:MM:SS" */
export function scopeStartUtc() {
  const d = new Date(`${SCOPE_START_JST.slice(0, 10)}T00:00:00+09:00`);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export function scopeStartLabel() {
  return SCOPE_START_JST.slice(0, 10).replace(/-/g, "/");
}

export function inScope(u: Pick<AdminUser, "createdAt"> | null | undefined) {
  if (!u?.createdAt) return false;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(u.createdAt)
    ? u.createdAt
    : u.createdAt.replace(" ", "T") + "Z";
  return new Date(iso).getTime() >= new Date(scopeStartUtc().replace(" ", "T") + "Z").getTime();
}

function config() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new ConfigError(
      "SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を環境変数に設定してください。",
    );
  }
  return { url, key };
}

const PAGE = 1000;

/** PostgREST への書き込み（POST / PATCH / DELETE）。返り値は書き込んだ行 */
export async function writeRows<T>(
  method: "POST" | "PATCH" | "DELETE",
  table: string,
  query: string,
  body?: unknown,
  opts: { upsert?: boolean } = {},
): Promise<T[]> {
  const { url, key } = config();
  const res = await fetch(`${url}/rest/v1/${table}${query ? `?${query}` : ""}`, {
    method,
    headers: {
      apikey: key,
      ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}),
      "Content-Type": "application/json",
      Prefer: ["return=representation", opts.upsert ? "resolution=merge-duplicates" : ""]
        .filter(Boolean)
        .join(","),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Supabase ${table} への書き込みに失敗しました (${res.status}): ${await res.text()}`);
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as T[]) : [];
}

/** PostgREST から全件取得（1000件ずつ Range でページング） */
export async function selectAll<T>(table: string, query: string): Promise<T[]> {
  const { url, key } = config();
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${url}/rest/v1/${table}?${query}`, {
      headers: {
        apikey: key,
        // 旧形式の service_role（JWT）のときだけ Authorization を付ける。
        // 新形式の sb_secret_... は apikey ヘッダーだけで service_role として扱われる。
        ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}),
        Range: `${from}-${from + PAGE - 1}`,
        "Range-Unit": "items",
      },
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(
        `Supabase ${table} の取得に失敗しました (${res.status}): ${await res.text()}`,
      );
    }
    const rows = (await res.json()) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/** 値を PostgREST の in.(...) 用にクォート */
function inList(values: string[]) {
  return `in.(${values.map((v) => `"${v.replace(/(["\\])/g, "\\$1")}"`).join(",")})`;
}

/** in.(...) が URL 長制限に引っかからないよう分割して取得 */
export async function selectIn<T>(
  table: string,
  cols: string,
  column: string,
  values: string[],
): Promise<T[]> {
  const unique = [...new Set(values)];
  const out: T[] = [];
  for (let i = 0; i < unique.length; i += 150) {
    const chunk = unique.slice(i, i + 150);
    out.push(
      ...(await selectAll<T>(
        table,
        `select=${cols}&${column}=${encodeURIComponent(inList(chunk))}`,
      )),
    );
  }
  return out;
}

export const enc = encodeURIComponent;

export type CandidateRow = AdminUser & {
  likes: number;
  passes: number;
  applications: number;
  lastSwipeAt: string | null;
};

export async function listCandidates(): Promise<CandidateRow[]> {
  const [users, swipes, apps] = await Promise.all([
    selectAll<AdminUser>(
      "users",
      `select=${USER_COLS}&createdAt=gte.${enc(scopeStartUtc())}&order=createdAt.desc`,
    ),
    selectAll<Pick<Swipe, "userId" | "action" | "createdAt">>(
      "job_swipes",
      `select=userId,action,createdAt&createdAt=gte.${enc(scopeStartUtc())}`,
    ),
    selectAll<Pick<Application, "userId">>("job_applications", "select=userId").catch(
      () => [] as Pick<Application, "userId">[],
    ),
  ]);

  const stats = new Map<string, { likes: number; passes: number; last: string | null }>();
  for (const s of swipes) {
    const st = stats.get(s.userId) ?? { likes: 0, passes: 0, last: null };
    if (s.action === "like") st.likes++;
    else st.passes++;
    if (!st.last || s.createdAt > st.last) st.last = s.createdAt;
    stats.set(s.userId, st);
  }
  const appCount = new Map<string, number>();
  for (const a of apps) appCount.set(a.userId, (appCount.get(a.userId) ?? 0) + 1);

  return users.map((u) => {
    const st = stats.get(u.id);
    return {
      ...u,
      likes: st?.likes ?? 0,
      passes: st?.passes ?? 0,
      applications: appCount.get(u.id) ?? 0,
      lastSwipeAt: st?.last ?? null,
    };
  });
}

export type UserSwipeRow = Swipe & {
  job: JobSummary | null;
  application: Application | null;
};

export async function getCandidate(userId: string) {
  const [users, profiles, swipes, apps] = await Promise.all([
    selectAll<AdminUser>("users", `select=${USER_COLS}&id=eq.${enc(userId)}`),
    selectAll<AdminProfile>(
      "profiles",
      `select=${PROFILE_COLS}&userId=eq.${enc(userId)}`,
    ).catch(() => [] as AdminProfile[]),
    selectAll<Swipe>(
      "job_swipes",
      `select=id,userId,jobId,action,createdAt&userId=eq.${enc(userId)}&order=createdAt.desc`,
    ),
    selectAll<Application>(
      "job_applications",
      `select=id,userId,jobId,status,motivation&userId=eq.${enc(userId)}`,
    ).catch(() => [] as Application[]),
  ]);
  const user = users[0];
  if (!user) return null;

  const jobs = await selectIn<JobSummary>(
    "jobs",
    JOB_SUMMARY_COLS,
    "id",
    [...swipes.map((s) => s.jobId), ...apps.map((a) => a.jobId)],
  );
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const appByJob = new Map(apps.map((a) => [a.jobId, a]));

  const rows: UserSwipeRow[] = swipes.map((s) => ({
    ...s,
    job: jobById.get(s.jobId) ?? null,
    application: appByJob.get(s.jobId) ?? null,
  }));
  // スワイプ記録がない応募も取りこぼさない
  const swipedJobIds = new Set(swipes.map((s) => s.jobId));
  const appsWithoutSwipe = apps
    .filter((a) => !swipedJobIds.has(a.jobId))
    .map((a) => ({ ...a, job: jobById.get(a.jobId) ?? null }));

  return { user, profile: profiles[0] ?? null, swipes: rows, appsWithoutSwipe };
}

export async function getJob(jobId: string) {
  const [jobs, swipes, apps] = await Promise.all([
    selectAll<JobDetail>("jobs", `select=${JOB_DETAIL_COLS}&id=eq.${enc(jobId)}`),
    selectAll<Swipe>(
      "job_swipes",
      `select=id,userId,jobId,action,createdAt&jobId=eq.${enc(jobId)}&order=createdAt.desc`,
    ),
    selectAll<Application>(
      "job_applications",
      `select=id,userId,jobId,status,motivation&jobId=eq.${enc(jobId)}`,
    ).catch(() => [] as Application[]),
  ]);
  const users = await selectIn<AdminUser>(
    "users",
    USER_COLS,
    "id",
    [...swipes.map((s) => s.userId), ...apps.map((a) => a.userId)],
  );
  const userById = new Map(users.map((u) => [u.id, u]));
  const appByUser = new Map(apps.map((a) => [a.userId, a]));
  return {
    job: jobs[0] ?? null,
    // スコープ外（検証開始前に登録）のユーザーのスワイプは出さない
    swipes: swipes.filter((s) => inScope(userById.get(s.userId))).map((s) => ({
      ...s,
      user: userById.get(s.userId) ?? null,
      application: appByUser.get(s.userId) ?? null,
    })),
  };
}

/** DB は timestamp without time zone（UTC 保存）なので JST で表示する */
export function formatJst(ts: string | null | undefined, withTime = true) {
  if (!ts) return "—";
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.replace(" ", "T") + "Z";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return ts;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(d);
}
