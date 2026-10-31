/**
 * adops（広告の自動運用）の Slack 承認ボタンの受け口。
 *
 * draft モードで停止状態のまま入稿された広告について、Slack の「配信開始」「却下」ボタンが押されると
 * ここが呼ばれ、Meta / Google 広告の該当広告を ON（または停止のまま）にする。
 * 次回の adops の実行で媒体の状態が同期され、配信中の広告として停止判断などの対象になる。
 *
 * 必要な環境変数（Vercel）:
 *   SLACK_SIGNING_SECRET        Slack アプリの Signing Secret（必須）
 *   ADOPS_APPROVAL_SECRET       ボタンの値の署名鍵（必須。GitHub 側の ADOPS_APPROVAL_SECRET と同じ値）
 *   ADOPS_SLACK_APPROVERS       承認できる Slack ユーザー ID（カンマ区切り。必須。未設定なら誰も承認できない）
 *   META_ACCESS_TOKEN / META_APP_SECRET / META_API_VERSION
 *   GOOGLE_ADS_DEVELOPER_TOKEN / GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET / GOOGLE_ADS_REFRESH_TOKEN /
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID / GOOGLE_ADS_API_VERSION（Google の広告も承認する場合）
 *   ADOPS_GITHUB_TOKEN / ADOPS_GITHUB_REPO   設定すると、承認の前に adops の状態（adops-state ブランチの state.json）を見て、
 *                               緊急停止中や adops が止めた広告の承認を断る（Google の広告は名前で判別できないため、設定を推奨）
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { after, NextResponse } from "next/server";

export const runtime = "nodejs";

interface ApprovalValue {
  c: string;
  m: string[];
  g: string[];
  e: number;
  s: string;
}

/** adops が止めた広告の名前に付く印（adops/src/platforms/meta.ts の STOP_MARK と同じ） */
const STOP_MARK = "[adops停止]";

/** ボタンの値が adops の発行したものか（改ざん・偽ボタン対策）と、有効期限内かを確かめる。 */
function verifyValue(v: ApprovalValue): string | null {
  const secret = process.env.ADOPS_APPROVAL_SECRET;
  if (!secret) return "ADOPS_APPROVAL_SECRET が未設定です";
  if (!Array.isArray(v.m) || !Array.isArray(v.g) || typeof v.s !== "string") return "ボタンの値が不正です";
  if (!v.m.every((id) => /^\d+$/.test(id))) return "Meta の広告 ID が不正です";
  if (!v.g.every((rn) => /^customers\/\d+\/adGroupAds\/\d+~\d+$/.test(rn))) return "Google の広告 ID が不正です";
  const expected = createHmac("sha256", secret).update(`${v.c}|${v.m.join(",")}|${v.g.join(",")}|${v.e}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v.s);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "ボタンの署名が一致しません";
  if (!(v.e > Date.now() / 1000)) return "このボタンは有効期限（48時間）が切れています。次回の通知か管理画面から操作してください";
  return null;
}

/**
 * adops の状態から、承認してよいかを確かめる。緊急停止中や、adops が止めた・入れ替えたクリエイティブは承認させない。
 * GitHub の設定が無ければ確認しない（null）。状態を読めなければ安全側に倒して断る。
 */
async function stateBlocksApproval(creativeId: string): Promise<string | null> {
  const repo = process.env.ADOPS_GITHUB_REPO;
  const token = process.env.ADOPS_GITHUB_TOKEN;
  if (!repo || !token) return null;
  const branch = process.env.ADOPS_STATE_BRANCH || "adops-state";
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/state.json?ref=${encodeURIComponent(branch)}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github.raw", "x-github-api-version": "2022-11-28" },
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok) {
    console.error(`adops state.json の取得に失敗: ${res ? `HTTP ${res.status}` : "接続失敗"}（ADOPS_GITHUB_TOKEN に Contents: Read-only 権限が必要）`);
    return `adops の状態を読めなかったため、承認を保留しました（${res ? `HTTP ${res.status}` : "接続失敗"}）。トークンの Contents 権限を確認するか、管理画面で操作してください`;
  }
  const state = (await res.json().catch(() => null)) as { halted?: { reason: string }; creatives?: Record<string, { status?: string }> } | null;
  if (!state) return "adops の状態を読めなかったため、承認を保留しました";
  if (state.halted) return `adops は緊急停止中のため承認できません（${state.halted.reason}）。解除してから管理画面で操作してください`;
  const status = state.creatives?.[creativeId]?.status;
  if (status && status !== "published") return `このクリエイティブは adops が ${status} にしたため承認できません`;
  return null;
}

/** adops が止めた広告（停止判断・緊急停止）を、古い承認ボタンで再開させない。 */
async function metaAdIsAwaitingApproval(adId: string): Promise<string | null> {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return "META_ACCESS_TOKEN が未設定です";
  const params = new URLSearchParams({ access_token: token, fields: "name,status" });
  const secret = process.env.META_APP_SECRET;
  if (secret) params.set("appsecret_proof", createHmac("sha256", secret).update(token).digest("hex"));
  const res = await fetch(`https://graph.facebook.com/${process.env.META_API_VERSION || "v25.0"}/${adId}?${params}`);
  if (!res.ok) return `Meta ${adId} の状態を取得できませんでした`;
  const ad = (await res.json()) as { name?: string; status?: string };
  if (ad.name?.includes(STOP_MARK)) return `Meta ${adId} は adops が停止した広告のため再開しません`;
  if (ad.status !== "PAUSED") return `Meta ${adId} は承認待ちの状態ではありません（${ad.status}）`;
  return null;
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
  const form = new URLSearchParams(body);
  // スラッシュコマンド（/adops stop | resume）
  if (form.get("command")) return slashCommand(form);
  const payload = JSON.parse(form.get("payload") ?? "{}");
  const action = payload.actions?.[0];
  if (payload.type !== "block_actions" || !action?.action_id?.startsWith("adops_")) return new NextResponse("", { status: 200 });

  const userId: string = payload.user?.id ?? "";
  const approvers = (process.env.ADOPS_SLACK_APPROVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  // 承認者が未設定なら誰にも承認させない（有料の広告を誰でも ON にできてしまうため）
  if (!approvers.includes(userId)) {
    after(() => respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text: "この広告を承認する権限がありません。" }));
    return new NextResponse("", { status: 200 });
  }

  const approve = action.action_id === "adops_approve";
  let value: ApprovalValue;
  try {
    value = JSON.parse(action.value) as ApprovalValue;
  } catch {
    return new NextResponse("", { status: 200 });
  }
  const invalid = verifyValue(value);
  if (invalid) {
    after(() => respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text: invalid }));
    return new NextResponse("", { status: 200 });
  }

  // Slack には3秒以内に応答する必要があるので、媒体の操作は応答後に行い、結果でメッセージを書き換える
  after(async () => {
    const errors: string[] = [];
    let blockedByState = approve ? await stateBlocksApproval(value.c) : null;
    // Google の広告は adops が止めた印を付けられないので、状態を確認できないときは承認しない
    if (approve && !blockedByState && value.g.length && !(process.env.ADOPS_GITHUB_REPO && process.env.ADOPS_GITHUB_TOKEN)) {
      blockedByState = "Google の広告を承認するには ADOPS_GITHUB_REPO / ADOPS_GITHUB_TOKEN の設定が必要です（adops が止めた広告を誤って再開しないため）。管理画面で操作してください";
    }
    if (blockedByState) {
      // ボタンは残したまま、押した人にだけ理由を返す
      await respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text: blockedByState });
      return;
    }
    if (approve) {
      for (const id of value.m) {
        const blocked = await metaAdIsAwaitingApproval(id);
        if (blocked) {
          errors.push(blocked);
          continue;
        }
        await setMetaStatus(id, "ACTIVE").catch((e: Error) => errors.push(e.message));
      }
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

/**
 * /adops stop | resume — GitHub Actions の adops ワークフローを緊急操作として起動する。
 * /adops lp <ID> | lp-off <ID> — 応募ページ（LP）の下書きを承認して公開する / 公開を終了する（数分で反映）。
 * 必要な環境変数: ADOPS_GITHUB_REPO、ADOPS_GITHUB_TOKEN（Contents: Read-only と Actions: Read and write の両方。承認の安全確認と共用）、ADOPS_SLACK_APPROVERS。
 */
async function slashCommand(form: URLSearchParams): Promise<Response> {
  const reply = (text: string) => NextResponse.json({ response_type: "ephemeral", text });
  const userId = form.get("user_id") ?? "";
  const approvers = (process.env.ADOPS_SLACK_APPROVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!approvers.includes(userId)) return reply("この操作をする権限がありません（ADOPS_SLACK_APPROVERS）。");
  const [sub = "", ...args] = (form.get("text") ?? "").trim().toLowerCase().split(/\s+/);
  const lpIds = args.join(",").split(",").filter(Boolean);
  const isLp = sub === "lp" || sub === "lp-off";
  if (isLp && (!lpIds.length || !lpIds.every((id) => /^[a-z0-9-]{3,80}$/.test(id)))) {
    return reply("使い方: `/adops lp <LP の ID>`（下書きを承認して公開） / `/adops lp-off <LP の ID>`（公開を終了）。ID は日次サマリに出ています。");
  }
  if (!isLp && sub !== "stop" && sub !== "resume") {
    return reply("使い方: `/adops stop`（adops の広告をすべて停止し、新しい入稿も止める） / `/adops resume`（解除） / `/adops lp <ID>`（LP を公開） / `/adops lp-off <ID>`（LP の公開を終了）");
  }
  const repo = process.env.ADOPS_GITHUB_REPO;
  const token = process.env.ADOPS_GITHUB_TOKEN;
  if (!repo || !token) return reply("ADOPS_GITHUB_REPO / ADOPS_GITHUB_TOKEN が未設定です。");
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/adops.yml/dispatches`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" },
    body: JSON.stringify({
      ref: process.env.ADOPS_GITHUB_REF || "main",
      inputs: isLp ? { [sub === "lp" ? "lp_approve" : "lp_retire"]: lpIds.join(",") } : { control: sub },
    }),
  });
  if (!res.ok) return reply(`ワークフローを起動できませんでした（GitHub ${res.status}）。Actions の画面から実行してください。`);
  after(() =>
    fetch(form.get("response_url") ?? "", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        response_type: "in_channel",
        text: isLp
          ? `:page_facing_up: <@${userId}> が応募ページ ${lpIds.join(", ")} の${sub === "lp" ? "公開" : "公開終了"}を実行しました（数分で反映。結果は Slack に届きます）`
          : sub === "stop"
            ? `:octagonal_sign: <@${userId}> が adops の緊急停止を実行しました（数分で全広告が止まります）`
            : `:arrow_forward: <@${userId}> が adops の緊急停止を解除しました`,
      }),
    }).then(() => undefined, () => undefined),
  );
  return reply(isLp ? "受け付けました。数分後に Slack に結果が届きます。" : sub === "stop" ? "緊急停止を開始しました。数分後に Slack に結果が届きます。" : "解除を開始しました。");
}
