/**
 * 実績を Google スプレッドシートに書き出す（チームの報告・BI 用）。
 * サービスアカウント（GOOGLE_SERVICE_ACCOUNT_JSON）を、対象のスプレッドシートに「編集者」で共有しておく。
 *
 * シート「adops_日次」: 日付 × クリエイティブ × 媒体の実績（直近60日を毎回まるごと書き直す）
 * シート「adops_広告」: クリエイティブの一覧（状態・訴求軸・コピー・選考結果）
 */
import type { Catalog } from '../config.ts';
import type { State } from '../types.ts';
import { ANGLE_LABELS, FORMAT_LABEL } from '../types.ts';
import { signJwt } from '../creative/inbox.ts';
import { requestJson } from '../util/http.ts';
import { addDays } from '../util/id.ts';
import { totals } from '../optimize/stats.ts';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

export function dailyRows(state: State, today: string, days = 60): (string | number)[][] {
  const from = addDays(today, -(days - 1));
  const rows: (string | number)[][] = [['日付', 'クリエイティブ', '求人', '訴求軸', '形式', '媒体', '表示', 'クリック', '費用', '応募', 'CTR(%)', '応募単価']];
  const creatives = Object.values(state.creatives);
  for (const c of creatives) {
    for (const m of c.metrics.filter((x) => x.date >= from && x.date <= today)) {
      rows.push([
        m.date,
        c.id,
        c.jobId,
        ANGLE_LABELS[c.angle],
        FORMAT_LABEL[c.format],
        m.platform === 'meta' ? 'Meta' : 'Google',
        m.impressions,
        m.clicks,
        Math.round(m.spend),
        m.conversions,
        m.impressions ? Math.round((m.clicks / m.impressions) * 10000) / 100 : 0,
        m.conversions ? Math.round(m.spend / m.conversions) : '',
      ]);
    }
  }
  for (const a of Object.values(state.searchAds ?? {})) {
    for (const m of a.metrics.filter((x) => x.date >= from && x.date <= today)) {
      rows.push([m.date, a.id, a.jobId, '検索広告', '検索', 'Google', m.impressions, m.clicks, Math.round(m.spend), m.conversions, m.impressions ? Math.round((m.clicks / m.impressions) * 10000) / 100 : 0, m.conversions ? Math.round(m.spend / m.conversions) : '']);
    }
  }
  const [head, ...body] = rows;
  body.sort((x, y) => String(y[0]).localeCompare(String(x[0])) || String(x[1]).localeCompare(String(y[1])));
  return [head, ...body];
}

export function creativeRows(state: State, catalog: Catalog): (string | number)[][] {
  const rows: (string | number)[][] = [['クリエイティブ', '作成日', '状態', '求人', '訴求軸', '形式', 'レイアウト', '探索', '言語', '画像の文字', '見出し', '表示(累計)', 'クリック', '費用', '応募', '面接', '入社', '状態の理由']];
  for (const c of Object.values(state.creatives).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))) {
    const b = state.briefs[c.briefId];
    const t = totals(c.metrics);
    rows.push([
      c.id,
      c.createdAt.slice(0, 10),
      c.status,
      catalog.jobs.find((j) => j.id === c.jobId)?.title ?? c.jobId,
      ANGLE_LABELS[c.angle],
      FORMAT_LABEL[c.format],
      c.layout ?? '',
      c.explore ? '探索' : '',
      b?.language ?? 'ja',
      b?.overlay.main ?? '',
      b?.headline ?? '',
      t.impressions,
      t.clicks,
      Math.round(t.spend),
      t.conversions,
      c.funnel?.interview ?? '',
      c.funnel?.hired ?? '',
      (c.statusReason ?? '').slice(0, 200),
    ]);
  }
  return rows;
}

export async function exportToSheets(state: State, catalog: Catalog, today: string): Promise<string> {
  const sheetId = (process.env.ADOPS_SHEET_ID ?? '').trim();
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '';
  if (!sheetId) return 'スプレッドシートへの書き出しは未設定（ADOPS_SHEET_ID）';
  if (!saJson) return 'GOOGLE_SERVICE_ACCOUNT_JSON が未設定のため書き出しません';
  const sa = JSON.parse(saJson);
  const { access_token } = await requestJson<{ access_token: string }>('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(sa, 'https://www.googleapis.com/auth/spreadsheets') }),
  });
  const headers = { authorization: `Bearer ${access_token}` };

  // シートが無ければ作る
  const meta = await requestJson<{ sheets: { properties: { title: string } }[] }>(`${API}/${sheetId}?fields=sheets.properties.title`, { headers });
  const existing = new Set(meta.sheets.map((s) => s.properties.title));
  const wanted = ['adops_日次', 'adops_広告'];
  const missing = wanted.filter((t) => !existing.has(t));
  if (missing.length) {
    await requestJson(`${API}/${sheetId}:batchUpdate`, { method: 'POST', headers, json: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) } });
  }
  const write = async (title: string, values: (string | number)[][]) => {
    await requestJson(`${API}/${sheetId}/values/${encodeURIComponent(`'${title}'!A:Z`)}:clear`, { method: 'POST', headers, json: {} });
    await requestJson(`${API}/${sheetId}/values/${encodeURIComponent(`'${title}'!A1`)}?valueInputOption=RAW`, { method: 'PUT', headers, json: { values } });
  };
  const daily = dailyRows(state, today);
  const list = creativeRows(state, catalog);
  await write('adops_日次', daily);
  await write('adops_広告', list);
  return `スプレッドシートに書き出し（日次 ${daily.length - 1} 行 / 広告 ${list.length - 1} 行）`;
}
