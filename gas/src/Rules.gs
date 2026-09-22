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
  var documentName = candidate.name || '';

  // 件名の氏名と書類の氏名が食い違う場合は、添付の取り違えの可能性があるので人が見る。
  var nameMismatch = isNameMismatch(opts.subjectName, documentName);
  if (nameMismatch) {
    concerns.push('【氏名】件名の氏名「' + opts.subjectName + '」と書類の氏名「' + documentName +
      '」が一致しません。添付の取り違えの可能性があります。');
    if (verdict === 'pass') verdict = 'review';
  }

  return {
    verdict: verdict,
    verdictLabel: VERDICT_LABEL[verdict],
    candidate: {
      name: documentName,
      nameKana: candidate.nameKana || '',
      subjectName: opts.subjectName || '',
      nameMismatch: nameMismatch,
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

/**
 * メール件名から候補者氏名を取り出す。
 * 「【応募】山田 太郎」の形を基本に、Fwd:/Re: や括弧の揺れ、全角コロンを吸収する。
 * 想定の形でなければ '' を返す（件名は氏名の"ヒント"であって、確定は書類側で行う）。
 */
function nameFromSubject(subject) {
  var text = String(subject || '').trim();
  // 転送・返信のプレフィックスを剥がす（Fwd: Re: 転送: など、重なっていても対応）
  var prev = null;
  while (prev !== text) {
    prev = text;
    text = text.replace(/^\s*(?:re|fwd?|返信|転送)\s*[:：]\s*/i, '');
  }

  var m = text.match(/[【\[（(]?\s*応募\s*(?:書類)?\s*[】\]）)]?\s*[:：]?\s*(.+)$/);
  if (!m) return '';

  var name = m[1]
    .replace(/[（(].*?[)）]/g, '')                 // 「（CAD講師）」などの補足を落とす
    .replace(/(様|さん|氏)\s*$/, '')
    .replace(/(の件|について|です|の応募)\s*$/, '')
    .trim();

  // メールアドレスや長すぎる文字列は氏名ではないと判断する
  if (!name || name.length > 20 || name.indexOf('@') >= 0) return '';
  return name;
}

/** 氏名の表記ゆれ（空白の有無・全角半角）を吸収して比較する。 */
function normalizeNameForCompare(name) {
  return String(name || '')
    .replace(/[\s　]/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
    })
    .toLowerCase();
}

/** 両方の氏名が取れていて、かつ食い違う場合のみ true。片方でも空なら false。 */
function isNameMismatch(subjectName, documentName) {
  var a = normalizeNameForCompare(subjectName);
  var b = normalizeNameForCompare(documentName);
  if (!a || !b) return false;
  // 旧姓併記や「山田太郎（ヤマダタロウ）」のようにどちらかが含む関係なら一致とみなす
  if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return false;
  return true;
}

var DEFAULT_TRIGGER_TIMES = [{ hour: 8, minute: 30 }, { hour: 17, minute: 0 }];

/**
 * 定期実行の時刻設定（"8:30,17:00"）を解釈する。
 * 解釈できない時刻は読み飛ばして理由を返し、1つも残らなければ既定の時刻に倒す。
 * （設定ミスで定期実行が止まるのが一番まずいため）
 * @return {{times: Array<{hour:number, minute:number}>, warning: string}}
 */
function parseTriggerTimes(configured) {
  var entries = String(configured || '').split(',');
  var times = [];
  var invalid = [];

  for (var i = 0; i < entries.length; i++) {
    var text = entries[i].trim();
    if (!text) continue;

    var m = text.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
    if (!m) { invalid.push(text); continue; }

    var hour = Number(m[1]);
    var minute = m[2] === undefined ? 0 : Number(m[2]);
    if (hour > 23 || minute > 59) { invalid.push(text); continue; }

    times.push({ hour: hour, minute: minute });
  }

  var warning = invalid.length
    ? 'TRIGGER_TIMES に解釈できない時刻がありました: ' + invalid.join(', ') + '（"8:30,17:00" の形式で指定してください）'
    : '';

  if (!times.length) {
    return {
      times: DEFAULT_TRIGGER_TIMES.slice(),
      warning: (warning ? warning + ' / ' : '') + '有効な時刻が無いため既定の 8:30 と 17:00 で登録します。'
    };
  }
  return { times: times, warning: warning };
}

/** 8:30 のような表示用文字列にする。 */
function formatTriggerTime(time) {
  return time.hour + ':' + (time.minute < 10 ? '0' : '') + time.minute;
}

/**
 * Google ドライブのフォルダURLからフォルダIDを取り出す。
 * ID をそのまま渡された場合はそれを返す。取り出せなければ null。
 */
function folderIdFromUrl(urlOrId) {
  var text = String(urlOrId || '').trim();
  if (!text) return null;

  var m = text.match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];

  // URL ではなく ID をそのまま渡された場合
  if (/^[A-Za-z0-9_-]{15,}$/.test(text)) return text;
  return null;
}

/**
 * 実際に使う通知先を決める。
 * Slack を指定していても Webhook が未設定だと通知が消えてしまうため、その場合はメールに倒す。
 * どこにも送れない設定になった場合もメールに倒す（黙って通知が消えるのが一番まずい）。
 * @return {{channels: string[], warning: string}}
 */
function resolveNotifyChannels(configured, hasSlackWebhook) {
  var channels = (configured || []).filter(function (c) {
    return c === 'email' || c === 'slack';
  });

  if (channels.indexOf('slack') >= 0 && !hasSlackWebhook) {
    channels = channels.filter(function (c) { return c !== 'slack'; });
    if (channels.indexOf('email') < 0) channels.push('email');
    return {
      channels: channels,
      warning: 'SLACK_WEBHOOK_URL が未設定のため、Slack ではなくメールで通知します。'
    };
  }

  if (!channels.length) {
    return {
      channels: ['email'],
      warning: 'NOTIFY_VIA の指定が不正です（email / slack のみ有効）。メールで通知します。'
    };
  }

  return { channels: channels, warning: '' };
}

/**
 * モデルごとの料金（100万トークンあたりのUSD）。
 * https://platform.claude.com/ の公開価格に合わせて更新する。
 */
var MODEL_PRICES = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 }
};

/**
 * 1回の判定にかかったおおよそのコストを出す。
 * 未知のモデルは料金が分からないので null を返す（勝手に推測しない）。
 * @return {{usd: number, jpy: number}|null}
 */
function estimateCost(model, usage, usdJpy) {
  var price = MODEL_PRICES[model];
  if (!price || !usage) return null;

  var input = (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0);
  var output = usage.output_tokens || 0;
  if (!input && !output) return null;

  var usd = (input / 1000000) * price.input + (output / 1000000) * price.output;
  return { usd: usd, jpy: usd * (usdJpy || 150) };
}

/** 検証ログ用に、モデル・トークン数・概算コストを1行にまとめる。 */
function formatUsage(model, usage, usdJpy) {
  var u = usage || {};
  var parts = ['モデル: ' + (model || '不明')];
  parts.push('入力 ' + (u.input_tokens || 0) + 'トークン');
  parts.push('出力 ' + (u.output_tokens || 0) + 'トークン');

  var cost = estimateCost(model, usage, usdJpy);
  if (cost) {
    parts.push('概算 $' + cost.usd.toFixed(4) + '（約' + Math.round(cost.jpy * 10) / 10 + '円）');
  }
  return parts.join(' / ');
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
    nameFromSubject: nameFromSubject,
    normalizeNameForCompare: normalizeNameForCompare,
    isNameMismatch: isNameMismatch,
    parseTriggerTimes: parseTriggerTimes,
    formatTriggerTime: formatTriggerTime,
    folderIdFromUrl: folderIdFromUrl,
    resolveNotifyChannels: resolveNotifyChannels,
    estimateCost: estimateCost,
    formatUsage: formatUsage,
    MODEL_PRICES: MODEL_PRICES,
    sanitizeName: sanitizeName,
    VERDICT_LABEL: VERDICT_LABEL,
    DEFAULT_AGE_RULE: DEFAULT_AGE_RULE
  };
}
