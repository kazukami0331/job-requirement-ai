/**
 * Claude Messages API クライアント。
 * Apps Script では npm の公式 SDK が使えないため UrlFetchApp で直接 HTTP を叩く。
 */

var ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
var ANTHROPIC_VERSION = '2023-06-01';

/**
 * 書類（PDF/画像のコンテンツブロック）を渡して評価結果 JSON を受け取る。
 * @param {Array} contentBlocks user メッセージの content 配列
 * @return {{result: Object, usage: Object, model: string}}
 */
function evaluateWithClaude(contentBlocks) {
  var payload = {
    model: cfg('ANTHROPIC_MODEL'),
    max_tokens: cfgInt('ANTHROPIC_MAX_TOKENS'),
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: contentBlocks }],
    output_config: {
      effort: cfg('ANTHROPIC_EFFORT'),
      format: {
        type: 'json_schema',
        schema: buildOutputSchema()
      }
    }
  };

  var response = anthropicRequest_(payload);

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude が応答を拒否しました（stop_reason: refusal）。手動で確認してください。');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('出力が max_tokens に達して途中で切れました。ANTHROPIC_MAX_TOKENS を増やしてください。');
  }

  var text = '';
  for (var i = 0; i < (response.content || []).length; i++) {
    if (response.content[i].type === 'text') text += response.content[i].text;
  }
  if (!text) throw new Error('Claude のレスポンスにテキストブロックがありませんでした。');

  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error('Claude の出力を JSON として解釈できませんでした: ' + text.slice(0, 300));
  }

  return { result: parsed, usage: response.usage || {}, model: response.model };
}

/** リトライ付きの API 呼び出し。429 と 5xx、ネットワークエラーのみ再試行する。 */
function anthropicRequest_(payload) {
  var apiKey = requireCfg('ANTHROPIC_API_KEY');
  var maxAttempts = 3;
  var lastError = null;

  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    var httpResponse;
    try {
      httpResponse = UrlFetchApp.fetch(ANTHROPIC_ENDPOINT, {
        method: 'post',
        contentType: 'application/json',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
    } catch (e) {
      // タイムアウトや接続断。Apps Script の UrlFetch は長時間の応答を待てないことがある。
      lastError = new Error('Claude API への接続に失敗しました: ' + e.message);
      Utilities.sleep(backoffMs_(attempt));
      continue;
    }

    var code = httpResponse.getResponseCode();
    var body = httpResponse.getContentText();

    if (code === 200) return JSON.parse(body);

    if (code === 429 || code >= 500) {
      lastError = new Error('Claude API エラー ' + code + ': ' + body.slice(0, 300));
      Utilities.sleep(backoffMs_(attempt));
      continue;
    }

    // 400 系は再試行しても直らない
    throw new Error('Claude API エラー ' + code + ': ' + body.slice(0, 500));
  }

  throw lastError || new Error('Claude API の呼び出しに失敗しました。');
}

function backoffMs_(attempt) {
  return Math.min(16000, 2000 * Math.pow(2, attempt - 1));
}
