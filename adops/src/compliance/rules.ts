/**
 * 求人広告の機械チェック（AIに任せず確定させる部分）。
 *
 * - 労働施策総合推進法 9条: 募集での年齢制限の禁止
 * - 男女雇用機会均等法 5条: 性別を限定・優遇する表現の禁止
 * - 職業安定法 5条の4: 虚偽・誤解を生じさせる求人表示の禁止（給与額の誇張など）
 * - 景品表示法: 根拠のない最上級表現（No.1・日本一 等）
 * - Meta 広告ポリシー: 個人の属性（経済状況など）を断定・示唆する表現
 * - 媒体の文字数制限（Google 広告は全角を2文字として数える）
 *
 * ここで blocker が出たら AI レビューの点数に関係なく入稿しない。
 */
import type { Brand, CreativeBrief, Job, ReviewIssue } from '../types.ts';

interface PatternRule {
  re: RegExp;
  severity: ReviewIssue['severity'];
  problem: string;
  suggestion: string;
}

const AGE_RULES: PatternRule[] = [
  {
    re: /(\d{2})\s*(歳|才)\s*(まで|以下|以内|未満|迄)/,
    severity: 'blocker',
    problem: '年齢の上限を示しています（労働施策総合推進法9条で原則禁止）',
    suggestion: '年齢には触れず、仕事内容や働き方で訴求してください',
  },
  {
    re: /(\d{2})\s*代\s*(限定|のみ|まで|希望)/,
    severity: 'blocker',
    problem: '年代を限定しています（年齢制限に当たります）',
    suggestion: '「未経験歓迎」など年齢以外の条件に置き換えてください',
  },
  {
    re: /(若い方|若手限定|若者限定|ヤング|シニア不可|中高年不可)/,
    severity: 'blocker',
    problem: '年齢を理由に応募者を限定する表現です',
    suggestion: '年齢に関係する言葉を外してください',
  },
  {
    re: /(\d{2})\s*代\s*(も|の方も)?\s*(活躍中|歓迎|中心)/,
    severity: 'minor',
    problem: '「○代活躍中」は年齢層の好みと受け取られることがあります',
    suggestion: '複数の年代を並べる（例: 20〜50代活躍中）か、事実として職場の構成を示すにとどめてください',
  },
];

const GENDER_RULES: PatternRule[] = [
  {
    re: /(男性|女性|男子|女子)\s*(限定|のみ|歓迎|優遇|希望|大歓迎)/,
    severity: 'blocker',
    problem: '性別を限定・優遇する表現です（男女雇用機会均等法5条）',
    suggestion: '性別に触れない表現にしてください',
  },
  {
    re: /(主婦|主夫)\s*(限定|のみ)/,
    severity: 'blocker',
    problem: '特定の属性に応募者を限定しています',
    suggestion: '「家庭と両立しやすい」など働き方で訴求してください',
  },
  {
    re: /(看護婦|保母|スチュワーデス|ウェイトレス|営業マン|カメラマン|職人さん求む男)/,
    severity: 'major',
    problem: '性別を前提とした職種名です',
    suggestion: '看護師・保育士・営業職のように性別に中立な職種名にしてください',
  },
];

const EXAGGERATION_RULES: PatternRule[] = [
  {
    re: /(No\.?\s*1|ナンバーワン|日本一|業界一|業界最高|地域最高|最高水準|業界トップ)/i,
    severity: 'major',
    problem: '根拠の示せない最上級表現です（景品表示法・職業安定法の的確表示）',
    suggestion: '具体的な数字や事実（例: 寮費0円、賞与年2回）に置き換えてください',
  },
  {
    re: /(必ず|絶対(に)?|確実に|100\s*%)\s*(稼げ|儲か|採用|受か|貯ま)/,
    severity: 'blocker',
    problem: '成果を保証する表現です（誤解を生じさせる表示）',
    suggestion: '「月収例」など条件つきの事実で表現してください',
  },
  {
    re: /(誰でも|だれでも)\s*(簡単|カンタン|楽)/,
    severity: 'major',
    problem: '仕事の負荷を過小に見せる表現です（入社後のミスマッチ・早期離職の原因）',
    suggestion: '「研修あり」「先輩がマンツーマンで指導」など根拠のある安心材料にしてください',
  },
];

const PERSONAL_ATTRIBUTE_RULES: PatternRule[] = [
  {
    re: /(借金|多重債務|ブラックリスト|生活保護|無職のあなた|貧乏|お金に困っ|前科)/,
    severity: 'blocker',
    problem: '閲覧者の経済状況などの個人属性を示唆する表現です（Meta 広告ポリシー違反・不承認の原因）',
    suggestion: '「まとまって貯金したい方に」のように、閲覧者を断定しない言い方にしてください',
  },
  {
    re: /(あなたは|君は).{0,10}(困って|悩んで|お金がない|仕事がない)/,
    severity: 'major',
    problem: '閲覧者の状況を断定する言い回しです（Meta の個人属性ポリシーに抵触しやすい）',
    suggestion: '二人称で状況を決めつけない表現にしてください',
  },
];

/** 「月給30万円」「日給1万2000円」「時給1,500円」「年収500万」などを円に直して取り出す。 */
export function extractPayClaims(text: string): { type: string; yen: number; raw: string }[] {
  const out: { type: string; yen: number; raw: string }[] = [];
  const normalized = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[,，]/g, '');
  const re = /(月給|日給|時給|年収|月収|日払い|日当)\s*(?:最大|最高|例)?\s*(\d+(?:\.\d+)?)\s*(万)?\s*(\d+)?\s*(円)?/g;
  for (const m of normalized.matchAll(re)) {
    const [raw, type, numStr, man, rest] = m;
    let yen = Number(numStr);
    if (man) yen = yen * 10_000 + (rest ? Number(rest) : 0);
    // 「月給30」のように単位が抜けている場合は万円とみなす
    else if (yen < 1000 && (type === '月給' || type === '月収' || type === '年収')) yen *= 10_000;
    out.push({ type, yen, raw });
  }
  return out;
}

/** 給与額の誇張チェック。求人の上限（なければ下限）を超える額を書いていたら blocker。 */
export function checkPayClaims(text: string, job: Job): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const s = job.salary;
  const cap = s.max ?? s.min;
  const sameUnit: Record<string, string[]> = {
    月給: ['月給', '月収'],
    日給: ['日給', '日当', '日払い'],
    時給: ['時給'],
    年収: ['年収'],
  };
  for (const claim of extractPayClaims(text)) {
    const unitOk = sameUnit[s.type]?.includes(claim.type);
    if (!unitOk) {
      // 単位が違う額（例: 月給求人で「年収500万」）は換算根拠が曖昧になりやすい
      issues.push({
        severity: 'major',
        field: 'copy',
        problem: `求人の給与形態（${s.type}）と異なる単位で金額を表示しています: 「${claim.raw}」`,
        suggestion: `求人票と同じ「${s.type}」で表示するか、「年収例」と条件を明記してください`,
      });
      continue;
    }
    if (claim.yen > cap) {
      issues.push({
        severity: 'blocker',
        field: 'copy',
        problem: `求人の給与上限（${s.type}${cap.toLocaleString()}円）を超える金額です: 「${claim.raw}」`,
        suggestion: `${s.type}${formatYen(s.min)}${s.max ? `〜${formatYen(s.max)}` : ''} の範囲で表示してください`,
      });
    }
  }
  return issues;
}

export function formatYen(yen: number): string {
  if (yen >= 10_000 && yen % 1000 === 0) {
    const man = yen / 10_000;
    return `${Number.isInteger(man) ? man : man.toFixed(1)}万円`;
  }
  return `${yen.toLocaleString()}円`;
}

/** Google 広告の文字数（全角=2, 半角=1）。 */
export function googleWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += /[\u0000-ÿ｡-ﾟ]/.test(ch) ? 1 : 2;
  return w;
}

export const LIMITS = {
  overlayMain: 16, // 画像上のメインコピー（全角文字数）。これ以上はスマホで読めない
  overlaySub: 28,
  badge: 10,
  metaHeadline: 40,
  metaPrimary: 250,
  googleHeadline: 30, // googleWidth 基準
  googleDescription: 90,
};

function scan(field: string, text: string, rules: PatternRule[]): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  for (const r of rules) {
    const m = text.match(r.re);
    if (m) issues.push({ severity: r.severity, field, problem: `${r.problem}（「${m[0]}」）`, suggestion: r.suggestion });
  }
  return issues;
}

/** 企画（ブリーフ）を機械的に検査する。返り値の blocker は入稿禁止。 */
export function checkBrief(brief: CreativeBrief, job: Job, brand: Brand): ReviewIssue[] {
  const fields: [string, string][] = [
    ['hook', brief.hook],
    ['headline', brief.headline],
    ['primaryText', brief.primaryText],
    ['description', brief.description],
    ['overlay.main', brief.overlay.main],
    ['overlay.sub', brief.overlay.sub],
    ...brief.overlay.badges.map((b, i) => [`overlay.badges[${i}]`, b] as [string, string]),
    ...brief.storyboard.map((s, i) => [`storyboard[${i}]`, s.text] as [string, string]),
  ];
  const issues = checkTexts(fields, job, brand);
  issues.push(...checkBriefFormat(brief));
  return issues;
}

/**
 * 任意の文章（広告コピー・SNS 投稿のキャプション等）を法令・ポリシー・求人情報との一致で検査する。
 * fields は [項目名, 文章] の組。
 */
export function checkTexts(fields: [string, string][], job: Job, brand: Brand): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const allRules = [...AGE_RULES, ...GENDER_RULES, ...EXAGGERATION_RULES, ...PERSONAL_ATTRIBUTE_RULES];
  for (const [field, text] of fields) {
    if (!text) continue;
    issues.push(...scan(field, text, allRules));
    issues.push(...checkPayClaims(text, job).map((i) => ({ ...i, field })));
    for (const phrase of brand.bannedPhrases) {
      if (phrase && text.includes(phrase)) {
        issues.push({ severity: 'major', field, problem: `社内NG表現「${phrase}」を含みます`, suggestion: '別の表現にしてください' });
      }
    }
  }

  // 求人に無い待遇を書いていないか（よくある誇張パターンだけ機械で拾う）
  const jobText = [job.title, job.employmentType, job.holidays ?? '', job.hours ?? '', job.requirements ?? '', ...job.perks, job.salary.note ?? ''].join(' ');
  const claimsNeedingBasis: [RegExp, string][] = [
    [/完全週休2日|完全週休二日/, '完全週休2日'],
    [/寮費無料|寮費0円|寮費タダ/, '寮費無料'],
    [/日払い|即日払い/, '日払い'],
    [/週払い/, '週払い'],
    [/正社員/, '正社員'],
    [/残業なし|残業ゼロ|残業0/, '残業なし'],
    [/入社祝い金/, '入社祝い金'],
  ];
  const copy = fields.map(([, t]) => t).join(' ');
  for (const [re, label] of claimsNeedingBasis) {
    if (re.test(copy) && !re.test(jobText)) {
      issues.push({
        severity: 'blocker',
        field: 'copy',
        problem: `求人情報に無い待遇「${label}」を表示しています（虚偽表示になります）`,
        suggestion: `求人情報（perks / holidays / employmentType）にある事実だけで訴求してください`,
      });
    }
  }
  return issues;
}

/** 広告フォーマット固有の検査（文字数・画像プロンプト・動画の尺）。 */
function checkBriefFormat(brief: CreativeBrief): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  // 文字数
  const len = (s: string) => [...s].length;
  if (len(brief.overlay.main) > LIMITS.overlayMain)
    issues.push({ severity: 'major', field: 'overlay.main', problem: `画像のメインコピーが長すぎます（${len(brief.overlay.main)}字 > ${LIMITS.overlayMain}字）`, suggestion: 'スマホで0.5秒で読める長さに削ってください' });
  if (len(brief.overlay.sub) > LIMITS.overlaySub)
    issues.push({ severity: 'minor', field: 'overlay.sub', problem: `サブコピーが長すぎます（${len(brief.overlay.sub)}字 > ${LIMITS.overlaySub}字）`, suggestion: '要点だけにしてください' });
  brief.overlay.badges.forEach((b, i) => {
    if (len(b) > LIMITS.badge) issues.push({ severity: 'minor', field: `overlay.badges[${i}]`, problem: `バッジが長すぎます（${len(b)}字）`, suggestion: `${LIMITS.badge}字以内にしてください` });
  });
  if (len(brief.headline) > LIMITS.metaHeadline)
    issues.push({ severity: 'minor', field: 'headline', problem: `見出しが長すぎます（${len(brief.headline)}字）`, suggestion: `${LIMITS.metaHeadline}字以内にしてください` });
  if (googleWidth(brief.headline) > LIMITS.googleHeadline)
    issues.push({ severity: 'minor', field: 'headline', problem: `Google 広告の見出し上限（半角30/全角15）を超えます。Google では短縮版を使います`, suggestion: '全角15字以内の言い回しを検討してください' });
  if (len(brief.primaryText) > LIMITS.metaPrimary)
    issues.push({ severity: 'minor', field: 'primaryText', problem: `本文が長すぎます（${len(brief.primaryText)}字）`, suggestion: '冒頭125字で要点が伝わるようにしてください' });

  // 画像生成プロンプトに文字を描かせない（Midjourney は日本語を正しく描けない）
  if (/[ぁ-んァ-ン一-龥]/.test(brief.imagePrompt))
    issues.push({ severity: 'major', field: 'imagePrompt', problem: '画像プロンプトに日本語が含まれています（画像内に崩れた文字が出る原因）', suggestion: '英語で、文字を含まない情景として書いてください' });
  if (!/no text/i.test(brief.imagePrompt))
    issues.push({ severity: 'minor', field: 'imagePrompt', problem: '画像プロンプトに "no text" がありません', suggestion: '文字は後から合成するので "no text, no letters" を入れてください' });

  if (brief.format === 'video' && brief.storyboard.length < 2)
    issues.push({ severity: 'major', field: 'storyboard', problem: '動画なのにシーンが2つ未満です', suggestion: 'フック → 条件 → 行動喚起の3カット以上にしてください' });
  const total = brief.storyboard.reduce((a, s) => a + s.seconds, 0);
  if (brief.format === 'video' && (total < 6 || total > 30))
    issues.push({ severity: 'minor', field: 'storyboard', problem: `動画の尺が ${total} 秒です`, suggestion: 'リール・ショート向けに 8〜20 秒にしてください' });

  return issues;
}

export function hasBlocker(issues: ReviewIssue[]): boolean {
  return issues.some((i) => i.severity === 'blocker');
}
