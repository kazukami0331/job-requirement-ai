"use server";

import { randomBytes, randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import {
  checkPassword,
  endSession,
  hashPassword,
  requireStaff,
  startSession,
  STAFF_COLS,
  type Staff,
} from "@/lib/auth";
import { CALL_RESULTS, STAFF_COLORS, STATUSES } from "@/lib/crmConstants";
import { crmSelect, type CrmCandidate } from "@/lib/crm";
import { enc, writeRows } from "@/lib/swipeAdmin";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const back = (path: string, q: Record<string, string>) =>
  `${path}?${new URLSearchParams(q).toString()}`;

/** 遷移先は /admin 配下だけに限る（外部サイトへ飛ばされないように） */
function safeNext(next: string) {
  return next.startsWith("/admin") && !next.startsWith("//") ? next : "/admin";
}

/** datetime-local（日本時間）を UTC の ISO 文字列にする */
function jstLocalToIso(v: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return new Date().toISOString();
  return new Date(`${v}:00+09:00`).toISOString();
}

function validColor(c: string) {
  return STAFF_COLORS.includes(c) ? c : STAFF_COLORS[0];
}

// ───────── ログイン ─────────

export async function login(form: FormData) {
  const email = str(form, "email").toLowerCase();
  const password = str(form, "password");
  const next = safeNext(str(form, "next"));
  const rows = await crmSelect<Staff & { password_hash: string }>(
    "crm_staff",
    `select=${STAFF_COLS},password_hash&email=eq.${enc(email)}`,
  ).catch(() => []);
  const staff = rows[0];
  if (!staff || !checkPassword(password, staff.password_hash)) {
    redirect(back("/admin/login", { error: "1", next }));
  }
  await startSession(staff.id);
  redirect(next);
}

export async function logout() {
  await endSession();
  redirect("/admin/login");
}

/** 最初の 1 人目（オーナー）を作る。合言葉は Vercel の ADMIN_PASSWORD */
export async function setupOwner(form: FormData) {
  const existing = await crmSelect<{ id: string }>("crm_staff", "select=id&limit=1");
  if (existing.length > 0) redirect("/admin/login");

  const bootstrap = process.env.ADMIN_PASSWORD;
  if (!bootstrap || str(form, "bootstrap") !== bootstrap) {
    redirect(back("/admin/setup", { error: "合言葉（ADMIN_PASSWORD）が違います" }));
  }
  const err = validateAccount(form);
  if (err) redirect(back("/admin/setup", { error: err }));

  const [staff] = await writeRows<Staff>("POST", "crm_staff", `select=${STAFF_COLS}`, {
    id: randomUUID(),
    email: str(form, "email").toLowerCase(),
    name: str(form, "name"),
    color: validColor(str(form, "color")),
    role: "owner",
    password_hash: hashPassword(str(form, "password")),
  });
  await startSession(staff.id);
  redirect("/admin");
}

function validateAccount(form: FormData) {
  if (!str(form, "name")) return "名前を入力してください";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(str(form, "email"))) return "メールアドレスの形式が違います";
  if (str(form, "password").length < 8) return "パスワードは 8 文字以上にしてください";
  return null;
}

// ───────── メンバー・招待 ─────────

export async function createInvite() {
  const me = await requireStaff();
  const token = randomBytes(24).toString("base64url");
  await writeRows("POST", "crm_invites", "", {
    token,
    role: "member",
    created_by: me.id,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  redirect(back("/admin/staff", { invite: token }));
}

export async function acceptInvite(form: FormData) {
  const token = str(form, "token");
  const path = `/admin/invite/${encodeURIComponent(token)}`;
  const [invite] = await crmSelect<{ token: string; role: string; expires_at: string; used_at: string | null }>(
    "crm_invites",
    `select=token,role,expires_at,used_at&token=eq.${enc(token)}`,
  );
  if (!invite || invite.used_at || new Date(invite.expires_at).getTime() < Date.now()) {
    redirect(back(path, { error: "この招待リンクは使えません（使用済みか期限切れ）" }));
  }
  const err = validateAccount(form);
  if (err) redirect(back(path, { error: err }));

  const email = str(form, "email").toLowerCase();
  const dup = await crmSelect<{ id: string }>("crm_staff", `select=id&email=eq.${enc(email)}`);
  if (dup.length) redirect(back(path, { error: "このメールアドレスはすでに登録されています" }));

  const [staff] = await writeRows<Staff>("POST", "crm_staff", `select=${STAFF_COLS}`, {
    id: randomUUID(),
    email,
    name: str(form, "name"),
    color: validColor(str(form, "color")),
    role: invite.role === "owner" ? "owner" : "member",
    password_hash: hashPassword(str(form, "password")),
  });
  await writeRows("PATCH", "crm_invites", `token=eq.${enc(token)}`, {
    used_at: new Date().toISOString(),
    used_by: staff.id,
  });
  await startSession(staff.id);
  redirect("/admin");
}

export async function updateProfile(form: FormData) {
  const me = await requireStaff();
  const name = str(form, "name");
  const patch: Record<string, string> = { color: validColor(str(form, "color")) };
  if (name) patch.name = name;
  const password = str(form, "password");
  if (password) {
    if (password.length < 8) redirect(back("/admin/staff", { error: "パスワードは 8 文字以上にしてください" }));
    patch.password_hash = hashPassword(password);
  }
  await writeRows("PATCH", "crm_staff", `id=eq.${enc(me.id)}`, patch);
  redirect(back("/admin/staff", { saved: "1" }));
}

// ───────── 候補者のステータス・担当・架電 ─────────

async function currentCandidate(userId: string) {
  const rows = await crmSelect<CrmCandidate>(
    "crm_candidates",
    `select=user_id,status,assignee_id,updated_at&user_id=eq.${enc(userId)}`,
  );
  return rows[0] ?? null;
}

async function upsertCandidate(userId: string, patch: Partial<CrmCandidate>, prev: CrmCandidate | null) {
  await writeRows(
    "POST",
    "crm_candidates",
    "on_conflict=user_id",
    {
      user_id: userId,
      status: patch.status ?? prev?.status ?? "new",
      assignee_id: patch.assignee_id !== undefined ? patch.assignee_id : (prev?.assignee_id ?? null),
      updated_at: new Date().toISOString(),
    },
    { upsert: true },
  );
}

export async function updateCandidate(form: FormData) {
  const me = await requireStaff();
  const userId = str(form, "userId");
  const status = str(form, "status");
  const assignee = str(form, "assignee");
  if (!userId || !STATUSES.some((s) => s.key === status)) redirect("/admin");

  const prev = await currentCandidate(userId);
  await upsertCandidate(userId, { status, assignee_id: assignee || null }, prev);
  if ((prev?.status ?? "new") !== status) {
    await writeRows("POST", "crm_status_history", "", {
      id: randomUUID(),
      user_id: userId,
      from_status: prev?.status ?? "new",
      to_status: status,
      staff_id: me.id,
    });
  }
  redirect(back(`/admin/users/${encodeURIComponent(userId)}`, { saved: "status" }));
}

export async function addActivity(form: FormData) {
  const me = await requireStaff();
  const userId = str(form, "userId");
  const type = str(form, "type") === "memo" ? "memo" : "call";
  const result = type === "call" ? str(form, "result") : "";
  const note = str(form, "note");
  const path = `/admin/users/${encodeURIComponent(userId)}`;
  if (!userId) redirect("/admin");
  if (type === "call" && !CALL_RESULTS.some((r) => r.key === result)) {
    redirect(back(path, { error: "架電の結果を選んでください" }));
  }
  if (type === "memo" && !note) redirect(back(path, { error: "メモを入力してください" }));

  await writeRows("POST", "crm_activities", "", {
    id: randomUUID(),
    user_id: userId,
    staff_id: me.id,
    type,
    result: result || null,
    note: note || null,
    occurred_at: jstLocalToIso(str(form, "occurredAt")),
  });

  // 担当者が決まっていなければ、最初に記録した人を担当にする
  const prev = await currentCandidate(userId);
  if (!prev?.assignee_id) await upsertCandidate(userId, { assignee_id: me.id }, prev);

  redirect(back(path, { saved: type }));
}

export async function deleteActivity(form: FormData) {
  const me = await requireStaff();
  const id = str(form, "id");
  const userId = str(form, "userId");
  // 自分の記録だけ消せる（オーナーは全員分）
  const filter = me.role === "owner" ? `id=eq.${enc(id)}` : `id=eq.${enc(id)}&staff_id=eq.${enc(me.id)}`;
  await writeRows("DELETE", "crm_activities", filter);
  redirect(`/admin/users/${encodeURIComponent(userId)}`);
}
