/**
 * 運用レポート（静的 HTML）。data/report.html に書き出し、state ブランチに一緒に保存する。
 * 画像は data/assets/ を相対参照するので、ブランチをそのまま開けば見られる。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Catalog } from '../config.ts';
import type { State } from '../types.ts';
import { ANGLE_LABELS, FORMAT_LABEL, LANGUAGE_LABEL, type Angle } from '../types.ts';
import { groupBy, totals, windowed } from '../optimize/stats.ts';
import { addDays } from '../util/id.ts';
import { escapeXml } from '../creative/compose.ts';

const STATUS_LABEL: Record<string, string> = {
  planned: '企画済み',
  rejected: '却下',
  awaiting_images: '画像待ち',
  produced: '制作済み',
  qa_failed: 'QA不合格',
  published: '入稿済み',
  paused: '停止',
  retired: '入替済み',
  failed: '失敗',
};

const yen = (n: number | null) => (n === null ? '-' : `${Math.round(n).toLocaleString()}円`);

export function renderReport(state: State, catalog: Catalog, dataDir: string, today: string): string {
  const from = addDays(today, -6);
  const creatives = Object.values(state.creatives).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const all = totals(creatives.flatMap((c) => windowed(c.metrics, from, today)));
  const insight = state.insights.at(-1);
  const angleRows = groupBy(creatives, (c) => c.angle, from, today);
  const spendUsd = state.llmUsage.filter((u) => u.date >= from).reduce((a, u) => a + u.costUsd, 0);

  const card = (c: (typeof creatives)[number]) => {
    const b = state.briefs[c.briefId];
    const t = totals(windowed(c.metrics, from, today));
    const thumb = join(dataDir, 'assets', c.id, 'thumb.jpg');
    const img =
      [c.assets.find((a) => a.ratio === '4:5' && a.kind === 'image'), c.assets.find((a) => a.kind === 'image')].find((a) => a && existsSync(a.path)) ??
      (existsSync(thumb) ? { path: thumb } : undefined);
    const vid = c.assets.find((a) => a.kind === 'video' && a.ratio === '9:16' && existsSync(a.path));
    const media = vid
      ? `<video src="${escapeXml(relative(dataDir, vid.path))}" controls muted playsinline preload="none" poster="${escapeXml(relative(dataDir, vid.path.replace(/\.mp4$/, '.jpg')))}"></video>`
      : img
        ? `<img src="${escapeXml(relative(dataDir, img.path))}" loading="lazy" alt="">`
        : '<div class="ph">素材なし</div>';
    return `<article class="card s-${c.status}">
  ${media}
  <div class="meta">
    <span class="tag">${STATUS_LABEL[c.status] ?? c.status}</span>
    <span class="tag">${ANGLE_LABELS[c.angle]}</span>
    <span class="tag">${FORMAT_LABEL[c.format]}</span>
    ${c.explore ? '<span class="tag x">探索</span>' : ''}
    ${c.layout ? `<span class="tag">${({ band: '帯', card: 'カード', bold: '給与ドン' } as Record<string, string>)[c.layout] ?? c.layout}</span>` : ''}
  </div>
  <h3>${escapeXml(b?.overlay.main ?? '')}</h3>
  <p class="sub">${escapeXml(b?.headline ?? '')}</p>
  <p class="job">${escapeXml(catalog.jobs.find((j) => j.id === c.jobId)?.title ?? c.jobId)}</p>
  <dl><dt>表示</dt><dd>${t.impressions.toLocaleString()}</dd><dt>CTR</dt><dd>${t.ctr.toFixed(2)}%</dd><dt>応募</dt><dd>${t.conversions}</dd><dt>単価</dt><dd>${yen(t.cpa)}</dd>${
    c.funnel ? `<dt>面接</dt><dd>${c.funnel.interview}</dd><dt>入社</dt><dd>${c.funnel.hired}</dd>` : ''
  }</dl>
  ${c.statusReason ? `<p class="reason">${escapeXml(c.statusReason)}</p>` : ''}
</article>`;
  };

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>広告自動運用レポート</title>
<style>
:root{--bg:#f6f7f9;--fg:#1b1f24;--muted:#5d6670;--card:#fff;--line:#e3e6ea;--accent:#0b3d91;--warn:#b54708}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--fg:#e8eaed;--muted:#9aa3ad;--card:#1a1e23;--line:#2a2f36;--accent:#8fb3ff;--warn:#f5a25d}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 12px}
.muted{color:var(--muted)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:16px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.kpi b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:right;font-variant-numeric:tabular-nums}th:first-child,td:first-child{text-align:left}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;padding-bottom:10px}
.card img,.card video{width:100%;aspect-ratio:4/5;object-fit:cover;display:block;background:#000}
.card .ph{aspect-ratio:4/5;display:grid;place-items:center;color:var(--muted)}
.card h3{font-size:15px;margin:6px 12px 0}.card .sub,.card .job,.card .reason{margin:2px 12px;font-size:13px;color:var(--muted)}
.card .reason,.alerts .reason{color:var(--warn)}.alerts{font-weight:600}
.meta{display:flex;flex-wrap:wrap;gap:4px;padding:8px 12px 0}.tag{font-size:11px;border:1px solid var(--line);border-radius:99px;padding:1px 8px}.tag.x{border-color:var(--accent);color:var(--accent)}
dl{display:grid;grid-template-columns:auto 1fr auto 1fr;gap:0 8px;margin:6px 12px 0;font-size:13px}dt{color:var(--muted)}dd{margin:0;font-variant-numeric:tabular-nums}
.s-paused,.s-retired,.s-rejected,.s-failed,.s-qa_failed{opacity:.6}
ul{padding-left:20px}
</style></head><body><main>
<h1>広告自動運用レポート</h1>
<p class="muted">${from} 〜 ${today}（直近7日）・自動運用モード: ${catalog.policy.autonomy === 'auto' ? '自動配信' : '下書き入稿（人がONにする）'}</p>
<section class="kpis">
  <div class="kpi"><span class="muted">表示回数</span><b>${all.impressions.toLocaleString()}</b></div>
  <div class="kpi"><span class="muted">クリック率</span><b>${all.ctr.toFixed(2)}%</b></div>
  <div class="kpi"><span class="muted">広告費</span><b>${yen(all.spend)}</b></div>
  <div class="kpi"><span class="muted">応募</span><b>${all.conversions}</b></div>
  <div class="kpi"><span class="muted">応募単価</span><b>${yen(all.cpa)}</b></div>
  <div class="kpi"><span class="muted">入社（累計・取込分）</span><b>${creatives.reduce((a, c) => a + (c.funnel?.hired ?? 0), 0)}</b></div>
  <div class="kpi"><span class="muted">AI費用（7日）</span><b>$${spendUsd.toFixed(2)}</b></div>
</section>
${(() => {
  const alerts: string[] = [];
  if (state.halted) alerts.push(`緊急停止中（${escapeXml(state.halted.reason)}）。企画・入稿・投稿を止めています`);
  for (const j of catalog.jobs) {
    const h = state.landing?.[j.id];
    if (h?.ok === false) alerts.push(`応募ページに問題: ${escapeXml(j.title)}（${escapeXml(h.note)}）— 新規入稿を保留中`);
  }
  return alerts.length ? `<ul class="alerts">${alerts.map((a) => `<li class="reason">${a}</li>`).join('')}</ul>` : '';
})()}
${
  insight
    ? `<h2>AI分析（${insight.date}）</h2><p>${escapeXml(insight.summary)}</p>
${insight.learnings.length ? `<h3>学び</h3><ul>${insight.learnings.map((l) => `<li>${escapeXml(l)}</li>`).join('')}</ul>` : ''}
${insight.nextActions.length ? `<h3>次の打ち手</h3><ul>${insight.nextActions.map((l) => `<li>${escapeXml(l)}</li>`).join('')}</ul>` : ''}`
    : ''
}
${(() => {
  const m = state.memos?.at(-1);
  if (!m) return '';
  return `<h2>週次戦略メモ（${m.date}）</h2><p><b>${escapeXml(m.headline)}</b></p>
<ul>${m.findings.map((f) => `<li>${escapeXml(f)}</li>`).join('')}</ul>
${m.decisions.length ? `<h3>判断してほしいこと</h3><ul>${m.decisions.map((d) => `<li><b>${escapeXml(d.topic)}</b>: ${escapeXml(d.recommendation)}<br><span class="muted">${escapeXml(d.why)}</span></li>`).join('')}</ul>` : ''}`;
})()}
<h2>訴求軸別（7日）</h2>
<table><thead><tr><th>訴求軸</th><th>本数</th><th>表示</th><th>CTR</th><th>応募</th><th>応募単価</th></tr></thead><tbody>
${angleRows.map((r) => `<tr><td>${ANGLE_LABELS[r.key as Angle]}</td><td>${r.count}</td><td>${r.totals.impressions.toLocaleString()}</td><td>${r.totals.ctr.toFixed(2)}%</td><td>${r.totals.conversions}</td><td>${yen(r.totals.cpa)}</td></tr>`).join('')}
</tbody></table>
${(() => {
  // 外国人材向けの広告がある場合だけ、言語別の成績を出す
  const langOf = (c: (typeof creatives)[number]) => state.briefs[c.briefId]?.language ?? 'ja';
  if (!creatives.some((c) => langOf(c) !== 'ja')) return '';
  const rows = groupBy(creatives, langOf, from, today);
  return `<h2>言語別（7日）</h2>
<table><thead><tr><th>言語</th><th>本数</th><th>表示</th><th>CTR</th><th>応募</th><th>応募単価</th></tr></thead><tbody>
${rows.map((r) => `<tr><td>${escapeXml(LANGUAGE_LABEL[r.key] ?? r.key)}</td><td>${r.count}</td><td>${r.totals.impressions.toLocaleString()}</td><td>${r.totals.ctr.toFixed(2)}%</td><td>${r.totals.conversions}</td><td>${yen(r.totals.cpa)}</td></tr>`).join('')}
</tbody></table>`;
})()}
${(() => {
  const posts = creatives.filter((c) => c.organic).sort((a, b) => (a.organic!.postedAt < b.organic!.postedAt ? 1 : -1)).slice(0, 20);
  if (posts.length === 0) return '';
  return `<h2>Instagram 投稿（直近）</h2>
<table><thead><tr><th>投稿日</th><th>種類</th><th>素材</th><th>リーチ</th><th>再生</th><th>いいね</th><th>保存</th><th>シェア</th></tr></thead><tbody>
${posts
  .map((c) => {
    const o = c.organic!;
    const last = o.insights.at(-1);
    const n = (k: 'reach' | 'views' | 'likes' | 'saved' | 'shares') => (last ? last[k].toLocaleString() : '-');
    return `<tr><td>${o.postedAt.slice(0, 10)}</td><td>${o.kind === 'reels' ? 'リール' : 'フィード'}</td><td style="text-align:left"><a href="${escapeXml(o.permalink)}">${escapeXml(state.briefs[c.briefId]?.overlay.main ?? c.id)}</a></td><td>${n('reach')}</td><td>${n('views')}</td><td>${n('likes')}</td><td>${n('saved')}</td><td>${n('shares')}</td></tr>`;
  })
  .join('')}
</tbody></table>`;
})()}
${(() => {
  const ads = Object.values(state.searchAds ?? {}).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 20);
  if (ads.length === 0) return '';
  const label = { draft: '下書き', live: '入稿済み', paused: '停止', failed: '失敗' } as const;
  return `<h2>Google 検索広告</h2>
<table><thead><tr><th>作成日</th><th style="text-align:left">求人</th><th style="text-align:left">状態</th><th style="text-align:left">見出し（先頭3本）</th><th>表示</th><th>CTR</th><th>応募</th></tr></thead><tbody>
${ads
  .map((a) => {
    const t = totals(windowed(a.metrics, from, today));
    return `<tr><td>${a.createdOn}</td><td style="text-align:left">${escapeXml(a.jobId)}</td><td style="text-align:left">${label[a.status]}</td><td style="text-align:left">${escapeXml(a.headlines.slice(0, 3).join(' / '))}</td><td>${t.impressions.toLocaleString()}</td><td>${t.ctr.toFixed(2)}%</td><td>${t.conversions}</td></tr>`;
  })
  .join('')}
</tbody></table>`;
})()}
${(() => {
  const rows = new Map<string, { applied: number; interview: number; offer: number; hired: number; spend: number }>();
  for (const c of creatives) {
    if (!c.funnel) continue;
    const r = rows.get(c.angle) ?? { applied: 0, interview: 0, offer: 0, hired: 0, spend: 0 };
    r.applied += c.funnel.applied;
    r.interview += c.funnel.interview;
    r.offer += c.funnel.offer;
    r.hired += c.funnel.hired;
    r.spend += totals(c.metrics).spend;
    rows.set(c.angle, r);
  }
  if (rows.size === 0) return '';
  return `<h2>選考結果（訴求軸別・累計）</h2>
<table><thead><tr><th>訴求軸</th><th>応募</th><th>面接</th><th>面接率</th><th>内定</th><th>入社</th><th>入社単価</th></tr></thead><tbody>
${[...rows]
  .sort((a, b) => b[1].hired - a[1].hired || b[1].interview - a[1].interview)
  .map(
    ([a, r]) =>
      `<tr><td>${ANGLE_LABELS[a as Angle]}</td><td>${r.applied}</td><td>${r.interview}</td><td>${r.applied ? Math.round((r.interview / r.applied) * 100) : 0}%</td><td>${r.offer}</td><td>${r.hired}</td><td>${yen(r.hired ? r.spend / r.hired : null)}</td></tr>`,
  )
  .join('')}
</tbody></table>`;
})()}
<h2>クリエイティブ（新しい順）</h2>
<div class="grid">${creatives.slice(0, 120).map(card).join('\n')}</div>
<h2>直近の判断</h2>
<table><thead><tr><th>日付</th><th>対象</th><th>判断</th><th style="text-align:left">理由</th><th>反映</th></tr></thead><tbody>
${state.decisions
  .slice(-30)
  .reverse()
  .map((d) => `<tr><td>${d.date}</td><td>${escapeXml(d.creativeId ?? d.adsetId ?? '')}</td><td>${d.action}</td><td style="text-align:left">${escapeXml(d.reason)}</td><td>${d.applied ? '済' : '未'}</td></tr>`)
  .join('')}
</tbody></table>
</main></body></html>`;
}

export function writeReport(state: State, catalog: Catalog, dataDir: string, today: string): string {
  const path = join(dataDir, 'report.html');
  writeFileSync(path, renderReport(state, catalog, dataDir, today));
  return path;
}
