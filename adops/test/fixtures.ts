import type { Brand, Creative, CreativeBrief, DailyMetric, Job, Persona, Policy } from '../src/types.ts';
import type { Catalog } from '../src/config.ts';

export function job(over: Partial<Job> = {}): Job {
  return {
    id: 'factory',
    active: true,
    title: '自動車部品の製造スタッフ',
    category: '製造',
    location: '愛知県豊田市',
    employmentType: '派遣社員',
    salary: { type: '月給', min: 300000, max: 380000 },
    perks: ['寮費無料', '日払いOK', '未経験歓迎'],
    hours: '8:00〜17:00',
    holidays: '土日休み',
    personas: ['p1'],
    landingUrl: 'https://recruit.test-company.jp/jobs/factory',
    dailyCreativeQuota: 2,
    placements: { meta: { adsetIds: ['111'] } },
    ...over,
  };
}

export function persona(over: Partial<Persona> = {}): Persona {
  return { id: 'p1', name: '20代転職層', summary: '転職を考える20代', motivations: ['収入'], pains: ['未経験'], media: ['Instagram'], ...over };
}

export function brand(over: Partial<Brand> = {}): Brand {
  return {
    name: 'テスト社',
    tone: '誠実',
    colors: { primary: '#0B3D91', accent: '#FFC400', text: '#FFFFFF', background: '#0A1F44' },
    bannedPhrases: ['誰でも簡単'],
    visualStyle: 'documentary photo, no text',
    ...over,
  };
}

export function policy(over: Partial<Policy> = {}): Policy {
  return {
    autonomy: 'draft',
    briefsPerCycle: 4,
    videoShare: 0.5,
    exploreShare: 0.25,
    review: { passScore: 75, maxRevisions: 2 },
    imageCandidates: 4,
    guardrails: {
      minImpressions: 3000,
      ctrFloorPct: 0.4,
      ctrRelativeFloor: 0.5,
      targetCpa: 8000,
      zeroConversionSpendMultiple: 2,
      budgetStepPct: 20,
      maxDailyBudget: 30000,
      maxActivePerAdset: 6,
      fatigueDays: 14,
      fatigueCtrRatio: 0.6,
    },
    ...over,
  };
}

export function catalog(over: Partial<Catalog> = {}): Catalog {
  return { jobs: [job()], personas: [persona()], brand: brand(), policy: policy(), ...over };
}

export function brief(over: Partial<CreativeBrief> = {}): CreativeBrief {
  return {
    id: 'br_1',
    cycleId: 'cy_1',
    jobId: 'factory',
    personaId: 'p1',
    angle: 'housing',
    format: 'image',
    explore: false,
    hypothesis: '寮費無料が響く',
    hook: '寮費0円で今月から',
    headline: '寮費無料の製造スタッフ',
    primaryText: '月給30万円〜。寮費無料、日払いOK。',
    description: '未経験歓迎',
    cta: 'APPLY_NOW',
    overlay: { main: '寮費0円で今月から', sub: '月給30万円〜・未経験歓迎', badges: ['寮費無料', '日払いOK'] },
    storyboard: [],
    visualConcept: '清潔な寮の部屋',
    imagePrompt: 'clean dormitory room in Japan, natural light, no text, no letters',
    revision: 0,
    createdAt: '2026-10-01T00:00:00Z',
    ...over,
  };
}

export function creative(over: Partial<Creative> = {}): Creative {
  return {
    id: 'cr_1',
    briefId: 'br_1',
    jobId: 'factory',
    personaId: 'p1',
    angle: 'housing',
    format: 'image',
    explore: false,
    status: 'published',
    imageJobs: [],
    assets: [],
    platformRefs: { meta: { adIds: ['ad1'], creativeIds: ['c1'] } },
    metrics: [],
    createdAt: '2026-10-01T00:00:00Z',
    publishedAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...over,
  };
}

/** 毎日同じ数字の実績を days 日分作る。 */
export function daily(from: string, days: number, m: Omit<DailyMetric, 'date' | 'platform'>): DailyMetric[] {
  const out: DailyMetric[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    out.push({ date: d.toISOString().slice(0, 10), platform: 'meta', ...m });
  }
  return out;
}
