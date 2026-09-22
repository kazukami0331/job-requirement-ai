/**
 * エントリーポイント。
 *
 *   setup()          初回のみ。フォルダ・台帳・ラベルを作り、スクリプトプロパティに書き込む。
 *   preview(query)   検証用。1通だけ判定して結果をログに出す。保存も通知もしない。
 *   installTrigger() 定期実行（15分ごと）を登録する。
 *   run()            メール1通ずつ処理する本体。トリガーから呼ばれる。
 *   removeTriggers() 定期実行を止める。
 */

/**
 * 検証用。条件に合う最新のメール1通だけを判定し、結果を実行ログに出す。
 * Drive への保存・台帳への記録・メール通知・ラベル付けは一切行わないので、
 * 同じメールで何度でも試せる。
 *
 * 使い方（Apps Script エディタで関数を選んで実行）:
 *   preview()                                  … GMAIL_QUERY の条件で最新1通
 *   preview('from:me has:attachment')          … 自分宛に送ったテストメール
 *   preview('subject:【応募】 has:attachment')  … 件名で絞る
 */
function preview(query) {
  var q = query || cfg('GMAIL_QUERY');
  var threads = GmailApp.search(q, 0, 10);

  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = messages.length - 1; m >= 0; m--) {
      if (!messages[m].getAttachments().length) continue;

      log_('対象メール: ' + messages[m].getSubject() + ' / ' + messages[m].getFrom());
      try {
        processMessage_(messages[m], threads[t], true);
      } catch (e) {
        log_('判定できませんでした: ' + e.message + '\n' + (e.stack || ''));
      }
      return;
    }
  }
  log_('添付つきのメールが見つかりませんでした。query=' + q);
}

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
  var dryRun = cfgBool('DRY_RUN');
  var query = cfg('GMAIL_QUERY');
  var maxMessages = cfgInt('MAX_MESSAGES');
  var threads = GmailApp.search(query, 0, Math.max(maxMessages, 1));
  if (!threads.length) {
    log_('対象メールはありませんでした。query=' + query);
    return;
  }

  // DRY_RUN では台帳に書き込まないので、同じメールを何度でも試せる
  var processed = dryRun ? {} : processedMessageIds();
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
        processMessage_(message, thread, dryRun);
      } catch (e) {
        threadHadError = true;
        log_('処理に失敗しました: ' + message.getSubject() + ' / ' + e.message + '\n' + (e.stack || ''));
        handleFailure_(message, thread, e, dryRun);
      }
    }

    if (dryRun) continue;
    thread.removeLabel(inboxLabel);
    thread.addLabel(threadHadError ? errorLabel : doneLabel);
  }
  log_(count + '件のメールを処理しました。');
}

/**
 * メール1通を判定する。
 * dryRun のときは Drive 保存・台帳記録・通知を一切行わず、結果をログに出すだけ。
 * 何度でも同じメールで試せるので、本番運用前の検証に使う。
 */
function processMessage_(message, thread, dryRun) {
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

  var entry = {
    messageId: message.getId(),
    assessment: assessment,
    folderUrl: '',
    savedFileNames: [],
    skipped: prepared.skipped,
    subject: mailMeta.subject,
    from: mailMeta.from,
    threadUrl: thread.getPermalink(),
    usage: evaluated.usage,
    model: evaluated.model
  };

  if (dryRun) {
    entry.folderUrl = '(DRY_RUN のため保存していません)';
    entry.savedFileNames = attachments.map(function (item) { return item.name; });
    log_('[DRY_RUN] 判定結果 ────────────────\n' + buildNotificationBody(entry));
    return;
  }

  // フォルダ名は 書類の氏名 → 件名の氏名 → 差出人名 の順で使う
  var folderName = assessment.candidate.name || subjectName || senderDisplayName_(mailMeta.from);
  var stored = saveCandidateFiles(folderName, attachments, receivedAt);
  entry.folderUrl = stored.url;
  entry.savedFileNames = stored.savedFileNames;

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

function handleFailure_(message, thread, error, dryRun) {
  var entry = {
    messageId: message.getId(),
    candidateName: nameFromSubject(message.getSubject()) || senderDisplayName_(message.getFrom()),
    error: error.message,
    subject: message.getSubject(),
    from: message.getFrom(),
    threadUrl: thread.getPermalink()
  };
  if (dryRun) {
    log_('[DRY_RUN] 判定不可として通知される内容:\n' + entry.subject + ' / ' + entry.error);
    return;
  }
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
