/**
 * 評価結果の通知。書類そのものは添付せず、Drive のリンクと判定だけを送る。
 */

function notifyAssessment(entry) {
  var a = entry.assessment;
  if (cfgList('NOTIFY_VERDICTS').indexOf(a.verdict) < 0) {
    log_('通知対象外の判定のためスキップ: ' + a.verdictLabel + ' / ' + a.candidate.name);
    return;
  }

  var subject = '【' + a.verdictLabel + '】' + (a.candidate.name || a.candidate.subjectName || '氏名不明') +
    '（' + a.jobName + '）' + (a.axes.age.age === null ? '' : ' / ' + a.axes.age.age + '歳');
  var body = buildNotificationBody(entry);

  if (cfgBool('DRY_RUN')) {
    log_('[DRY_RUN] メール送信をスキップ\n件名: ' + subject + '\n' + body);
    return;
  }

  var channels = cfgList('NOTIFY_VIA');
  if (channels.indexOf('email') >= 0) {
    MailApp.sendEmail({ to: notifyEmail(), subject: subject, body: body });
  }
  if (channels.indexOf('slack') >= 0) {
    postToSlack_(buildSlackBlocks(entry), subject);
  }
}

/** 判定ごとの絵文字。Slack で一覧したときに色で区別できるようにする。 */
var VERDICT_EMOJI = {
  pass: ':white_check_mark:',
  review: ':warning:',
  fail: ':x:',
  unknown: ':grey_question:'
};

/**
 * Slack 用のメッセージ（Block Kit）を組み立てる。
 * メール本文をそのまま貼るとチャンネルで読みにくいので、要点だけを構造化する。
 */
function buildSlackBlocks(entry) {
  var a = entry.assessment;
  var name = a.candidate.name || a.candidate.subjectName || '氏名不明';
  var age = a.axes.age.age === null ? '不明' : a.axes.age.age + '歳';

  var blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: a.verdictLabel + '：' + name, emoji: true }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*判定*\n' + VERDICT_EMOJI[a.verdict] + ' ' + a.verdictLabel },
        { type: 'mrkdwn', text: '*想定求人*\n' + a.jobName },
        { type: 'mrkdwn', text: '*年齢*\n' + age },
        {
          type: 'mrkdwn',
          text: '*評価軸*\n年齢 ' + ratingSymbol(a.axes.age.rating) +
            '　適合 ' + ratingSymbol(a.axes.jobMatch.rating) +
            '　経験 ' + ratingSymbol(a.axes.experience.rating)
        }
      ]
    }
  ];

  if (a.summary) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*経歴サマリ*\n' + a.summary }
    });
  }

  if (a.concerns.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*懸念点*\n・' + a.concerns.join('\n・') }
    });
  }

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: '<' + entry.folderUrl + '|📁 書類を見る（Google ドライブ）>' }
  });

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: '件名: ' + entry.subject + '　|　<' + entry.threadUrl + '|元メール>' +
        '　|　この判定は書類の記載のみに基づく AI の一次判定です'
    }]
  });

  return blocks;
}

function buildNotificationBody(entry) {
  var a = entry.assessment;
  var lines = [];

  lines.push('■ 総合判定：' + a.verdictLabel);
  lines.push('■ 候補者：' + (a.candidate.name || a.candidate.subjectName || '(氏名を読み取れませんでした)') +
    (a.candidate.nameKana ? '（' + a.candidate.nameKana + '）' : '') +
    (a.candidate.nameMismatch ? '　※件名は「' + a.candidate.subjectName + '」' : ''));
  lines.push('■ 想定求人：' + a.jobName);
  lines.push('');
  lines.push('── 評価軸 ──────────────');
  lines.push(ratingSymbol(a.axes.age.rating) + ' 年齢　　：' + a.axes.age.reason);
  lines.push(ratingSymbol(a.axes.jobMatch.rating) + ' 求人適合：' + (a.axes.jobMatch.reason || '－'));
  if (a.axes.jobMatch.matchedTools.length) {
    lines.push('　　　　　 該当ツール：' + a.axes.jobMatch.matchedTools.join(' / '));
  }
  if (a.axes.jobMatch.relatedButNotListed.length) {
    lines.push('　　　　　 関連スキル：' + a.axes.jobMatch.relatedButNotListed.join(' / '));
  }
  lines.push(ratingSymbol(a.axes.experience.rating) + ' 実務経験：' + (a.axes.experience.reason || '－') +
    (a.axes.experience.years === null ? '' : '（約' + a.axes.experience.years + '年）'));
  for (var i = 0; i < a.axes.experience.evidence.length; i++) {
    lines.push('　　　　　 根拠：' + a.axes.experience.evidence[i]);
  }
  lines.push('');

  if (a.concerns.length) {
    lines.push('── 懸念点 ──────────────');
    for (var j = 0; j < a.concerns.length; j++) {
      lines.push('・' + a.concerns[j]);
    }
    lines.push('');
  }

  if (a.summary) {
    lines.push('── 経歴サマリ ──────────');
    lines.push(a.summary);
    lines.push('');
  }

  if (entry.skipped && entry.skipped.length) {
    lines.push('── 判定に使えなかった添付 ──');
    for (var k = 0; k < entry.skipped.length; k++) {
      lines.push('・' + entry.skipped[k]);
    }
    lines.push('');
  }

  lines.push('── 書類 ────────────────');
  lines.push('Drive: ' + entry.folderUrl);
  lines.push('保存ファイル: ' + (entry.savedFileNames || []).join(' / '));
  lines.push('');
  lines.push('── 元メール ────────────');
  lines.push('件名: ' + entry.subject);
  lines.push('差出人: ' + entry.from);
  lines.push('スレッド: ' + entry.threadUrl);
  lines.push('');
  lines.push('※ この判定は書類の記載のみに基づく AI の一次判定です。最終判断は人が行ってください。');

  return lines.join('\n');
}

/** 判定まで到達できなかった場合の通知。 */
function notifyError(entry) {
  var subject = '【判定不可】' + (entry.candidateName || '氏名不明') + ' の書類判定に失敗しました';
  var body = [
    '書類の自動判定に失敗しました。手動で確認してください。',
    '',
    'エラー: ' + entry.error,
    '件名: ' + entry.subject,
    '差出人: ' + entry.from,
    'スレッド: ' + entry.threadUrl,
    entry.folderUrl ? 'Drive: ' + entry.folderUrl : '（Drive への保存前に失敗しました）'
  ].join('\n');

  if (cfgBool('DRY_RUN')) {
    log_('[DRY_RUN] エラー通知をスキップ\n' + subject + '\n' + body);
    return;
  }

  var channels = cfgList('NOTIFY_VIA');
  if (channels.indexOf('email') >= 0) {
    MailApp.sendEmail({ to: notifyEmail(), subject: subject, body: body });
  }
  if (channels.indexOf('slack') >= 0) {
    postToSlack_([
      {
        type: 'header',
        text: { type: 'plain_text', text: '判定不可：' + (entry.candidateName || '氏名不明'), emoji: true }
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: ':grey_question: 自動判定に失敗しました。手動で確認してください。\n```' + entry.error + '```' }
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: '件名: ' + entry.subject + '　|　<' + entry.threadUrl + '|元メール>'
        }]
      }
    ], subject);
  }
}

/**
 * Slack の Incoming Webhook に投稿する。
 * 投稿先チャンネルは Webhook 作成時に決まるので、ここでは指定しない。
 * @param {Array} blocks Block Kit のブロック配列
 * @param {string} fallbackText 通知バナーや未対応クライアント向けのテキスト
 */
function postToSlack_(blocks, fallbackText) {
  var url = cfg('SLACK_WEBHOOK_URL');
  if (!url) return;

  try {
    var response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ text: fallbackText, blocks: blocks }),
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) {
      log_('Slack への通知に失敗: ' + response.getResponseCode() + ' ' + response.getContentText());
    }
  } catch (e) {
    log_('Slack への通知に失敗: ' + e.message);
  }
}
