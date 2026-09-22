/**
 * Claude に渡すシステムプロンプトと出力スキーマ。
 * 判定の「重み付け」はここではなく Rules.gs で行う。ここは書類からの事実抽出に徹する。
 */

function buildSystemPrompt() {
  var rule = ageRule();
  return [
    'あなたはパソコンスクールの講師採用における書類スクリーニングの補助を行います。',
    '応募者から届いた履歴書・職務経歴書を読み、以下の3つの観点について「書類に書かれている事実」を抽出し、評価してください。',
    '',
    '## 募集中の求人（すべて Winスクール 京都駅前校 / 業務委託 パソコンスクール講師）',
    jobsAsPromptText(),
    '',
    '## 評価軸',
    '1. 年齢：' + rule.limit + '歳以下であること（' + rule.concernFrom + '歳以上は懸念扱い）。',
    '   生年月日が書かれていれば birthDate に YYYY-MM-DD 形式で入れてください。',
    '   年齢だけが書かれている場合は value に入れてください。どちらも無ければ null のままにしてください。',
    '2. 求人適合：上記3求人のうちどれに当てはまるか。対象ツール・対象分野の経験があるかで判断します。',
    '   - ok：対象ツール（または対象分野そのもの）の経験が書類から明確に読み取れる',
    '   - concern：関連はあるが対象ツールそのものではない（例：対象外のCAD、対象外の言語、周辺業務のみ）',
    '   - ng：3求人のいずれの分野にも当てはまらない',
    '   bestJobId には最も適合する求人のID（cad / web / it）を、該当が無ければ none を入れてください。',
    '   matchedTools には、求人の対象ツール一覧に実際に載っている名称だけを入れてください（勝手に言い換えない）。',
    '   対象一覧に無いが関連する技術は relatedButNotListed に入れてください。',
    '3. 実務経験：軸2で選んだ分野について、業務としての使用経験があるか。年数は問いません。',
    '   - ok：業務・実務として使っていたことが書類から読み取れる（職歴の業務内容など）',
    '   - concern：学習・職業訓練・スクール受講・資格取得のみ、または実務かどうか判別できない',
    '   - ng：その分野の実務経験が無い',
    '   evidence には根拠となる書類中の記述を短く（各50文字以内で）引用してください。',
    '',
    '## 守ってほしいこと',
    '- 書類に書かれていないことを推測で補わないでください。読み取れない場合は不明として扱い、concern（または null）にしてください。',
    '- 講師経験の有無は問いません（求人側が「講師経験不問」のため）。評価に含めないでください。',
    '- 氏名・年齢・経験以外の属性（性別、国籍、家族構成、健康状態、信条など）は評価の根拠にしないでください。',
    '- concerns には、上記3軸以外で採用担当者が知っておくべき懸念点（例：勤務可能日が極端に限られる、空白期間が長い、書類が一部しか無い等）を日本語で簡潔に列挙してください。無ければ空配列。',
    '- summary は採用担当者向けに3〜4文で、誰がどの分野の何をやってきた人かを要約してください。'
  ].join('\n');
}

/** structured outputs 用の JSON スキーマ。 */
function buildOutputSchema() {
  return {
    type: 'object',
    properties: {
      candidate: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '候補者氏名。読み取れなければ空文字。' },
          nameKana: { type: 'string', description: 'ふりがな。無ければ空文字。' },
          documentsFound: {
            type: 'array',
            items: { type: 'string' },
            description: '受領した書類の種類。例: 履歴書, 職務経歴書'
          }
        },
        required: ['name', 'nameKana', 'documentsFound'],
        additionalProperties: false
      },
      age: {
        type: 'object',
        properties: {
          value: {
            anyOf: [{ type: 'integer' }, { type: 'null' }],
            description: '書類に明記された年齢。無ければ null。'
          },
          birthDate: { type: 'string', description: 'YYYY-MM-DD。読み取れなければ空文字。' },
          basis: { type: 'string', description: '年齢・生年月日の根拠（どこに書かれていたか）。' }
        },
        required: ['value', 'birthDate', 'basis'],
        additionalProperties: false
      },
      jobMatch: {
        type: 'object',
        properties: {
          bestJobId: { type: 'string', enum: ['cad', 'web', 'it', 'none'] },
          alsoMatchedJobIds: {
            type: 'array',
            items: { type: 'string', enum: ['cad', 'web', 'it'] },
            description: '他にも当てはまる求人があれば。'
          },
          matchedTools: { type: 'array', items: { type: 'string' } },
          relatedButNotListed: { type: 'array', items: { type: 'string' } },
          rating: { type: 'string', enum: ['ok', 'concern', 'ng'] },
          reason: { type: 'string' }
        },
        required: ['bestJobId', 'alsoMatchedJobIds', 'matchedTools', 'relatedButNotListed', 'rating', 'reason'],
        additionalProperties: false
      },
      practicalExperience: {
        type: 'object',
        properties: {
          hasPractical: { type: 'string', enum: ['yes', 'unclear', 'no'] },
          years: {
            anyOf: [{ type: 'number' }, { type: 'null' }],
            description: '該当分野の実務年数。読み取れなければ null。'
          },
          evidence: { type: 'array', items: { type: 'string' } },
          rating: { type: 'string', enum: ['ok', 'concern', 'ng'] },
          reason: { type: 'string' }
        },
        required: ['hasPractical', 'years', 'evidence', 'rating', 'reason'],
        additionalProperties: false
      },
      concerns: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' }
    },
    required: ['candidate', 'age', 'jobMatch', 'practicalExperience', 'concerns', 'summary'],
    additionalProperties: false
  };
}

/** メール本文などのメタ情報を最後のテキストブロックにまとめる。 */
function buildUserInstruction(mailMeta) {
  return [
    '以下は応募者から届いたメールと添付書類です。評価してください。',
    '',
    '【メール件名】' + (mailMeta.subject || '(なし)'),
    '【差出人】' + (mailMeta.from || '(不明)'),
    '【受信日時】' + (mailMeta.date || '(不明)'),
    '【本日の日付】' + mailMeta.today + '（年齢の計算はこの日付を基準にしてください）',
    '',
    '【メール本文】',
    (mailMeta.body || '(本文なし)').slice(0, 4000)
  ].join('\n');
}
