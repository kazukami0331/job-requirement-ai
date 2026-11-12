import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/session";

// /admin 以下（SwipeJob 顧客管理）は個人情報を含むため、ログインした担当者だけが見られる。
const PUBLIC = [/^\/admin\/login\/?$/, /^\/admin\/setup\/?$/, /^\/admin\/invite\/[^/]+\/?$/];

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (PUBLIC.some((re) => re.test(pathname))) return NextResponse.next();

  let ok = false;
  try {
    ok = !!(await verifySession(req.cookies.get(SESSION_COOKIE)?.value));
  } catch {
    ok = false;
  }
  if (ok) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/admin/login";
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/admin", "/admin/:path*"] };
