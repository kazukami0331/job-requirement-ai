import test from "node:test";
import assert from "node:assert/strict";
import { rules, jobs } from "./loadRules.mjs";

const TODAY = new Date(2026, 8, 22); // 2026-09-22
const AGE_RULE = { limit: 70, concernFrom: 55 };

function aiResult(overrides = {}) {
  return {
    candidate: { name: "山田 太郎", nameKana: "やまだ たろう", documentsFound: ["履歴書", "職務経歴書"] },
    age: { value: null, birthDate: "1985-04-01", basis: "履歴書" },
    jobMatch: {
      bestJobId: "cad",
      alsoMatchedJobIds: [],
      matchedTools: ["AutoCAD"],
      relatedButNotListed: [],
      rating: "ok",
      reason: "AutoCAD の実務経験あり",
    },
    practicalExperience: {
      hasPractical: "yes",
      years: 8,
      evidence: ["設計事務所で AutoCAD を用いた施工図作成"],
      rating: "ok",
      reason: "設計業務で使用",
    },
    concerns: [],
    summary: "建築設計で AutoCAD を8年使用。",
    ...overrides,
  };
}

test("求人定義は3件で、スクショの対象ツールを含む", () => {
  assert.equal(jobs.length, 3);
  const cad = jobs.find((j) => j.id === "cad");
  const web = jobs.find((j) => j.id === "web");
  const it = jobs.find((j) => j.id === "it");
  // vm コンテキスト側の配列なので、こちらの realm にコピーしてから比較する
  assert.deepEqual([...cad.tools], ["AutoCAD", "Jw_cad", "Vectorworks", "Revit", "SolidWorks", "CATIA"]);
  assert.deepEqual([...web.tools], ["Illustrator", "Photoshop", "HTML/CSS", "JavaScript", "Premiere Pro"]);
  for (const tool of ["Java", "Python", "C言語", "SQL", "ネットワーク", "Linux", "AWS", "Power BI", "Power Automate", "Excel VBA"]) {
    assert.ok(it.tools.includes(tool), `${tool} が IT 求人に含まれていない`);
  }
});

test("生年月日から満年齢を計算する（誕生日前は1引く）", () => {
  assert.equal(rules.ageFromBirthDate("1985-04-01", TODAY), 41);
  assert.equal(rules.ageFromBirthDate("1985-09-22", TODAY), 41); // 当日は到達済み
  assert.equal(rules.ageFromBirthDate("1985-09-23", TODAY), 40); // 前日まではまだ
  assert.equal(rules.ageFromBirthDate("", TODAY), null);
  assert.equal(rules.ageFromBirthDate("昭和60年4月1日", TODAY), null);
});

test("生年月日が無ければ記載年齢を使う", () => {
  assert.equal(rules.resolveAge({ birthDate: "", value: 63 }, TODAY), 63);
  assert.equal(rules.resolveAge({ birthDate: "1990-01-01", value: 12 }, TODAY), 36); // 生年月日を優先
  assert.equal(rules.resolveAge({ birthDate: "", value: null }, TODAY), null);
});

test("軸1 年齢：54歳以下は◯、55〜70歳は△、71歳以上は×、不明は△", () => {
  assert.equal(rules.rateAge(41, AGE_RULE).rating, "ok");
  assert.equal(rules.rateAge(54, AGE_RULE).rating, "ok");
  assert.equal(rules.rateAge(55, AGE_RULE).rating, "concern");
  assert.equal(rules.rateAge(70, AGE_RULE).rating, "concern");
  assert.equal(rules.rateAge(71, AGE_RULE).rating, "ng");
  assert.equal(rules.rateAge(null, AGE_RULE).rating, "concern");
});

test("軸2 求人適合：該当求人なしは必ず×", () => {
  const rated = rules.rateJobMatch({ bestJobId: "none", rating: "ok", matchedTools: ["Excel"] });
  assert.equal(rated.rating, "ng");
  assert.equal(rated.jobId, "none");
});

test("軸2 求人適合：対象ツールが1つも無ければ◯にしない", () => {
  const rated = rules.rateJobMatch({
    bestJobId: "cad",
    rating: "ok",
    matchedTools: [],
    relatedButNotListed: ["Fusion 360"],
  });
  assert.equal(rated.rating, "concern");
});

test("軸3 実務経験：hasPractical と rating の厳しい方を採る", () => {
  assert.equal(rules.rateExperience({ hasPractical: "yes", rating: "ok" }).rating, "ok");
  assert.equal(rules.rateExperience({ hasPractical: "yes", rating: "concern" }).rating, "concern");
  assert.equal(rules.rateExperience({ hasPractical: "unclear", rating: "ok" }).rating, "concern");
  assert.equal(rules.rateExperience({ hasPractical: "no", rating: "ok" }).rating, "ng");
  assert.equal(rules.rateExperience({}).rating, "concern"); // 情報が無ければ人が見る
});

test("総合判定：×があれば不合格、全部◯なら合格、それ以外は要確認", () => {
  assert.equal(rules.overallVerdict(["ok", "ok", "ok"]), "pass");
  assert.equal(rules.overallVerdict(["ok", "concern", "ok"]), "review");
  assert.equal(rules.overallVerdict(["ng", "ok", "ok"]), "fail");
  assert.equal(rules.overallVerdict(["ng", "concern", "ok"]), "fail");
});

test("全軸◯の候補者は合格になる", () => {
  const a = rules.buildAssessment(aiResult(), { today: TODAY, ageRule: AGE_RULE });
  assert.equal(a.verdict, "pass");
  assert.equal(a.verdictLabel, "合格");
  assert.equal(a.jobName, "CAD講師");
  assert.equal(a.axes.age.age, 41);
  assert.deepEqual(a.concerns, []);
});

test("58歳・他は◯なら要確認になり、懸念点に年齢が載る", () => {
  const a = rules.buildAssessment(
    aiResult({ age: { value: null, birthDate: "1968-01-10", basis: "履歴書" } }),
    { today: TODAY, ageRule: AGE_RULE },
  );
  assert.equal(a.verdict, "review");
  assert.equal(a.axes.age.age, 58);
  assert.ok(a.concerns.some((c) => c.startsWith("【年齢】")));
});

test("72歳は不合格になる", () => {
  const a = rules.buildAssessment(
    aiResult({ age: { value: 72, birthDate: "", basis: "履歴書" } }),
    { today: TODAY, ageRule: AGE_RULE },
  );
  assert.equal(a.verdict, "fail");
  assert.equal(a.axes.age.rating, "ng");
});

test("3分野いずれにも該当しなければ不合格", () => {
  const a = rules.buildAssessment(
    aiResult({
      jobMatch: {
        bestJobId: "none",
        alsoMatchedJobIds: [],
        matchedTools: [],
        relatedButNotListed: ["簿記"],
        rating: "ng",
        reason: "経理職のみ",
      },
      practicalExperience: { hasPractical: "no", years: null, evidence: [], rating: "ng", reason: "該当分野の経験なし" },
    }),
    { today: TODAY, ageRule: AGE_RULE },
  );
  assert.equal(a.verdict, "fail");
  assert.equal(a.jobName, "該当なし");
});

test("スクール受講のみ（実務不明）は要確認になる", () => {
  const a = rules.buildAssessment(
    aiResult({
      jobMatch: {
        bestJobId: "web",
        alsoMatchedJobIds: [],
        matchedTools: ["Photoshop", "Illustrator"],
        relatedButNotListed: [],
        rating: "ok",
        reason: "Photoshop/Illustrator の記載あり",
      },
      practicalExperience: {
        hasPractical: "unclear",
        years: null,
        evidence: ["職業訓練校で Photoshop を学習"],
        rating: "concern",
        reason: "学習歴のみで実務かどうか不明",
      },
    }),
    { today: TODAY, ageRule: AGE_RULE },
  );
  assert.equal(a.verdict, "review");
  assert.ok(a.concerns.some((c) => c.startsWith("【実務経験】")));
});

test("AIが何も返せなかった場合も落ちずに判定できる", () => {
  const a = rules.buildAssessment({}, { today: TODAY, ageRule: AGE_RULE });
  assert.equal(a.axes.age.rating, "concern"); // 年齢不明は懸念扱い
  assert.equal(a.axes.experience.rating, "concern");
  assert.equal(a.verdict, "fail"); // 求人適合が none なので不合格
});

test("件名から氏名を取り出す：【Winスクール応募】氏名（大文字小文字は問わない）", () => {
  assert.equal(rules.nameFromSubject("【Winスクール応募】山田太郎"), "山田太郎");
  assert.equal(rules.nameFromSubject("【WINスクール応募】山田太郎"), "山田太郎");
  assert.equal(rules.nameFromSubject("【winスクール応募】山田 太郎"), "山田 太郎");
  assert.equal(rules.nameFromSubject("Fwd: 【Winスクール応募】山田太郎"), "山田太郎");
  assert.equal(rules.nameFromSubject("[Winスクール応募] 山田太郎"), "山田太郎");
  assert.equal(rules.nameFromSubject("【Winスクール応募】山田太郎様"), "山田太郎");
  assert.equal(rules.nameFromSubject("Winスクール応募　山田太郎"), "山田太郎");
});

test("件名から氏名を取り出す（転送・括弧・全角の揺れを吸収）", () => {
  assert.equal(rules.nameFromSubject("【応募】山田太郎"), "山田太郎");
  assert.equal(rules.nameFromSubject("【応募】山田 太郎"), "山田 太郎");
  assert.equal(rules.nameFromSubject("Fwd: 【応募】山田太郎"), "山田太郎");
  assert.equal(rules.nameFromSubject("Re: Fwd: [応募] 山田太郎"), "山田太郎");
  assert.equal(rules.nameFromSubject("応募：山田太郎"), "山田太郎");
  assert.equal(rules.nameFromSubject("【応募】山田太郎様"), "山田太郎");
  assert.equal(rules.nameFromSubject("【応募書類】山田太郎（CAD講師）"), "山田太郎");
});

test("件名が指定の書式でなければ氏名は取らない（書類側に任せる）", () => {
  assert.equal(rules.nameFromSubject("履歴書を送付いたします"), "");
  assert.equal(rules.nameFromSubject(""), "");
  assert.equal(rules.nameFromSubject("【応募】taro.yamada@example.com"), "");
  assert.equal(rules.nameFromSubject("【応募】" + "あ".repeat(30)), ""); // 氏名にしては長すぎる
});

test("氏名の一致判定は表記ゆれを吸収し、片方が空なら不一致にしない", () => {
  assert.equal(rules.isNameMismatch("山田太郎", "山田 太郎"), false);
  assert.equal(rules.isNameMismatch("山田太郎", "山田太郎（旧姓 佐藤）"), false);
  assert.equal(rules.isNameMismatch("", "山田太郎"), false);
  assert.equal(rules.isNameMismatch("山田太郎", ""), false);
  assert.equal(rules.isNameMismatch("山田太郎", "鈴木花子"), true);
});

test("件名と書類の氏名が食い違うと、合格でも要確認に落ちる", () => {
  const a = rules.buildAssessment(aiResult(), {
    today: TODAY,
    ageRule: AGE_RULE,
    subjectName: "鈴木花子",
  });
  assert.equal(a.verdict, "review");
  assert.equal(a.candidate.nameMismatch, true);
  assert.ok(a.concerns.some((c) => c.startsWith("【氏名】")));
});

test("氏名が一致していれば合格のまま", () => {
  const a = rules.buildAssessment(aiResult(), {
    today: TODAY,
    ageRule: AGE_RULE,
    subjectName: "山田 太郎",
  });
  assert.equal(a.verdict, "pass");
  assert.equal(a.candidate.nameMismatch, false);
});

test("ドライブURLからフォルダIDを取り出す", () => {
  assert.equal(
    rules.folderIdFromUrl("https://drive.google.com/drive/folders/1ZowhopNqFMpUoJP86f5qC0jTMkwpBjbt?usp=drive_link"),
    "1ZowhopNqFMpUoJP86f5qC0jTMkwpBjbt",
  );
  assert.equal(
    rules.folderIdFromUrl("https://drive.google.com/drive/u/0/folders/1ZowhopNqFMpUoJP86f5qC0jTMkwpBjbt"),
    "1ZowhopNqFMpUoJP86f5qC0jTMkwpBjbt",
  );
  // ID をそのまま渡された場合
  assert.equal(
    rules.folderIdFromUrl("1ZowhopNqFMpUoJP86f5qC0jTMkwpBjbt"),
    "1ZowhopNqFMpUoJP86f5qC0jTMkwpBjbt",
  );
});

test("ドライブURL：解釈できない入力は null（誤ったIDを作らない）", () => {
  assert.equal(rules.folderIdFromUrl(""), null);
  assert.equal(rules.folderIdFromUrl("https://drive.google.com/drive/my-drive"), null);
  assert.equal(rules.folderIdFromUrl("短い"), null);
});

test("通知先：設定どおりに返す", () => {
  assert.deepEqual([...rules.resolveNotifyChannels(["slack"], true).channels], ["slack"]);
  assert.deepEqual([...rules.resolveNotifyChannels(["email"], true).channels], ["email"]);
  assert.deepEqual([...rules.resolveNotifyChannels(["email", "slack"], true).channels], ["email", "slack"]);
  assert.equal(rules.resolveNotifyChannels(["slack"], true).warning, "");
});

test("通知先：Webhookが無いのにSlack指定ならメールに倒す（通知を消さない）", () => {
  const r = rules.resolveNotifyChannels(["slack"], false);
  assert.deepEqual([...r.channels], ["email"]);
  assert.match(r.warning, /SLACK_WEBHOOK_URL/);
});

test("通知先：email,slack でWebhookが無ければメールだけ残す", () => {
  const r = rules.resolveNotifyChannels(["email", "slack"], false);
  assert.deepEqual([...r.channels], ["email"]);
});

test("通知先：不正な値や空ならメールに倒す", () => {
  assert.deepEqual([...rules.resolveNotifyChannels([], true).channels], ["email"]);
  assert.deepEqual([...rules.resolveNotifyChannels(["line", "sms"], true).channels], ["email"]);
  assert.match(rules.resolveNotifyChannels(["line"], true).warning, /NOTIFY_VIA/);
});

test("コスト計算：モデルごとの単価で入出力トークンから算出する", () => {
  // Opus 5: 入力 $5 / 出力 $25 （100万トークンあたり）
  const opus = rules.estimateCost(
    "claude-opus-5",
    { input_tokens: 12000, output_tokens: 1500 },
    150,
  );
  assert.equal(Math.round(opus.usd * 10000) / 10000, 0.0975); // 0.06 + 0.0375
  assert.equal(Math.round(opus.jpy * 100) / 100, 14.63);

  // Sonnet 5: 入力 $2 / 出力 $10 なので Opus の 4割
  const sonnet = rules.estimateCost(
    "claude-sonnet-5",
    { input_tokens: 12000, output_tokens: 1500 },
    150,
  );
  assert.equal(Math.round(sonnet.usd * 10000) / 10000, 0.039);
});

test("コスト計算：キャッシュ分も入力トークンに含める", () => {
  const withCache = rules.estimateCost(
    "claude-opus-5",
    { input_tokens: 1000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 2000, output_tokens: 0 },
    150,
  );
  assert.equal(Math.round(withCache.usd * 10000) / 10000, 0.06); // 12,000トークン分
});

test("コスト計算：単価が分からないモデルや実績なしは null（推測しない）", () => {
  assert.equal(rules.estimateCost("claude-unknown-9", { input_tokens: 100, output_tokens: 10 }, 150), null);
  assert.equal(rules.estimateCost("claude-opus-5", null, 150), null);
  assert.equal(rules.estimateCost("claude-opus-5", { input_tokens: 0, output_tokens: 0 }, 150), null);
});

test("使用量の1行表示にモデル・トークン・概算円が入る", () => {
  const line = rules.formatUsage("claude-opus-5", { input_tokens: 12000, output_tokens: 1500 }, 150);
  assert.match(line, /claude-opus-5/);
  assert.match(line, /入力 12000トークン/);
  assert.match(line, /出力 1500トークン/);
  assert.match(line, /約14\.6円/);
});

test("使用量の1行表示：単価不明のモデルはコストを出さない", () => {
  const line = rules.formatUsage("claude-unknown-9", { input_tokens: 100, output_tokens: 10 }, 150);
  assert.match(line, /claude-unknown-9/);
  assert.doesNotMatch(line, /概算/);
});

test("フォルダ名に使えない文字を取り除く", () => {
  assert.equal(rules.sanitizeName("山田/太郎"), "山田太郎");
  assert.equal(rules.sanitizeName("  "), "氏名不明");
  assert.equal(rules.sanitizeName(""), "氏名不明");
});
