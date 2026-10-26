/**
 * API キーなしで全工程を動かすための「それらしい」応答。
 * 求人情報からテンプレートで企画を作るだけなので品質は低い。動作確認・デモ・テスト専用。
 */
import { ScriptedLlm } from './llm.ts';
import type { Catalog } from '../config.ts';
import { ANGLES, type Angle } from '../types.ts';
import { formatYen } from '../compliance/rules.ts';

const HOOKS: Record<Angle, (j: { pay: string; perk: string; title: string }) => [string, string]> = {
  pay: (j) => [`${j.pay}から`, `${j.title}`],
  housing: () => ['住まいと仕事を同時に', '寮完備で引っ越し後すぐ働ける'],
  beginner: () => ['未経験からはじめる', '研修があるから最初の一歩も安心'],
  stability: () => ['長く働ける職場へ', '安定して働ける環境で'],
  quick_cash: (j) => [`${j.perk}`, 'まとまって稼ぎたい方に'],
  lifestyle: () => ['休みの予定が立てやすい', '生活リズムを整えたい方に'],
  team: () => ['先輩が一から教えます', '相談しやすい職場です'],
  skill: () => ['手に職をつけたい方へ', '資格取得の支援があります'],
  pride: () => ['毎日の暮らしを支える仕事', '社会に欠かせない現場です'],
  speed: () => ['スマホで応募完了', '面接までスムーズに進めます'],
};

export function offlineLlm(catalog: Catalog): ScriptedLlm {
  const llm = new ScriptedLlm();
  llm.on('strategist.plan', (req) => {
    const slots = [...req.prompt.matchAll(/slot (\d+): 求人=([\w-]+) \/ ペルソナ=([\w-]+) \/ 訴求軸=.+?\((\w+)\) \/ 形式=(動画|画像|カルーセル)/g)];
    return {
      briefs: slots.map((m) => {
        const [, slot, jobId, , angleRaw, format] = m;
        const job = catalog.jobs.find((j) => j.id === jobId)!;
        const angle = (ANGLES as readonly string[]).includes(angleRaw) ? (angleRaw as Angle) : 'pay';
        const pay = `${job.salary.type}${formatYen(job.salary.min)}`;
        const [main, sub] = HOOKS[angle]({ pay, perk: job.perks[0] ?? '', title: job.title.slice(0, 14) });
        const isVideo = format === '動画';
        const isCarousel = format === 'カルーセル';
        return {
          slot: Number(slot),
          hypothesis: `${job.category}の求職者には「${main}」が響く`,
          hook: main,
          headline: `${job.location.slice(0, 6)}の${job.category}｜${pay}〜`,
          primaryText: `${job.title}を募集しています。${pay}〜。${job.perks.slice(0, 3).join('・')}。まずは詳細をご覧ください。`,
          description: job.perks.slice(0, 2).join('・'),
          cta: 'APPLY_NOW',
          overlay: { main: main.slice(0, 16), sub: sub.slice(0, 28), badges: job.perks.slice(0, 3).map((p) => p.slice(0, 10)) },
          storyboard: isCarousel
            ? [
                { seconds: 0, text: main.slice(0, 16), visual: 'worker arriving in the morning' },
                { seconds: 0, text: 'お昼は仲間とひと息', visual: 'lunch break with coworkers' },
                { seconds: 0, text: (job.perks[0] ?? sub).slice(0, 16), visual: 'clean dormitory room' },
              ]
            : isVideo
            ? [
                { seconds: 2.5, text: main.slice(0, 16), visual: 'worker smiling at factory entrance' },
                { seconds: 3, text: `${pay}〜`, visual: 'close up of hands working' },
                { seconds: 3, text: (job.perks[0] ?? sub).slice(0, 16), visual: 'clean dormitory room' },
              ]
            : [],
          visualConcept: `${job.category}の現場で働く人物の自然な写真`,
          imagePrompt: `candid photo of a Japanese ${job.category === '製造' ? 'factory worker' : 'worker'} in safety gear at a clean workplace, natural light, no text, no letters, no logos`,
        };
      }),
    };
  });
  llm.on('strategist.revise', (req) => {
    const m = req.prompt.match(/# 現在の企画（JSON）\n([\s\S]+?)\n\n# レビュー総評/);
    return JSON.parse(m![1]);
  });
  llm.on('reviewer', () => ({
    scores: { hook: 16, clarity: 17, personaFit: 15, credibility: 18, visualFit: 15 },
    issues: [],
    summary: '（オフライン）機械チェックのみで判定しました。',
  }));
  llm.on('artJudge.pick', (req) => ({
    candidates: (req.images ?? []).map((_, i) => ({ index: i, score: 70 - i, defects: [] })),
    selectedIndex: 0,
    reason: '（オフライン）先頭を選択',
  }));
  llm.on('artJudge.qa', () => ({ pass: true, score: 80, problems: [], note: '（オフライン）' }));
  llm.on('socialWriter', (req) => {
    const hook = req.prompt.match(/- フック: (.+)/)?.[1] ?? '';
    return { caption: `${hook}\n\n（オフライン生成のキャプション）\nプロフィールのリンクから詳細を見られます。`, hashtags: ['#求人'] };
  });
  llm.on('searchWriter', (req) => {
    const title = req.prompt.match(/- 職種: (.+?)（/)?.[1] ?? '求人';
    const place = req.prompt.match(/- 勤務地: (.+)/)?.[1] ?? '';
    const pay = req.prompt.match(/- 給与: (.+?)(（|$)/m)?.[1] ?? '';
    const perks = (req.prompt.match(/- 待遇: (.+)/)?.[1] ?? '').split(' / ');
    return {
      headlines: [title.slice(0, 15), `${place.slice(0, 6)}の求人`, pay.replace(/\s/g, '').slice(0, 15), ...perks.map((p) => p.slice(0, 15)), '未経験から始める', 'スマホで簡単応募', '詳しい条件はこちら', '見学・相談だけでも', '正社員登用あり', '週払いにも対応'],
      descriptions: [`${title}を募集。${pay}。`.slice(0, 45), `${perks.slice(0, 3).join('・')}。まずは条件をご確認ください。`.slice(0, 45)],
      path1: '求人',
      path2: '詳細',
    };
  });
  llm.on('strategyMemo', () => ({
    headline: '（オフライン）集計のみ',
    findings: ['AI の戦略メモは ANTHROPIC_API_KEY 設定後に有効になります'],
    decisions: [],
    experiments: [],
  }));
  llm.on('analyst', () => ({
    summary: '（オフライン）集計のみ。AI 分析は ANTHROPIC_API_KEY 設定後に有効になります。',
    learnings: [],
    nextActions: [],
    angleRanking: [],
  }));
  return llm;
}
