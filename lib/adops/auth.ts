/**
 * 管理画面のログイン。パスワード（ADOPS_ADMIN_PASSWORD、無ければレポートと同じ ADOPS_REPORT_PASSWORD）を確かめ、
 * 署名つき Cookie（7日有効）を発行する。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const COOKIE = "adops_admin";
const DAYS = 7;

export function adminPassword(): string {
  return process.env.ADOPS_ADMIN_PASSWORD || process.env.ADOPS_REPORT_PASSWORD || "";
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", `adops-admin:${secret}`).update(value).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function checkPassword(input: string): boolean {
  const pw = adminPassword();
  return Boolean(pw) && safeEqual(input, pw);
}

export function makeToken(now = Date.now()): string {
  const exp = String(now + DAYS * 86_400_000);
  return `${exp}.${sign(exp, adminPassword())}`;
}

export function verifyToken(token: string | undefined, now = Date.now()): boolean {
  const pw = adminPassword();
  if (!pw || !token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !(Number(exp) > now)) return false;
  return safeEqual(sig, sign(exp, pw));
}

export async function login(): Promise<void> {
  (await cookies()).set(COOKIE, makeToken(), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/admin", maxAge: DAYS * 86400 });
}

export async function logout(): Promise<void> {
  (await cookies()).delete({ name: COOKIE, path: "/admin" });
}

/** ログインしていなければログイン画面へ。ページとサーバーアクションの最初に呼ぶ。 */
export async function requireAdmin(): Promise<void> {
  if (!verifyToken((await cookies()).get(COOKIE)?.value)) redirect("/admin/login");
}
