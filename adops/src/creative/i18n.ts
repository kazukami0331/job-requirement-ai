/**
 * 外国語の広告で、システム側が描く定型文（エンドカードの行動喚起・給与の種類）。
 * 広告のコピー本体は企画エージェントがその言語で書く。
 */
import type { Job } from '../types.ts';
import { formatYen } from '../compliance/rules.ts';

const CTA: Record<string, string> = {
  ja: '詳しい条件・応募はこちら',
  en: 'See details & apply below',
  vi: 'Xem chi tiết và ứng tuyển bên dưới',
  pt: 'Veja os detalhes e inscreva-se abaixo',
  id: 'Lihat detail & lamar di bawah',
  tl: 'Tingnan ang detalye at mag-apply sa ibaba',
  zh: '详细条件与报名请点击下方',
  es: 'Detalles y solicitud abajo',
};

const PAY_TYPE: Record<string, Record<string, string>> = {
  en: { 月給: 'Monthly', 日給: 'Daily', 時給: 'Hourly', 年収: 'Annual' },
  vi: { 月給: 'Lương tháng', 日給: 'Lương ngày', 時給: 'Lương giờ', 年収: 'Lương năm' },
  pt: { 月給: 'Salário mensal', 日給: 'Diária', 時給: 'Por hora', 年収: 'Anual' },
  id: { 月給: 'Gaji bulanan', 日給: 'Gaji harian', 時給: 'Gaji per jam', 年収: 'Gaji tahunan' },
  tl: { 月給: 'Buwanang sahod', 日給: 'Arawang sahod', 時給: 'Kada oras', 年収: 'Taunang sahod' },
  zh: { 月給: '月薪', 日給: '日薪', 時給: '时薪', 年収: '年薪' },
  es: { 月給: 'Salario mensual', 日給: 'Salario diario', 時給: 'Por hora', 年収: 'Anual' },
};

export function ctaText(language = 'ja'): string {
  return CTA[language] ?? CTA.en;
}

/** 給与の一行（金額は「円」のまま。外国語では給与の種類だけ訳す） */
export function salaryLine(job: Job, language = 'ja'): string {
  const s = job.salary;
  if (language === 'ja') return `${s.type} ${formatYen(s.min)}${s.max ? `〜${formatYen(s.max)}` : '〜'}`;
  // 外国の方には「30万円」より「300,000円」の方が読みやすい
  const type = PAY_TYPE[language]?.[s.type] ?? PAY_TYPE.en[s.type] ?? s.type;
  const yen = (n: number) => `${n.toLocaleString('en-US')}円`;
  return `${type} ${yen(s.min)}${s.max ? ` - ${yen(s.max)}` : '〜'}`;
}
