import { NextResponse, type NextRequest } from "next/server";

// /admin 以下（SwipeJob 候補者ダッシュボード）は個人情報を含むため Basic 認証で保護する。
// ADMIN_USER / ADMIN_PASSWORD が未設定のときは誰も入れない。
export function proxy(req: NextRequest) {
  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASSWORD;
  if (!user || !pass) {
    return new NextResponse(
      "ADMIN_USER と ADMIN_PASSWORD を環境変数に設定してください。",
      { status: 503 },
    );
  }
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = atob(header.slice(6));
    const i = decoded.indexOf(":");
    if (i >= 0 && decoded.slice(0, i) === user && decoded.slice(i + 1) === pass) {
      return NextResponse.next();
    }
  }
  return new NextResponse("認証が必要です", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="SwipeJob Admin", charset="UTF-8"' },
  });
}

export const config = { matcher: ["/admin", "/admin/:path*"] };
