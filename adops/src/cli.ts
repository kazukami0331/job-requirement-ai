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
 *   node src/cli.ts check                 設定と接続の確認
 *   node src/cli.ts simulate --days 14    架空の配信データで改善ループを試す（媒体・API キー不要）
 *
 * 共通オプション: --offline（Claude を呼ばずテンプレートで動かす） --today YYYY-MM-DD
 */
import { loadCatalog, loadDotEnv, loadSettings, isGoogleConfigured, isMetaConfigured } from './config.ts';
import { ClaudeLlm, type Llm } from './llm/llm.ts';
import { offlineLlm } from './llm/offline.ts';
import { createImageProvider } from './creative/imageProvider.ts';
import { StateStore } from './store/stateStore.ts';
import { makeCtx, platformClients, type Ctx } from './pipeline/context.ts';
import { ALL_STEPS, runCycle, type StepName } from './pipeline/cycle.ts';
import { ffmpegAvailable } from './creative/video.ts';
import { writeReport } from './report/html.ts';
import { ANGLE_LABELS } from './types.ts';
import { lastNDays, totals } from './optimize/stats.ts';
import { newId } from './util/id.ts';
import { simulate } from './sim/simulate.ts';

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

function buildCtx(flags: Record<string, string | boolean>): Ctx {
  loadDotEnv();
  const settings = loadSettings();
  const catalog = loadCatalog(settings.configDir);
  const offline = Boolean(flags.offline) || !settings.anthropic.apiKey;
  if (offline && !flags.offline) console.warn('ANTHROPIC_API_KEY が未設定のため、オフライン（テンプレート）モードで動かします。');
  const llm: Llm = offline ? offlineLlm(catalog) : new ClaudeLlm(settings.anthropic);
  const store = new StateStore(settings.dataDir);
  const { meta, google } = platformClients(settings);
  return makeCtx({
    settings,
    catalog,
    store,
    llm,
    images: createImageProvider(settings),
    meta,
    google,
    dryRun: settings.dryRun,
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
  };

  switch (command) {
    case 'cycle': {
      const ctx = buildCtx(flags);
      const steps = typeof flags.steps === 'string' ? (flags.steps.split(',') as StepName[]) : ALL_STEPS;
      const rec = await runCycle(ctx, steps);
      process.exitCode = rec.steps.every((s) => s.ok) ? 0 : 1;
      break;
    }
    case 'plan':
    case 'produce':
    case 'publish':
    case 'collect':
    case 'optimize':
    case 'analyze': {
      const ctx = buildCtx(flags);
      const rec = await runCycle(ctx, single[command]);
      process.exitCode = rec.steps.every((s) => s.ok) ? 0 : 1;
      break;
    }
    case 'report': {
      const ctx = buildCtx(flags);
      console.log(writeReport(ctx.store.state, ctx.catalog, ctx.store.dir, ctx.today));
      break;
    }
    case 'status': {
      const ctx = buildCtx(flags);
      const cs = ctx.store.creatives();
      const by = new Map<string, number>();
      for (const c of cs) by.set(c.status, (by.get(c.status) ?? 0) + 1);
      console.log(`クリエイティブ ${cs.length} 本: ${[...by].map(([k, v]) => `${k}=${v}`).join(' ')}`);
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
      if (!catalogOk) process.exitCode = 1;
      break;
    }
    case 'simulate': {
      const ctx = buildCtx({ ...flags });
      await simulate(ctx, { days: Number(flags.days ?? 14), seed: Number(flags.seed ?? 42) });
      break;
    }
    default:
      console.log(`使い方: node src/cli.ts <cycle|plan|produce|publish|collect|optimize|analyze|report|status|check|simulate> [--offline] [--steps a,b] [--today YYYY-MM-DD]`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
