/**
 * 画像審査エージェント（Claude の画像認識を使う）。
 * 1) Midjourney の候補から一番使える1枚を選ぶ（手指の崩れ・文字化け・安全装備なし等を落とす）
 * 2) 文字を合成した完成品を最終チェックする（読めるか・切れていないか・求人と矛盾しないか）
 */
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import type { ImageInput, Llm } from '../llm/llm.ts';
import type { CreativeBrief } from '../types.ts';
import { FinalQaSchema, ImageJudgeSchema } from './schemas.ts';

const JUDGE_SYSTEM = `あなたは求人広告のアートディレクターです。AI 生成画像の候補を見て、求人広告に使える1枚を選びます。

# 落とす条件（defects に書く）
- 手指・顔・体の崩れ、不自然な関節、溶けた工具や機械
- 画像内の文字・ロゴ・透かし（後で文字を合成するので不要。崩れた文字は特に NG）
- 安全装備の欠如（現場なのにヘルメット・安全靴・手袋がない）、危険な作業姿勢、散らかった不衛生な現場
- 日本の職場に見えない（明らかに海外の看板・左ハンドル等）
- 暗すぎ・ごちゃごちゃして、上に文字を載せると読めない構図
- 人物が性的・威圧的・見下すように描かれている

# 選ぶ基準
企画の狙い（フック・ペルソナ）に合い、スマホの小さな画面でも一目で「どんな仕事か」が分かり、
上部か下部に文字を載せる余白がある1枚。全て使えなければ selectedIndex を -1 にする。`;

const QA_SYSTEM = `あなたは広告入稿前の最終チェック担当です。文字を合成した完成画像を見て、配信してよいか判定します。
- 文字が読めるか（背景とのコントラスト、端で切れていないか、重なっていないか）
- コピーと画像が矛盾していないか、求人広告として誤解を招かないか
- 画像内に崩れた文字や不要なロゴが残っていないか
- 媒体審査で落ちそうな要素（過度な肌の露出、ビフォーアフター、偽のボタンなど）がないか
問題が1つでも配信に支障があれば pass=false。`;

/** API に渡す前に縮小する（トークン節約。判定には 1024px で十分）。 */
export async function toImageInput(path: string, label?: string, maxSide = 1024): Promise<ImageInput> {
  const buf = await sharp(readFileSync(path)).resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  return { mediaType: 'image/jpeg', base64: buf.toString('base64'), label };
}

export async function pickBestImage(llm: Llm, brief: CreativeBrief, candidatePaths: string[]) {
  const images = await Promise.all(candidatePaths.map((p, i) => toImageInput(p, `候補 index=${i}`)));
  const out = await llm.structured({
    agent: 'artJudge.pick',
    tier: 'fast',
    system: JUDGE_SYSTEM,
    images,
    prompt: `# 企画
- フック: ${brief.hook}
- 画像の構想: ${brief.visualConcept}
- 載せる文字: ${brief.overlay.main} / ${brief.overlay.sub}

上の ${candidatePaths.length} 枚の候補を採点し、一番使える1枚を選んでください。`,
    schema: ImageJudgeSchema,
  });
  const valid = out.selectedIndex >= 0 && out.selectedIndex < candidatePaths.length;
  const selected = valid ? out.candidates.find((c) => c.index === out.selectedIndex) : undefined;
  return { selectedIndex: valid ? out.selectedIndex : -1, score: selected?.score ?? 0, reason: out.reason, candidates: out.candidates };
}

export async function finalQa(llm: Llm, brief: CreativeBrief, composedPath: string) {
  return llm.structured({
    agent: 'artJudge.qa',
    tier: 'fast',
    system: QA_SYSTEM,
    images: [await toImageInput(composedPath, '完成画像')],
    prompt: `# 企画
- 見出し: ${brief.headline}
- 画像の文字: ${brief.overlay.main} / ${brief.overlay.sub} / ${brief.overlay.badges.join('・')}

この完成画像を配信してよいか判定してください。`,
    schema: FinalQaSchema,
  });
}
