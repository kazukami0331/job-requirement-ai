/**
 * 判定ロジック（純粋関数のみ）。
 * GAS の API には一切依存しないので、test/rules.test.mjs から直接読み込んでテストできる。
 *
 * 評価軸は3つ。それぞれ ok（◯）/ concern（△）/ ng（×）で判定する。
 *   軸1 年齢　　　：AGE_LIMIT 以下か。AGE_CONCERN_FROM 以上は懸念。
 *   軸2 求人適合　：3求人のいずれかの対象ツール・分野に当てはまるか。
 *   軸3 実務経験　：軸2の分野での実務経験があるか（年数は問わない）。
 *
 * 総合判定は
 *   × が1つでもあれば fail（不合格）
 *   すべて ◯ なら pass（合格）
 *   それ以外（△を含む）は review（要確認＝通知して人が判断する）
 */

var RATING_SYMBOL = { ok: '◯', concern: '△', ng: '×' };
var RATING_ORDER = { ok: 0, concern: 1, ng: 2 };

var VERDICT_LABEL = {
  pass: '合格',
  review: '要確認',
  fail: '不合格',
  unknown: '判定不可'
};

var DEFAULT_AGE_RULE = { limit: 70, concernFrom: 55 };

/** ratingSymbol('ok') -> '◯' */
function ratingSymbol(rating) {
  return RATING_SYMBOL[rating] || '－';
}

/** 2つの評価のうち厳しい方を返す。ok < concern < ng。 */
function stricterRating(a, b) {
  var ra = RATING_ORDER[a] === undefined ? RATING_ORDER.concern : RATING_ORDER[a];
  var rb = RATING_ORDER[b] === undefined ? RATING_ORDER.concern : RATING_ORDER[b];
  return ra >= rb ? normalizeRating(a) : normalizeRating(b);
}

/** 想定外の値が来たら concern（＝人が見る）に倒す。 */
function normalizeRating(rating) {
  return RATING_ORDER[rating] === undefined ? 'concern' : rating;
}

/**
 * 生年月日（YYYY-MM-DD）と基準日から満年齢を計算する。
 * 解釈できない場合は null。
 */
function ageFromBirthDate(birthDate, today) {
  if (!birthDate) return null;
  var m = String(birthDate).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  var year = Number(m[1]);
  var month = Number(m[2]);
  var day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  var age = today.getFullYear() - year;
  var monthDiff = (today.getMonth() + 1) - month;
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < day)) age -= 1;
  if (age < 0 || age > 120) return null;
  return age;
}

/**
 * 年齢が判明していればそれを、していなければ生年月日から計算した値を返す。
 * どちらも取れなければ null。
 */
function resolveAge(aiAge, today) {
  var info = aiAge || {};
  var fromBirth = ageFromBirthDate(info.birthDate, today);
  if (fromBirth !== null) return fromBirth;
  if (typeof info.value === 'number' && isFinite(info.value) && info.value > 0 && info.value < 120) {
    return Math.floor(info.value);
  }
  return null;
}

/** 軸1：年齢。 */
function rateAge(age, rule) {
  var r = rule || DEFAULT_AGE_RULE;
  if (age === null || age === undefined) {
    return {
      rating: 'concern',
      age: null,
      reason: '書類から年齢・生年月日を読み取れませんでした。要確認です。'
    };
  }
  if (age > r.limit) {
    return {
      rating: 'ng',
      age: age,
      reason: age + '歳。上限の' + r.limit + '歳を超えています。'
    };
  }
  if (age >= r.concernFrom) {
    return {
      rating: 'concern',
      age: age,
      reason: age + '歳。' + r.concernFrom + '歳以上のため懸念要件に該当します（上限' + r.limit + '歳内）。'
    };
  }
  return { rating: 'ok', age: age, reason: age + '歳。年齢要件を満たしています。' };
}

/**
 * 軸2：求人適合。
 * AI の判定を使いつつ、明らかな矛盾はコード側で厳しい方に倒す。
 *   - 該当求人なし（none）なら必ず ×
 *   - 対象ツールに1つも当てはまらなければ ◯ にはしない
 */
function rateJobMatch(jobMatch) {
  var info = jobMatch || {};
  var jobId = info.bestJobId || 'none';
  var matchedTools = info.matchedTools || [];
  var related = info.relatedButNotListed || [];

  if (jobId === 'none' || !findJob(jobId)) {
    return {
      rating: 'ng',
      jobId: 'none',
      matchedTools: [],
      relatedButNotListed: related,
      reason: info.reason || '3求人のいずれの対象分野・ツールにも該当しませんでした。'
    };
  }

  var rating = normalizeRating(info.rating);
  if (matchedTools.length === 0) {
    rating = stricterRating(rating, 'concern');
  }

  return {
    rating: rating,
    jobId: jobId,
    matchedTools: matchedTools,
    relatedButNotListed: related,
    reason: info.reason || ''
  };
}

/**
 * 軸3：実務経験（年数は問わない）。
 * hasPractical（yes / unclear / no）と AI の rating の厳しい方を採用する。
 */
function rateExperience(experience) {
  var info = experience || {};
  var byFlag = { yes: 'ok', unclear: 'concern', no: 'ng' }[info.hasPractical] || 'concern';
  var rating = stricterRating(byFlag, normalizeRating(info.rating));
  return {
    rating: rating,
    years: (typeof info.years === 'number' && isFinite(info.years)) ? info.years : null,
    evidence: info.evidence || [],
    reason: info.reason || ''
  };
}

/** 3軸から総合判定を出す。 */
function overallVerdict(ratings) {
  for (var i = 0; i < ratings.length; i++) {
    if (normalizeRating(ratings[i]) === 'ng') return 'fail';
  }
  for (var j = 0; j < ratings.length; j++) {
    if (normalizeRating(ratings[j]) !== 'ok') return 'review';
  }
  return 'pass';
}

/**
 * AI の抽出結果（schema に沿った JSON）から最終的な評価オブジェクトを組み立てる。
 * options: { today: Date, ageRule: {limit, concernFrom} }
 */
function buildAssessment(aiResult, options) {
  var opts = options || {};
  var today = opts.today || new Date();
  var ageRule = opts.ageRule || DEFAULT_AGE_RULE;
  var result = aiResult || {};

  var age = rateAge(resolveAge(result.age, today), ageRule);
  var job = rateJobMatch(result.jobMatch);
  var exp = rateExperience(result.practicalExperience);
  var verdict = overallVerdict([age.rating, job.rating, exp.rating]);

  var concerns = (result.concerns || []).slice();
  if (age.rating === 'concern') concerns.push('【年齢】' + age.reason);
  if (job.rating === 'concern') concerns.push('【求人適合】' + (job.reason || '対象ツールそのものの経験が確認できません。'));
  if (exp.rating === 'concern') concerns.push('【実務経験】' + (exp.reason || '実務経験かどうか書類から判別できません。'));

  var candidate = result.candidate || {};
  return {
    verdict: verdict,
    verdictLabel: VERDICT_LABEL[verdict],
    candidate: {
      name: candidate.name || '',
      nameKana: candidate.nameKana || '',
      documentsFound: candidate.documentsFound || []
    },
    axes: {
      age: age,
      jobMatch: job,
      experience: exp
    },
    jobId: job.jobId,
    jobName: jobLabel(job.jobId),
    concerns: concerns,
    summary: result.summary || ''
  };
}

/** 候補者名をフォルダ名に使える形に整える。 */
function sanitizeName(name) {
  var cleaned = String(name || '').replace(/[\\\/:*?"<>|\r\n\t]/g, '').trim();
  if (!cleaned) return '氏名不明';
  return cleaned.length > 40 ? cleaned.slice(0, 40) : cleaned;
}

// node 側のテストから読み込むためのエクスポート。GAS 実行時には typeof module === 'undefined' なので無視される。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ratingSymbol: ratingSymbol,
    stricterRating: stricterRating,
    normalizeRating: normalizeRating,
    ageFromBirthDate: ageFromBirthDate,
    resolveAge: resolveAge,
    rateAge: rateAge,
    rateJobMatch: rateJobMatch,
    rateExperience: rateExperience,
    overallVerdict: overallVerdict,
    buildAssessment: buildAssessment,
    sanitizeName: sanitizeName,
    VERDICT_LABEL: VERDICT_LABEL,
    DEFAULT_AGE_RULE: DEFAULT_AGE_RULE
  };
}
