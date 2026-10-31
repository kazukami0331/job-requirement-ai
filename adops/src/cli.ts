#!/usr/bin/env node
/**
 * adops CLI
 *
 *   node src/cli.ts cycle                 1サイクル全部（毎日の定期実行はこれ）
 *   node src/cli.ts cycle --steps plan,produce
 *   node src/cli.ts plan                  企画とレビューだけ
 *   node src/cli.ts produce               制作待ちの画像生成・合成・動画化
 *   node src/cli.ts publish               制作済みを入稿
 *   node src/cli.ts collect               実績の取り込み
 *   node src/cli.ts optimize              停止・予算判断
 *   node src/cli.ts report                レポート再生成
 *   node src/cli.ts status                現在の状態を一覧
 *   node src/cli.ts lp                    応募ページ（LP）の下書きを作る（policy.json の lp.enabled が true のとき）
 *   node src/cli.ts lp-approve --id <ID>  LP の下書きを承認して公開する（lp-retire で公開を終了）
 *   node src/cli.ts export                広告ごとの要素×採点×結果（exports/creatives.csv）と Google 検索広告のテキスト（exports/google-rsa.csv）を書き出す
 *   node src/cli.ts check [--live]        設定の確認（--live で各サービスに読み取りの接続テスト）
 *   node src/cli.ts simulate --days 14    架空の配信データで改善ループを試す（媒体・API キー不要）
 *   node src/cli.ts add-job --file 求人票.txt [--write]  求人票から jobs.json に1件追加
 *   node src/cli.ts emergency-stop [--reason ...]  adops が入稿した広告をすべて停止し、以後の入稿も止める
 *   node src/cli.ts resume                緊急停止を解除
 *   node src/cli.ts leads                 インスタントフォームの新しい応募を Slack に通知
 *
 * 共通オプション: --offline（Claude を呼ばずテンプレートで動かす） --today YYYY-MM-DD
 */
import { loadCatalog, loadDotEnv, loadSettings, isGoogleConfigured, isMetaConfigured, placeholderProblems } from './config.ts';
import { ClaudeLlm, type Llm } from './llm/llm.ts';
import { offlineLlm } from './llm/offline.ts';
import { createImageProvider } from './creative/imageProvider.ts';
import { StateStore } from './store/stateStore.ts';
import { makeCtx, platformClients, type Ctx } from './pipeline/context.ts';
import { ALL_STEPS, runCycle, type StepName } from './pipeline/cycle.ts';
import { ffmpegAvailable } from './creative/video.ts';
import { writeReport } from './report/html.ts';
import { exportAll } from './pipeline/exports.ts';
import { approveLp, lpUrl, retireLp } from './pipeline/lp.ts';
import { ANGLE_LABELS } from './types.ts';
import { lastNDays, totals } from './optimize/stats.ts';
import { jstDate, newId } from './util/id.ts';
import { simulate } from './sim/simulate.ts';
import { monthApplications } from './optimize/allocate.ts';
import { liveChecks } from './doctor.ts';
import { importJob } from './agents/jobImporter.ts';
import { emergencyStop } from './pipeline/emergency.ts';
import { notifyLeads } from './pipeline/leads.ts';
import { monthlySpend } from './pipeline/optimize.ts';
import { fetchPage } from './pipeline/landing.ts';
import { notifySlack } from './notify/slack.ts';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function parseArgs(argv: string[]) {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else flags[key] = true;
  }
  return { command, flags };
}

/**
 * API キーが無いまま本番（DRY RUN でない）で動いた場合は、AI のレビュー・画像チェックを通らない広告を出さないよう、
 * 実績の取り込み・停止判断・報告だけにする（オフラインのテンプレートは常に合格を返すため）。
 */
function safeSteps(ctx: Ctx, flags: Record<string, string | boolean>, steps: StepName[]): StepName[] {
  if (flags.offline || ctx.dryRun || ctx.settings.anthropic.apiKey) return steps;
  const safe = steps.filter((s) => ['collect', 'optimize', 'report'].includes(s));
  console.error(`!! ANTHROPIC_API_KEY が無いため、企画・制作・入稿・投稿をしません（実行する段階: ${safe.join(',') || 'なし'}）`);
  return safe;
}

function buildCtx(flags: Record<string, string | boolean>): Ctx {
  loadDotEnv();
  const settings = loadSettings();
  const catalog = loadCatalog(settings.configDir);
  const offline = Boolean(flags.offline) || !settings.anthropic.apiKey;
  if (offline && !flags.offline) console.warn('ANTHROPIC_API_KEY が未設定のため、オフライン（テンプレート）モードで動かします。');
  const llm: Llm = offline ? offlineLlm(catalog) : new ClaudeLlm(settings.anthropic);
  const store = new StateStore(settings.dataDir);
  const { meta, google } = platformClients(settings);
  // 1日の AI 費用の上限（既定は1回の上限の3倍）。1日に何度実行しても膨らまないように
  if (llm instanceof ClaudeLlm) {
    const today = typeof flags.today === 'string' ? flags.today : jstDate();
    const daily = Number(process.env.ADOPS_MAX_LLM_USD_DAILY || settings.anthropic.maxUsdPerRun * 3);
    const used = store.state.llmUsage.filter((u) => u.date === today).reduce((a, u) => a + u.costUsd, 0);
    llm.limitTo(daily - used);
  }
  return makeCtx({
    settings,
    catalog,
    store,
    llm,
    images: createImageProvider(settings),
    meta,
    google,
    dryRun: settings.dryRun,
    checkPage: process.env.ADOPS_LP_CHECK === 'false' ? undefined : fetchPage,
    cycleId: newId('cy'),
    today: typeof flags.today === 'string' ? flags.today : undefined,
  });
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const single: Record<string, StepName[]> = {
    plan: ['plan', 'report'],
    produce: ['produce', 'report'],
    publish: ['publish', 'report'],
    collect: ['collect', 'report'],
    optimize: ['collect', 'optimize', 'report'],
    analyze: ['collect', 'analyze', 'report'],
    lp: ['lp', 'report'],
  };

  switch (command) {
    case 'cycle': {
      const ctx = buildCtx(flags);
      const steps = safeSteps(ctx, flags, typeof flags.steps === 'string' ? (flags.steps.split(',') as StepName[]) : ALL_STEPS);
      const rec = await runCycle(ctx, steps);
      process.exitCode = rec.steps.every((s) => s.ok) ? 0 : 1;
      break;
    }
    case 'plan':
    case 'produce':
    case 'publish':
    case 'collect':
    case 'optimize':
    case 'lp':
    case 'analyze': {
      const ctx = buildCtx(flags);
      const rec = await runCycle(ctx, safeSteps(ctx, flags, single[command]));
      process.exitCode = rec.steps.every((s) => s.ok) ? 0 : 1;
      break;
    }
    case 'report': {
      const ctx = buildCtx(flags);
      console.log(writeReport(ctx.store.state, ctx.catalog, ctx.store.dir, ctx.today));
      break;
    }
    case 'lp-approve':
    case 'lp-retire': {
      // node src/cli.ts lp-approve --id factory-aichi-1a2b3c（カンマ区切りで複数可）
      const ctx = buildCtx({ ...flags, offline: true });
      const ids = String(flags.id ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!ids.length) throw new Error('--id で LP の ID を指定してください（Slack の日次サマリや status に出ます）');
      const msgs: string[] = [];
      // 1件の失敗で他の結果（書き出したファイル）と状態が食い違わないよう、1件ずつ処理して必ず保存する
      for (const id of ids) {
        try {
          msgs.push(command === 'lp-approve' ? approveLp(ctx, id) : retireLp(ctx, id));
        } catch (e) {
          msgs.push(`:x: ${(e as Error).message}`);
          process.exitCode = 1;
        }
      }
      ctx.store.save();
      console.log(msgs.join('\n'));
      await notifySlack(ctx.settings.slack.webhookUrl, { text: `:page_facing_up: ${msgs.join('\n')}` });
      break;
    }
    case 'export': {
      // --no-google-text で検索広告テキストの作成（AI 費用がかかる）をせずに表だけ出す
      const ctx = buildCtx(flags);
      console.log(await exportAll(ctx, { googleText: !flags['no-google-text'] }));
      ctx.store.save();
      break;
    }
    case 'status': {
      const ctx = buildCtx(flags);
      const cs = ctx.store.creatives();
      const by = new Map<string, number>();
      for (const c of cs) by.set(c.status, (by.get(c.status) ?? 0) + 1);
      if (ctx.store.state.halted) console.log(`!! 緊急停止中（${ctx.store.state.halted.at} ${ctx.store.state.halted.reason}）。解除: node src/cli.ts resume`);
      console.log(`クリエイティブ ${cs.length} 本: ${[...by].map(([k, v]) => `${k}=${v}`).join(' ')}`);
      const rsa = Object.values(ctx.store.state.searchAds ?? {});
      if (rsa.length) console.log(`検索広告 ${rsa.length} 本: ${['live', 'draft', 'paused', 'failed'].map((st) => `${st}=${rsa.filter((a) => a.status === st).length}`).join(' ')}`);
      const spend = monthlySpend(ctx);
      if (spend) console.log(`今月の広告費 ${Math.round(spend.spent).toLocaleString()}円 / 上限 ${spend.cap.toLocaleString()}円（${Math.round((spend.spent / spend.cap) * 100)}%）`);
      for (const a of ctx.store.state.credentials?.alerts ?? []) console.log(`!! ${a}`);
      // 求人ごと: 応募ページの状態と今月の応募目標の進み具合
      for (const j of ctx.catalog.jobs.filter((x) => x.active)) {
        const lp = ctx.store.state.landing?.[j.id];
        const month = monthApplications(j.id, cs, rsa, ctx.today);
        console.log(
          `求人 ${j.id}: 今月の応募 ${month}${j.monthlyApplicationTarget ? `/${j.monthlyApplicationTarget}` : ''} 件 / 応募ページ ${lp ? (lp.ok === false ? `異常（${lp.note}）` : lp.ok ? '正常' : '判定不能') : '未確認'}`,
        );
      }
      for (const l of Object.values(ctx.store.state.lps ?? {}).filter((x) => x.status === 'draft' || x.status === 'live')) {
        console.log(`LP ${l.id}: ${l.status === 'live' ? `公開中 ${lpUrl(l.id)}` : `下書き（承認: node src/cli.ts lp-approve --id ${l.id}）`} / ${l.jobId} / ${l.personaId}${l.hypothesisId ? ` / ${l.hypothesisId}` : ''}`);
      }
      const last = ctx.store.state.cycles.at(-1);
      if (last) console.log(`前回の実行 ${last.startedAt}: ${last.steps.map((s) => `${s.name}=${s.ok ? 'ok' : 'NG'}`).join(' ')} / AI費用 $${last.llmCostUsd}`);
      for (const c of cs.filter((c) => ['published', 'produced', 'awaiting_images', 'planned'].includes(c.status))) {
        const b = ctx.store.state.briefs[c.briefId];
        const t = totals(lastNDays(c.metrics, ctx.today, 7));
        console.log(
          `${c.id}  ${c.status.padEnd(15)} ${ANGLE_LABELS[c.angle].padEnd(8)} ${c.format.padEnd(5)} imp=${t.impressions} ctr=${t.ctr.toFixed(2)}% cv=${t.conversions}  ${b?.overlay.main ?? ''}`,
        );
      }
      break;
    }
    case 'check': {
      loadDotEnv();
      const s = loadSettings();
      const ok = (b: boolean) => (b ? 'OK ' : '-- ');
      let catalogOk = true;
      try {
        const c = loadCatalog(s.configDir);
        console.log(`${ok(true)}設定ファイル: 求人 ${c.jobs.length} / ペルソナ ${c.personas.length} / モード ${c.policy.autonomy}`);
        for (const p of placeholderProblems(c)) console.log(`NG サンプル設定: ${p}（このままでは入稿しません）`);
        for (const j of c.jobs.filter((j) => j.active)) {
          const m = j.placements.meta?.adsetIds?.length ?? 0;
          const g = (j.placements.google?.adGroupIds?.length ?? 0) + (j.placements.google?.assetGroupIds?.length ?? 0);
          console.log(`    ${j.id}: Meta 広告セット ${m} / Google 入稿先 ${g}`);
        }
      } catch (e) {
        catalogOk = false;
        console.log(`NG 設定ファイル: ${(e as Error).message}`);
      }
      console.log(`${ok(Boolean(s.anthropic.apiKey))}Claude: ${s.anthropic.apiKey ? s.anthropic.model : '未設定（オフラインで動作）'}`);
      console.log(`${ok(s.image.provider !== 'mock')}画像生成: ${s.image.provider}`);
      console.log(`${ok(isMetaConfigured(s))}Meta: ${isMetaConfigured(s) ? `act_${s.meta.adAccountId} (${s.meta.apiVersion})` : '未設定'}`);
      console.log(`${ok(isGoogleConfigured(s))}Google 広告: ${isGoogleConfigured(s) ? `${s.google.customerId} (${s.google.apiVersion})` : '未設定'}`);
      console.log(`${ok(Boolean(s.slack.webhookUrl))}Slack: ${s.slack.webhookUrl ? '設定済み' : '未設定（標準出力のみ）'}`);
      console.log(`${ok(await ffmpegAvailable())}ffmpeg`);
      console.log(`${ok(Boolean(s.fontPath))}日本語フォント: ${s.fontPath || '見つかりません（fonts-noto-cjk を入れてください）'}`);
      console.log(`${s.dryRun ? '-- DRY RUN（媒体への書き込みなし）' : 'OK 本番モード（媒体に書き込みます）'}`);
      if (flags.live && catalogOk) {
        console.log('\n接続テスト（読み取りのみ）');
        const results = await liveChecks(s, loadCatalog(s.configDir));
        for (const r of results) console.log(`${r.ok === null ? '-- ' : r.ok ? 'OK ' : 'NG '}${r.name}: ${r.detail}`);
        if (results.some((r) => r.ok === false)) process.exitCode = 1;
      } else if (!flags.live) console.log('\n（--live を付けると各サービスに読み取りだけの接続テストをします）');
      if (!catalogOk) process.exitCode = 1;
      break;
    }
    case 'emergency-stop': {
      const ctx = buildCtx({ ...flags, offline: true });
      const r = await emergencyStop(ctx, typeof flags.reason === 'string' ? flags.reason : '緊急停止（手動）');
      console.log(`停止 ${r.paused} 件${r.errors.length ? ` / 失敗 ${r.errors.length} 件:\n${r.errors.join('\n')}` : ''}`);
      await notifySlack(ctx.settings.slack.webhookUrl, {
        text: `:octagonal_sign: *adops 緊急停止* ${r.paused} 件の広告を停止しました${r.errors.length ? `（失敗 ${r.errors.length} 件。管理画面で確認してください）` : ''}`,
      });
      process.exitCode = r.errors.length ? 1 : 0;
      break;
    }
    case 'leads': {
      // インスタントフォームの新しい応募を Slack に通知するだけ（1時間おきの軽い定期実行用）
      const ctx = buildCtx({ ...flags, offline: true });
      console.log(await notifyLeads(ctx, new Date(), join(ctx.settings.dataDir, 'leads-cursor.json')));
      // 状態は読むだけ（毎時の実行は状態を保存しない）
      break;
    }
    case 'resume': {
      const ctx = buildCtx({ ...flags, offline: true });
      const was = ctx.store.state.halted;
      delete ctx.store.state.halted;
      // 日予算の上限で止まった日に解除したなら、その日はもう上限で止めない（すぐ止め直さないように）
      if (was?.reason.includes('月の上限')) ctx.store.state.monthlyCapWaivedFor = ctx.today.slice(0, 7);
      else if (was?.reason.includes('上限')) ctx.store.state.spendCapWaivedOn = ctx.today;
      ctx.store.save();
      console.log(was ? `緊急停止を解除しました（${was.at} ${was.reason}）。止めた広告は自動では再開しません。必要なものを管理画面で ON にしてください。` : '緊急停止中ではありません');
      if (was) await notifySlack(ctx.settings.slack.webhookUrl, { text: ':arrow_forward: *adops 緊急停止を解除* 次回の実行から企画・入稿を再開します（止めた広告は管理画面で個別に再開してください）' });
      break;
    }
    case 'add-job': {
      // 求人票テキストから jobs.json に1件追加（active=false で追加し、人が確認して true にする）
      loadDotEnv();
      const settings = loadSettings();
      const catalog = loadCatalog(settings.configDir);
      const file = typeof flags.file === 'string' ? flags.file : '';
      const text = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
      if (!text.trim()) throw new Error('求人票のテキストを --file か標準入力で渡してください');
      if (!settings.anthropic.apiKey) throw new Error('add-job には ANTHROPIC_API_KEY が必要です');
      const { job, warnings } = await importJob(new ClaudeLlm(settings.anthropic), text, catalog.personas);
      while (catalog.jobs.some((j) => j.id === job.id)) job.id = `${job.id}-2`;
      console.log(JSON.stringify(job, null, 2));
      for (const w of warnings) console.log(`注意: ${w}`);
      if (flags.write) {
        const path = join(settings.configDir, 'jobs.json');
        const jobs = JSON.parse(readFileSync(path, 'utf8'));
        jobs.push(job);
        writeFileSync(path, `${JSON.stringify(jobs, null, 2)}\n`);
        console.log(`\n${path} に追加しました（active=false）。内容と placements を確認して active を true にしてください。`);
      } else console.log('\n（--write を付けると config/jobs.json に追加します）');
      break;
    }
    case 'simulate': {
      // シミュレーションは本物の媒体・状態ファイルに触れない（一時フォルダ・DRY RUN・媒体なし）
      process.env.ADOPS_DATA_DIR = mkdtempSync(join(tmpdir(), 'adops-sim-'));
      const ctx = buildCtx({ ...flags });
      ctx.meta = null;
      ctx.google = null;
      ctx.dryRun = true;
      ctx.checkPage = undefined;
      await simulate(ctx, { days: Number(flags.days ?? 14), seed: Number(flags.seed ?? 42) });
      break;
    }
    default:
      console.log(`使い方: node src/cli.ts <cycle|plan|produce|publish|collect|optimize|analyze|report|status|export|lp|lp-approve|lp-retire|check|simulate|add-job|emergency-stop|resume|leads> [--offline] [--steps a,b] [--today YYYY-MM-DD]`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
