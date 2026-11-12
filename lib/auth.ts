import "server-only";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { enc, selectAll } from "@/lib/swipeAdmin";
import { SESSION_COOKIE, SESSION_DAYS, signSession, verifySession } from "@/lib/session";

export type Staff = {
  id: string;
  email: string;
  name: string;
  color: string;
  role: "owner" | "member";
  created_at: string;
};

export const STAFF_COLS = "id,email,name,color,role,created_at";

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return ["scrypt", salt, scryptSync(password, salt, 64).toString("hex")].join("$");
}

export function checkPassword(password: string, stored: string) {
  const [algo, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const a = scryptSync(password, salt, 64);
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startSession(staffId: string) {
  (await cookies()).set(SESSION_COOKIE, await signSession(staffId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function endSession() {
  (await cookies()).delete(SESSION_COOKIE);
}

/** ログイン中の担当者（いなければ null） */
export async function getCurrentStaff(): Promise<Staff | null> {
  const id = await verifySession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!id) return null;
  const rows = await selectAll<Staff>("crm_staff", `select=${STAFF_COLS}&id=eq.${enc(id)}`).catch(
    () => [] as Staff[],
  );
  return rows[0] ?? null;
}

/** ログイン必須の処理の入口。いなければログイン画面へ */
export async function requireStaff(): Promise<Staff> {
  const staff = await getCurrentStaff();
  if (!staff) redirect("/admin/login");
  return staff;
}

export async function listStaff(): Promise<Staff[]> {
  return selectAll<Staff>("crm_staff", `select=${STAFF_COLS}&order=created_at.asc`);
}
