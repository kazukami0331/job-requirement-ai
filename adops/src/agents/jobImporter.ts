/**
 * 求人票（自由記述のテキスト）から jobs.json の1件を作るエージェント。
 * 広告は「jobs.json に書かれた事実だけ」で作られるので、ここで事実以外を足さないことが最重要。
 */
import { z } from 'zod';
import type { Llm } from '../llm/llm.ts';
import type { Job, Persona } from '../types.ts';

export const JobDraftSchema = z.object({
  id: z.string().describe('英小文字とハイフンの ID（例: factory-aichi）'),
  title: z.string().describe('広告に出せる職種名（例: 自動車部品の製造スタッフ）'),
  category: z.string().describe('製造 / 物流 / ドライバー / 建設 / 警備 / 介護 / 清掃 / 設備 などの分類'),
  location: z.string().describe('勤務地（都道府県＋市区町村）'),
  employmentType: z.string().describe('雇用形態（正社員 / 契約社員 / 派遣社員 / アルバイト 等。登用制度があれば括弧で）'),
  salary: z.object({
    type: z.enum(['月給', '日給', '時給', '年収']),
    min: z.number().describe('下限（円）'),
    max: z.number().describe('上限（円）。記載が無ければ 0'),
    note: z.string().describe('月収例などの補足。無ければ空文字'),
  }),
  perks: z.array(z.string()).describe('待遇・特徴（求人票に書かれているものだけ。各15字以内）'),
  hours: z.string().describe('勤務時間。無ければ空文字'),
  holidays: z.string().describe('休日。無ければ空文字'),
  requirements: z.string().describe('応募条件。年齢・性別の条件は入れない。無ければ空文字'),
  personas: z.array(z.string()).describe('既存ペルソナの ID から合うものを1〜3個'),
  landingUrl: z.string().describe('応募ページの URL。求人票に無ければ空文字'),
  warnings: z.array(z.string()).describe('求人票にあったが広告に使うべきでない記載（年齢・性別の条件など）や、不足している情報'),
});

const SYSTEM = `あなたは人材紹介会社で求人票を広告用のデータに整理する担当です。
求人票のテキストから、広告運用システムの求人データ（JSON）を作ります。

- **求人票に書かれている事実だけ**を入れる。推測で待遇・金額を足さない（足すと虚偽表示の広告になる）
- 給与は求人票の表記どおりの種類（月給/日給/時給/年収）と金額。幅があれば min/max、月収例は note に
- 年齢・性別の条件は requirements に入れず warnings に書く（広告で年齢・性別を限定できないため）
- perks は広告の訴求に使える具体的な待遇（寮費無料、日払いOK、資格取得支援、賞与年2回 など）
- 情報が足りない項目は空にし、warnings に「〜が不明」と書く`;

export async function importJob(llm: Llm, text: string, personas: Persona[]): Promise<{ job: Job; warnings: string[] }> {
  const out = await llm.structured({
    agent: 'jobImporter',
    system: SYSTEM,
    prompt: `# 既存のペルソナ
${personas.map((p) => `- ${p.id}: ${p.name}（${p.summary}）`).join('\n')}

# 求人票
${text}`,
    schema: JobDraftSchema,
  });
  const ids = new Set(personas.map((p) => p.id));
  const job: Job = {
    id: out.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || `job-${Date.now()}`,
    // 人が確認してから配信対象にする
    active: false,
    title: out.title,
    category: out.category,
    location: out.location,
    employmentType: out.employmentType,
    salary: { type: out.salary.type, min: out.salary.min, ...(out.salary.max > out.salary.min ? { max: out.salary.max } : {}), ...(out.salary.note ? { note: out.salary.note } : {}) },
    perks: out.perks,
    ...(out.hours ? { hours: out.hours } : {}),
    ...(out.holidays ? { holidays: out.holidays } : {}),
    ...(out.requirements ? { requirements: out.requirements } : {}),
    personas: out.personas.filter((p) => ids.has(p)).slice(0, 3),
    landingUrl: out.landingUrl,
    dailyCreativeQuota: 1,
    placements: { meta: { adsetIds: [] }, google: { adGroupIds: [], assetGroupIds: [], searchAdGroupIds: [] } },
  };
  if (job.personas.length === 0 && personas[0]) job.personas = [personas[0].id];
  const warnings = [...out.warnings];
  if (!job.landingUrl.startsWith('http')) warnings.push('応募ページの URL（landingUrl）を設定してください');
  return { job, warnings };
}
