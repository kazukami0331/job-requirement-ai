/** 段階2: 停止・入れ替え・予算調整の判断を出し、許可された範囲で媒体に反映する。 */
import type { Ctx } from './context.ts';
import type { Decision } from '../types.ts';
import { decide, type AdsetInfo } from '../optimize/decide.ts';
import { logger } from '../util/log.ts';
import { placementsFor } from '../config.ts';
import { emergencyStop } from './emergency.ts';
import { notifySlack } from '../notify/slack.ts';
import { addDays, daysBetween } from '../util/id.ts';

const log = logger('optimize');

/** 指定した日付（の範囲）の広告費の合計（adops の広告と検索広告）。 */
export function spendBetween(ctx: Ctx, from: string, to: string): number {
  const sum = (ms: { date: string; spend: number }[]) => ms.filter((m) => m.date >= from && m.date <= to).reduce((x, m) => x + m.spend, 0);
  return (
    ctx.store.creatives().reduce((a, c) => a + sum(c.metrics), 0) + Object.values(ctx.store.state.searchAds ?? {}).reduce((a, s) => a + sum(s.metrics), 0)
  );
}

/** 今月の広告費の上限（ADOPS_MONTHLY_SPEND_CAP、円）に対する消化状況。上限なしなら null。 */
export function monthlySpend(ctx: Ctx): { spent: number; cap: number } | null {
  const cap = Number(process.env.ADOPS_MONTHLY_SPEND_CAP || 0);
  if (!(cap > 0)) return null;
  return { spent: spendBetween(ctx, `${ctx.today.slice(0, 7)}-01`, ctx.today), cap };
}

/**
 * 広告費の上限。設定や判断の誤りで費用が膨らむのを防ぐ最後の砦。超えていたら adops の広告をすべて止めて入稿も凍結する（人が resume するまで）。
 * - 1日（ADOPS_DAILY_SPEND_CAP）: 当日の消化額。解除した日はもう止めない
 * - 1か月（ADOPS_MONTHLY_SPEND_CAP）: 今月の消化額。解除した月はもう止めない（9割を超えたら予算増を止める）
 */
export async function enforceSpendCap(ctx: Ctx): Promise<string | null> {
  if (ctx.store.state.halted) return null;
  let reason: string | null = null;
  const cap = Number(process.env.ADOPS_DAILY_SPEND_CAP || 0);
  // 上限超えで止まったあと、人が確認して同じ日に解除した場合は、その日はもう止めない（解除がすぐ打ち消されないように）
  if (cap > 0 && ctx.store.state.spendCapWaivedOn !== ctx.today) {
    const spent = spendBetween(ctx, ctx.today, ctx.today);
    if (spent > cap) reason = `本日の広告費 ${Math.round(spent).toLocaleString()}円 が上限 ${cap.toLocaleString()}円 を超えたため自動で緊急停止`;
  }
  const month = monthlySpend(ctx);
  if (!reason && month && month.spent > month.cap && ctx.store.state.monthlyCapWaivedFor !== ctx.today.slice(0, 7)) {
    reason = `今月の広告費 ${Math.round(month.spent).toLocaleString()}円 が月の上限 ${month.cap.toLocaleString()}円 を超えたため自動で緊急停止`;
  }
  if (!reason) return null;
  log.warn(reason);
  if (ctx.dryRun) return `${reason}（DRY RUN のため実際には止めていません）`;
  const r = await emergencyStop(ctx, reason);
  await notifySlack(ctx.settings.slack.webhookUrl, {
    text: `:rotating_light: *adops: ${reason}*\n${r.paused} 件を停止し、新しい入稿も止めました。原因を確認して、問題なければ Actions の control: resume（または Slack の /adops resume）で解除してください。解除した日（月の上限なら月）は上限による停止をしません。`,
  });
  return reason;
}

export function maxFrequency(): number {
  return Number(process.env.ADOPS_MAX_FREQUENCY || 4);
}

/** 広告セットの直近7日のフリークエンシーを取り、状態に記録する（1日1回。取れなければ前回の値）。 */
async function adsetFrequency(ctx: Ctx, adsetId: string): Promise<number | null> {
  const audience = (ctx.store.state.audience ??= {});
  const prev = audience[adsetId];
  if (prev?.date === ctx.today) return prev.frequency;
  try {
    const r = await ctx.meta!.adsetFrequency(adsetId, addDays(ctx.today, -6), ctx.today);
    if (!r) return null;
    audience[adsetId] = { date: ctx.today, frequency: Math.round(r.frequency * 100) / 100, reach: r.reach };
    return audience[adsetId].frequency;
  } catch (e) {
    log.warn(`広告セット ${adsetId} のフリークエンシー取得に失敗: ${(e as Error).message.slice(0, 200)}`);
    return prev?.frequency ?? null;
  }
}

export async function optimize(ctx: Ctx): Promise<Decision[]> {
  const { store, catalog, today } = ctx;
  const capped = await enforceSpendCap(ctx);
  if (capped && !ctx.dryRun) return [];
  const adsetsByJob = new Map<string, AdsetInfo[]>();
  if (ctx.meta) {
    for (const job of catalog.jobs.filter((j) => j.active)) {
      const infos: AdsetInfo[] = [];
      // 共通の広告セットにはペルソナ別の入稿先がないペルソナ、ペルソナ別の広告セットにはそのペルソナだけ
      const targets = new Map<string, Set<string>>();
      for (const pid of job.personas) {
        for (const id of placementsFor(catalog, job, pid).meta?.adsetIds ?? []) targets.set(id, (targets.get(id) ?? new Set()).add(pid));
      }
      for (const [id, personas] of targets) {
        try {
          const a = await ctx.meta.getAdset(id);
          const freq = await adsetFrequency(ctx, id);
          infos.push({ id: a.id, dailyBudget: a.dailyBudget, personaIds: [...personas], frequency: freq ?? undefined });
        } catch (e) {
          log.warn(`広告セット ${id} の取得に失敗: ${(e as Error).message}`);
        }
      }
      if (infos.length) adsetsByJob.set(job.id, infos);
    }
  }

  // 同じ広告セットの予算は数日に1回だけ上げる（1日3回の実行のたびに上がらないように。学習のリセットも避ける）
  const cooldownDays = Number(process.env.ADOPS_BUDGET_COOLDOWN_DAYS || 3);
  const recentlyScaled = new Set(
    store.state.decisions
      .filter((d) => d.action === 'scale_budget' && d.applied && d.adsetId && daysBetween(d.date, today) < cooldownDays)
      .map((d) => d.adsetId!),
  );
  const decisions = decide({
    creatives: store.creatives(),
    policy: catalog.policy,
    today,
    adsetsByJob,
    recentlyScaled,
    activeJobIds: new Set(catalog.jobs.filter((j) => j.active).map((j) => j.id)),
    targetCpaByJob: new Map(catalog.jobs.filter((j) => j.targetCpa).map((j) => [j.id, j.targetCpa!])),
    maxFrequency: maxFrequency(),
  });
  const auto = catalog.policy.autonomy === 'auto';
  // 今月の上限の9割を超えたら予算は増やさない（月末に上限で全停止になるのを避ける）
  const month = monthlySpend(ctx);
  if (month && month.spent >= month.cap * 0.9) {
    const n = decisions.filter((d) => d.action === 'scale_budget').length;
    if (n) log.info(`今月の広告費が上限の9割（${Math.round(month.spent).toLocaleString()}/${month.cap.toLocaleString()}円）を超えたため予算増 ${n} 件を見送り`);
    decisions.splice(0, decisions.length, ...decisions.filter((d) => d.action !== 'scale_budget'));
  }

  for (const d of decisions) {
    try {
      if ((d.action === 'pause' || d.action === 'retire') && d.creativeId) {
        const c = store.state.creatives[d.creativeId];
        const metaAds = c.platformRefs.meta?.adIds ?? [];
        const googleRefs = c.platformRefs.google?.linkedTo ?? [];
        const onPlatform = metaAds.length + googleRefs.length > 0;
        if (onPlatform && !ctx.dryRun) {
          // 媒体に出ているのに API が未設定だと止められない。黙って「止めたこと」にしない
          if (metaAds.length && !ctx.meta) throw new Error('Meta の API が未設定のため停止できません');
          if (googleRefs.length && !ctx.google) throw new Error('Google 広告の API が未設定のため停止できません');
          for (const adId of metaAds) await ctx.meta!.stopAd(adId);
          for (const rn of googleRefs) if (rn.includes('/adGroupAds/')) await ctx.google!.setAdGroupAdStatus(rn, 'PAUSED');
          const pmax = googleRefs.filter((rn) => rn.includes('/assetGroupAssets/'));
          if (pmax.length) await ctx.google!.removeAssetGroupAssets(pmax);
          d.applied = true;
        }
        // 媒体に反映できたとき（または媒体に出ていないシミュレーション）だけ手元の状態を変える。
        // DRY RUN で状態だけ変えると、配信中の広告が監視対象から外れてしまう
        if (d.applied || !onPlatform) store.setStatus(c, d.action === 'retire' ? 'retired' : 'paused', d.reason);
      } else if (d.action === 'scale_budget' && d.adsetId) {
        // 予算を増やすのは auto モードのときだけ。draft モードでは提案として通知する
        if (auto && !ctx.dryRun && ctx.meta && !store.state.halted) {
          await ctx.meta.setAdsetDailyBudget(d.adsetId, Number(d.detail?.to));
          d.applied = true;
        }
      }
    } catch (e) {
      d.reason += `（反映失敗: ${(e as Error).message}）`;
      log.error(`判断の反映に失敗 ${d.action} ${d.creativeId ?? d.adsetId}: ${(e as Error).message}`);
    }
    store.state.decisions.push(d);
  }
  log.info(`判断 ${decisions.length} 件（停止 ${decisions.filter((d) => d.action === 'pause').length} / 疲弊入替 ${decisions.filter((d) => d.action === 'retire').length} / 予算増 ${decisions.filter((d) => d.action === 'scale_budget').length}）`);
  return decisions;
}
