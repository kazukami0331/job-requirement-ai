import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { crmForUser } from "@/lib/crm";
import { callResultLabel } from "@/lib/crmConstants";
import { lookupJobs } from "@/lib/candidateJobs";
import { formatJst, getCandidate } from "@/lib/swipeAdmin";

const SYSTEM = `あなたは日本の転職エージェント（人材紹介）のベテランキャリアアドバイザーです。
求職者が求人アプリでスワイプした結果（Like / Pass）と、プロフィール、架電メモをもとに、
エージェントのメンバーが「他にどんな求人を提案すればよいか」を判断するための示唆をまとめてください。

出力は日本語のプレーンテキスト（見出しは【】、項目は「・」）で、次の順に書きます。
【軸の仮説】優先度の高い順に 3〜5 個。それぞれ一言の根拠（どの求人・どの条件から読み取れるか）を添える
【避けていそうな条件】Pass の傾向から
【架電で確認したいこと】仮説を確かめる質問を 3〜5 個
【他の求人を探すときの条件】求人検索サイトでそのまま使える粒度（勤務地 / 職種 / 年収 / 休日・働き方 / その他）
【提案時の訴求ポイント】求人を勧めるときに響きそうな言い方

推測は推測と分かるように書き、データにないことを断定しないでください。全体で 600〜900 字程度。`;

/** 候補者の Like / Pass・プロフィール・架電メモから、AI に軸の示唆を作らせる */
export async function generateAiInsight(userId: string) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY が設定されていません。Vercel の環境変数に追加して再デプロイしてください。");
  }
  const data = await getCandidate(userId);
  if (!data) throw new Error("候補者が見つかりません");
  const crm = await crmForUser(userId).catch(() => null);

  const ids = data.swipes.map((s) => s.jobId);
  const jobs = await lookupJobs(ids);
  const line = (jobId: string, withDesc: boolean) => {
    const j = jobs.get(jobId);
    if (!j) return `- ${jobId}（求人データなし）`;
    const parts = [
      `- ${j.company ?? ""}／${j.title ?? ""}`,
      `  勤務地: ${j.location ?? j.prefecture ?? "不明"} / 年収: ${j.salary ?? "不明"} / 職種: ${j.jobTypeSmallCategory ?? j.jobType ?? "不明"} / 業界: ${j.industryCategory ?? j.industry ?? "不明"} / 従業員数: ${j.employeeCount ?? "不明"}`,
      `  条件タグ: ${(j.tags ?? []).join("、") || "なし"}`,
    ];
    if (withDesc && j.description) parts.push(`  仕事内容(抜粋): ${j.description.replace(/\s+/g, " ").slice(0, 500)}`);
    return parts.join("\n");
  };
  const liked = data.swipes.filter((s) => s.action === "like");
  const passed = data.swipes.filter((s) => s.action !== "like");
  const p = data.profile;
  const notes = (crm?.activities ?? [])
    .filter((a) => a.note)
    .map((a) => `- ${formatJst(a.occurred_at)} ${a.type === "call" ? `架電(${callResultLabel(a.result)})` : "メモ"}: ${a.note}`);

  const userContent = [
    `# 求職者: ${data.user.name ?? "（名前未登録）"}`,
    "## プロフィール（本人入力）",
    p
      ? [
          `希望職種: ${p.desiredJobType ?? ""} ${(p.desiredJobTypeSmallCategories ?? p.desiredJobTypeLargeCategories ?? []).join("、")}`,
          `希望勤務地: ${(p.desiredLocations ?? []).join("、")}`,
          `希望年収: ${p.desiredSalary ?? "未入力"} / 現年収: ${p.currentSalary ?? "未入力"}`,
          `希望業界: ${(p.desiredIndustries ?? []).join("、")}`,
          `希望の働き方: ${(p.desiredWorkStyle ?? []).join("、")}`,
          `スキル: ${(p.skills ?? []).join("、")}`,
          `職歴: ${(p.workHistory ?? []).map((w) => (typeof w === "string" ? w : JSON.stringify(w))).join(" / ")}`,
        ].join("\n")
      : "なし",
    `## Like した求人（${liked.length} 件）`,
    liked.map((s) => line(s.jobId, true)).join("\n") || "なし",
    `## Pass した求人（${passed.length} 件）`,
    passed.map((s) => line(s.jobId, false)).join("\n") || "なし",
    "## 架電・メモ",
    notes.join("\n") || "なし",
  ].join("\n\n");

  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    output_config: { effort: "medium" },
    // 安全上の理由で断られたときは、サーバー側で自動的に別モデルで答え直す
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content: userContent }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("AI が回答できませんでした。時間をおいて再度お試しください。");
  }
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("AI の回答が空でした");
  return text;
}
