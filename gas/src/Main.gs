/**
 * エントリーポイント。
 *
 *   setup()          初回のみ。フォルダ・台帳・ラベルを作り、スクリプトプロパティに書き込む。
 *   installTrigger() 定期実行（15分ごと）を登録する。
 *   run()            メール1通ずつ処理する本体。トリガーから呼ばれる。
 *   removeTriggers() 定期実行を止める。
 */

function run() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    log_('別の実行が進行中のためスキップしました。');
    return;
  }
  try {
    processInbox_();
  } finally {
    lock.releaseLock();
  }
}

function processInbox_() {
  var query = cfg('GMAIL_QUERY');
  var maxMessages = cfgInt('MAX_MESSAGES');
  var threads = GmailApp.search(query, 0, Math.max(maxMessages, 1));
  if (!threads.length) {
    log_('対象メールはありませんでした。query=' + query);
    return;
  }

  var processed = processedMessageIds();
  var doneLabel = getOrCreateLabel_(cfg('LABEL_DONE'));
  var errorLabel = getOrCreateLabel_(cfg('LABEL_ERROR'));
  var inboxLabel = getOrCreateLabel_(cfg('LABEL_INBOX'));
  var count = 0;

  for (var t = 0; t < threads.length && count < maxMessages; t++) {
    var thread = threads[t];
    var pending = thread.getMessages().filter(function (message) {
      return !processed[message.getId()] && message.getAttachments().length > 0;
    });

    // スレッドの途中で上限に達すると、残りのメールが未処理のまま done ラベルが付いてしまう。
    // 1スレッドは丸ごと処理できるときだけ着手し、無理なら次回の実行に回す。
    // ただし1スレッド単体が上限より大きい場合は、先送りし続けると永久に処理されないので着手する。
    if (pending.length > maxMessages - count && count > 0) {
      log_('今回の残り処理枠に収まらないため次回に回します: ' + thread.getFirstMessageSubject());
      continue;
    }

    var threadHadError = false;
    for (var m = 0; m < pending.length; m++) {
      var message = pending[m];
      count++;
      try {
        processMessage_(message, thread);
      } catch (e) {
        threadHadError = true;
        log_('処理に失敗しました: ' + message.getSubject() + ' / ' + e.message + '\n' + (e.stack || ''));
        handleFailure_(message, thread, e);
      }
    }

    if (cfgBool('DRY_RUN')) continue;
    thread.removeLabel(inboxLabel);
    thread.addLabel(threadHadError ? errorLabel : doneLabel);
  }
  log_(count + '件のメールを処理しました。');
}

function processMessage_(message, thread) {
  var receivedAt = message.getDate();
  var subject = message.getSubject();
  // 件名は「【応募】氏名」の運用だが、その通りに来ないことがある。
  // 取れたら氏名のヒントとして使い、取れなくても処理は続ける。
  var subjectName = nameFromSubject(subject);
  var mailMeta = {
    subject: subject,
    subjectName: subjectName,
    from: message.getFrom(),
    date: Utilities.formatDate(receivedAt, timezone_(), 'yyyy-MM-dd HH:mm'),
    today: Utilities.formatDate(new Date(), timezone_(), 'yyyy-MM-dd'),
    body: message.getPlainBody()
  };

  var attachments = collectAttachments(message);
  if (!attachments.length) {
    throw new Error('判定に使える添付ファイルがありませんでした（PDF / Word / Excel / 画像 / ZIP に対応）。');
  }

  var prepared = buildContentBlocks(attachments, mailMeta);
  if (prepared.blocks.length <= 1) {
    throw new Error('添付ファイルを Claude に渡せる形式に変換できませんでした: ' + prepared.skipped.join(', '));
  }

  var evaluated = evaluateWithClaude(prepared.blocks);
  var assessment = buildAssessment(evaluated.result, {
    today: new Date(),
    ageRule: ageRule(),
    subjectName: subjectName
  });

  // フォルダ名は 書類の氏名 → 件名の氏名 → 差出人名 の順で使う
  var folderName = assessment.candidate.name || subjectName || senderDisplayName_(mailMeta.from);
  var stored = saveCandidateFiles(folderName, attachments, receivedAt);

  var entry = {
    messageId: message.getId(),
    assessment: assessment,
    folderUrl: stored.url,
    savedFileNames: stored.savedFileNames,
    skipped: prepared.skipped,
    subject: mailMeta.subject,
    from: mailMeta.from,
    threadUrl: thread.getPermalink(),
    usage: evaluated.usage,
    model: evaluated.model
  };

  saveAssessmentJson(stored.folder, {
    assessment: assessment,
    raw: evaluated.result,
    mail: { subject: mailMeta.subject, from: mailMeta.from, date: mailMeta.date, messageId: entry.messageId },
    model: evaluated.model,
    usage: evaluated.usage,
    evaluatedAt: new Date().toISOString()
  });

  appendLedgerRow(entry);
  notifyAssessment(entry);
  log_('判定完了: ' + assessment.verdictLabel + ' / ' + (assessment.candidate.name || '(氏名不明)'));
}

function handleFailure_(message, thread, error) {
  var entry = {
    messageId: message.getId(),
    candidateName: nameFromSubject(message.getSubject()) || senderDisplayName_(message.getFrom()),
    error: error.message,
    subject: message.getSubject(),
    from: message.getFrom(),
    threadUrl: thread.getPermalink()
  };
  try {
    appendErrorRow(entry);
  } catch (e) {
    log_('台帳へのエラー記録に失敗: ' + e.message);
  }
  notifyError(entry);
}

/** "山田 太郎 <taro@example.com>" -> "山田 太郎" */
function senderDisplayName_(from) {
  var m = String(from || '').match(/^\s*"?([^"<]*?)"?\s*</);
  if (m && m[1].trim()) return m[1].trim();
  var addr = String(from || '').replace(/[<>]/g, '').trim();
  return addr.split('@')[0] || '氏名不明';
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function log_(message) {
  console.log(message);
}
