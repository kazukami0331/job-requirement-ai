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

test("フォルダ名に使えない文字を取り除く", () => {
  assert.equal(rules.sanitizeName("山田/太郎"), "山田太郎");
  assert.equal(rules.sanitizeName("  "), "氏名不明");
  assert.equal(rules.sanitizeName(""), "氏名不明");
});
