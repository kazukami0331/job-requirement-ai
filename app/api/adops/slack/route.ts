/**
 * adops（広告の自動運用）の Slack 承認ボタンの受け口。
 *
 * draft モードで停止状態のまま入稿された広告について、Slack の「配信開始」「却下」ボタンが押されると
 * ここが呼ばれ、Meta / Google 広告の該当広告を ON（または停止のまま）にする。
 * 次回の adops の実行で媒体の状態が同期され、配信中の広告として停止判断などの対象になる。
 *
 * 必要な環境変数（Vercel）:
 *   SLACK_SIGNING_SECRET        Slack アプリの Signing Secret（必須）
 *   ADOPS_SLACK_APPROVERS       承認できる Slack ユーザー ID（カンマ区切り。未設定ならワークスペースの誰でも）
 *   META_ACCESS_TOKEN / META_APP_SECRET / META_API_VERSION
 *   GOOGLE_ADS_DEVELOPER_TOKEN / GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET / GOOGLE_ADS_REFRESH_TOKEN /
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID / GOOGLE_ADS_API_VERSION（Google の広告も承認する場合）
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { after, NextResponse } from "next/server";

export const runtime = "nodejs";

interface ApprovalValue {
  c: string;
  m: string[];
  g: string[];
}

function verifySlack(body: string, timestamp: string | null, signature: string | null): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret || !timestamp || !signature) return false;
  // リプレイ攻撃対策: 5分より古いリクエストは拒否
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function setMetaStatus(adId: string, status: "ACTIVE" | "PAUSED"): Promise<void> {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error("META_ACCESS_TOKEN が未設定です");
  const params = new URLSearchParams({ access_token: token, status });
  const secret = process.env.META_APP_SECRET;
  if (secret) params.set("appsecret_proof", createHmac("sha256", secret).update(token).digest("hex"));
  const res = await fetch(`https://graph.facebook.com/${process.env.META_API_VERSION || "v25.0"}/${adId}`, { method: "POST", body: params });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Meta ${adId}: ${err?.error?.error_user_msg || err?.error?.message || res.status}`);
  }
}

async function setGoogleStatus(resourceName: string, status: "ENABLED" | "PAUSED"): Promise<void> {
  const env = process.env;
  if (!env.GOOGLE_ADS_DEVELOPER_TOKEN || !env.GOOGLE_ADS_REFRESH_TOKEN) throw new Error("Google 広告の環境変数が未設定です");
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: env.GOOGLE_ADS_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_ADS_CLIENT_SECRET ?? "",
      refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const { access_token } = (await tokenRes.json()) as { access_token?: string };
  if (!access_token) throw new Error("Google の認証に失敗しました");
  const customer = resourceName.split("/adGroupAds/")[0];
  const headers: Record<string, string> = {
    authorization: `Bearer ${access_token}`,
    "developer-token": env.GOOGLE_ADS_DEVELOPER_TOKEN,
    "content-type": "application/json",
  };
  if (env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) headers["login-customer-id"] = env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replaceAll("-", "");
  const res = await fetch(`https://googleads.googleapis.com/${env.GOOGLE_ADS_API_VERSION || "v26"}/${customer}/adGroupAds:mutate`, {
    method: "POST",
    headers,
    body: JSON.stringify({ operations: [{ update: { resourceName, status }, updateMask: "status" }] }),
  });
  if (!res.ok) throw new Error(`Google ${resourceName}: ${(await res.text()).slice(0, 200)}`);
}

async function respond(responseUrl: string, payload: unknown): Promise<void> {
  await fetch(responseUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}

export async function POST(req: Request) {
  const body = await req.text();
  if (!verifySlack(body, req.headers.get("x-slack-request-timestamp"), req.headers.get("x-slack-signature"))) {
    return new NextResponse("invalid signature", { status: 401 });
  }
  const payload = JSON.parse(new URLSearchParams(body).get("payload") ?? "{}");
  const action = payload.actions?.[0];
  if (payload.type !== "block_actions" || !action?.action_id?.startsWith("adops_")) return new NextResponse("", { status: 200 });

  const userId: string = payload.user?.id ?? "";
  const approvers = (process.env.ADOPS_SLACK_APPROVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (approvers.length && !approvers.includes(userId)) {
    after(() => respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text: "この広告を承認する権限がありません。" }));
    return new NextResponse("", { status: 200 });
  }

  const approve = action.action_id === "adops_approve";
  const value = JSON.parse(action.value) as ApprovalValue;

  // Slack には3秒以内に応答する必要があるので、媒体の操作は応答後に行い、結果でメッセージを書き換える
  after(async () => {
    const errors: string[] = [];
    if (approve) {
      for (const id of value.m) await setMetaStatus(id, "ACTIVE").catch((e: Error) => errors.push(e.message));
      for (const rn of value.g) await setGoogleStatus(rn, "ENABLED").catch((e: Error) => errors.push(e.message));
    } else {
      // 却下: 停止のまま（念のため停止を明示）
      for (const id of value.m) await setMetaStatus(id, "PAUSED").catch((e: Error) => errors.push(e.message));
      for (const rn of value.g) await setGoogleStatus(rn, "PAUSED").catch((e: Error) => errors.push(e.message));
    }
    const when = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    const result = errors.length
      ? `:warning: <@${userId}> の${approve ? "配信開始" : "却下"}は一部失敗しました（${when}）\n${errors.join("\n")}`
      : approve
        ? `:white_check_mark: <@${userId}> が配信を開始しました（${when}）`
        : `:no_entry_sign: <@${userId}> が却下しました（${when}）`;
    const blocks = (payload.message?.blocks ?? []).filter((b: { type: string }) => b.type !== "actions");
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: result }] });
    await respond(payload.response_url, { replace_original: true, text: result, blocks });
  });

  return new NextResponse("", { status: 200 });
}
