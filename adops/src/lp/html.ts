/**
 * 応募ページ（LP）の HTML。外部の読み込みが無い1枚の HTML（スマホ向け）。
 * 給与・勤務地などの事実は求人情報（jobs.json）からそのまま表示し、AI の文章とは分ける（事実を AI に書かせない）。
 * 応募ボタンは jobs.json の applyUrl（無ければ landingUrl）へ。広告から付いてきた utm パラメータは応募先にも引き継ぐ。
 */
import type { Brand, Job } from '../types.ts';
import type { LpCopy } from '../agents/lpWriter.ts';
import { formatYen } from '../compliance/rules.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function salaryText(job: Job): string {
  const s = job.salary;
  return `${s.type} ${formatYen(s.min)}${s.max ? `〜${formatYen(s.max)}` : '〜'}${s.note ? `（${s.note}）` : ''}`;
}

export function renderLp(copy: LpCopy, job: Job, brand: Brand, opts: { slug: string; draft?: boolean }): string {
  const c = brand.colors;
  const apply = job.applyUrl ?? job.landingUrl;
  const facts: [string, string | undefined][] = [
    ['職種', job.title],
    ['勤務地', job.location],
    ['雇用形態', job.employmentType],
    ['給与', salaryText(job)],
    ['勤務時間', job.hours],
    ['休日', job.holidays],
    ['待遇', job.perks.join(' / ')],
    ['応募条件', job.requirements],
  ];
  const cta = (cls = '') => `<a class="cta ${cls}" href="${esc(apply)}" data-apply>${esc(copy.ctaText)}</a>`;
  return `<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(job.title)}｜${esc(brand.name)}</title>
<meta name="description" content="${esc(copy.heroSub)}">
<style>
:root{--p:${c.primary};--a:${c.accent};--bg:#f6f7f9;--ink:#1b1f24;--muted:#5b6470}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;color:var(--ink);background:var(--bg);line-height:1.7}
main{max-width:640px;margin:0 auto;background:#fff}
.hero{background:var(--p);color:#fff;padding:40px 20px 32px}
.hero h1{font-size:28px;line-height:1.35;margin:0 0 12px}
.hero p{margin:0 0 16px;font-size:16px;opacity:.95}
.badges{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 20px;padding:0;list-style:none}
.badges li{background:var(--a);color:#1b1f24;font-weight:700;font-size:14px;padding:4px 10px;border-radius:999px}
section{padding:28px 20px;border-bottom:1px solid #eceef1}
h2{font-size:20px;margin:0 0 12px;line-height:1.4}
.point{margin:0 0 16px}.point h3{font-size:17px;margin:0 0 4px;color:var(--p)}.point p{margin:0}
table{width:100%;border-collapse:collapse;font-size:15px}th,td{text-align:left;vertical-align:top;padding:10px 8px;border-bottom:1px solid #eceef1}th{width:7em;color:var(--muted);font-weight:600}
details{border-bottom:1px solid #eceef1;padding:12px 0}summary{font-weight:700;cursor:pointer}details p{margin:8px 0 0}
.cta{display:block;text-align:center;background:var(--a);color:#1b1f24;font-weight:800;font-size:18px;padding:16px;border-radius:12px;text-decoration:none;box-shadow:0 2px 0 rgba(0,0,0,.15)}
.sticky{position:fixed;left:0;right:0;bottom:0;padding:10px 16px calc(10px + env(safe-area-inset-bottom));background:rgba(255,255,255,.96);box-shadow:0 -2px 8px rgba(0,0,0,.08)}
.sticky .cta{max-width:608px;margin:0 auto}
footer{padding:24px 20px 110px;font-size:13px;color:var(--muted)}
.draft{background:#c62828;color:#fff;text-align:center;font-weight:700;padding:6px;font-size:13px}
</style></head><body><main>
${opts.draft ? '<div class="draft">下書き（承認するまで公開されません）</div>' : ''}
<header class="hero">
<h1>${esc(copy.heroTitle)}</h1>
<p>${esc(copy.heroSub)}</p>
${copy.heroBadges.length ? `<ul class="badges">${copy.heroBadges.slice(0, 3).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
${cta()}
</header>
<section><h2>${esc(copy.empathyTitle)}</h2><p>${esc(copy.empathyBody)}</p></section>
<section><h2>この仕事を選ぶ理由</h2>
${copy.points.slice(0, 3).map((p, i) => `<div class="point"><h3>${i + 1}. ${esc(p.title)}</h3><p>${esc(p.body)}</p></div>`).join('\n')}
</section>
<section><h2>募集要項</h2><table>
${facts.filter(([, v]) => v).map(([k, v]) => `<tr><th>${k}</th><td>${esc(v!)}</td></tr>`).join('\n')}
</table></section>
<section><h2>よくある質問</h2>
${copy.faq.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('\n')}
</section>
<section><p>${esc(copy.closing)}</p>${cta()}</section>
<footer>${esc(brand.name)}${brand.mandatoryText ? `<br>${esc(brand.mandatoryText)}` : ''}</footer>
</main>
<div class="sticky">${cta()}</div>
<script>
// 広告の utm パラメータを応募先に引き継ぐ（どの広告・どの LP からの応募か分かるように）
(function(){var q=new URLSearchParams(location.search);q.set('utm_content',q.get('utm_content')||${JSON.stringify(opts.slug)});q.set('lp',${JSON.stringify(opts.slug)});
document.querySelectorAll('[data-apply]').forEach(function(a){try{var u=new URL(a.href);q.forEach(function(v,k){if(!u.searchParams.has(k))u.searchParams.set(k,v)});a.href=u.toString()}catch(e){}});})();
</script>
</body></html>
`;
}
