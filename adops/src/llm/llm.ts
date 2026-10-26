import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { logger } from '../util/log.ts';
import { jstDate } from '../util/id.ts';
import type { LlmUsage } from '../types.ts';

const log = logger('llm');

/** 1M トークンあたりの USD（input, output, cache read）。コスト記録用。 */
const PRICES: Record<string, [number, number, number]> = {
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
  'claude-fable-5-1': [10, 50, 0.25],
};

export type ImageInput = { mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string; label?: string };

export interface StructuredRequest<S extends z.ZodType> {
  /** ログ・コスト集計に使うエージェント名 */
  agent: string;
  system: string;
  prompt: string;
  images?: ImageInput[];
  schema: S;
  /** 軽い処理は fastModel を使う */
  tier?: 'main' | 'fast';
  maxTokens?: number;
}

export interface Llm {
  structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<z.infer<S>>;
  readonly usage: LlmUsage[];
}

/**
 * Structured outputs の JSON Schema に合わせる。
 * zod が出す min/max などの制約キーワードは受け付けられないことがあるので落とし、
 * オブジェクトは必ず additionalProperties: false / 全プロパティ required にする。
 */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  const DROP = new Set(['$schema', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'pattern', 'format', 'default']);
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (DROP.has(k)) continue;
      out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, walk(pv)])) : walk(v);
    }
    if (out.type === 'object' && out.properties) {
      out.additionalProperties = false;
      out.required = Object.keys(out.properties as object);
    }
    return out;
  };
  return walk(raw) as Record<string, unknown>;
}

export class ClaudeLlm implements Llm {
  readonly usage: LlmUsage[] = [];
  private client: Anthropic;
  private model: string;
  private fastModel: string;
  private effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  constructor(opts: { apiKey: string; model: string; fastModel: string; effort: ClaudeLlm['effort'] }) {
    this.client = new Anthropic({ apiKey: opts.apiKey || undefined, maxRetries: 4 });
    this.model = opts.model;
    this.fastModel = opts.fastModel;
    this.effort = opts.effort;
  }

  async structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<z.infer<S>> {
    const model = req.tier === 'fast' ? this.fastModel : this.model;
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const img of req.images ?? []) {
      if (img.label) content.push({ type: 'text', text: img.label });
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
    }
    content.push({ type: 'text', text: req.prompt });

    const schema = toStrictJsonSchema(req.schema);
    const started = Date.now();
    // 長めの出力でもタイムアウトしないよう stream で受けて最終メッセージだけ使う
    const stream = this.client.beta.messages.stream({
      model,
      max_tokens: req.maxTokens ?? 32000,
      betas: ['server-side-fallback-2026-07-01'],
      // 安全分類器に誤って弾かれた場合、サーバ側で推奨モデルに切り替えて再実行させる
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: req.tier === 'fast' ? 'medium' : this.effort, format: { type: 'json_schema', schema } },
      // システムプロンプトはエージェントごとに固定なのでキャッシュが効く
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
    });
    const msg = await stream.finalMessage();
    this.record(req.agent, msg.model ?? model, msg.usage);

    if (msg.stop_reason === 'refusal') throw new Error(`[${req.agent}] Claude が応答を拒否しました`);
    if (msg.stop_reason === 'max_tokens') throw new Error(`[${req.agent}] 出力が max_tokens で切れました`);
    const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`[${req.agent}] JSON として解釈できない出力: ${text.slice(0, 300)}`);
    }
    const result = req.schema.safeParse(parsed);
    if (!result.success) throw new Error(`[${req.agent}] スキーマ不一致: ${result.error.message.slice(0, 500)}`);
    log.debug(`${req.agent} ok in ${Date.now() - started}ms`);
    return result.data;
  }

  private record(agent: string, model: string, u: Anthropic.Beta.BetaUsage): void {
    const [pin, pout, pcache] = PRICES[model] ?? PRICES['claude-opus-5-5'];
    const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) * 1.25;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const costUsd = (input * pin + (u.output_tokens ?? 0) * pout + cacheRead * pcache) / 1_000_000;
    this.usage.push({
      date: jstDate(),
      agent,
      model,
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: cacheRead,
      costUsd: Math.round(costUsd * 10000) / 10000,
    });
  }
}

/**
 * API キーなしで全工程を試すための LLM。エージェントごとの応答関数を登録して使う。
 * テストとデモ（npm run cycle をキーなしで実行）で使う。
 */
export class ScriptedLlm implements Llm {
  readonly usage: LlmUsage[] = [];
  private handlers = new Map<string, (req: StructuredRequest<z.ZodType>) => unknown>();

  on(agent: string, handler: (req: StructuredRequest<z.ZodType>) => unknown): this {
    this.handlers.set(agent, handler);
    return this;
  }

  async structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<z.infer<S>> {
    const h = this.handlers.get(req.agent);
    if (!h) throw new Error(`ScriptedLlm: ${req.agent} の応答が登録されていません`);
    this.usage.push({ date: jstDate(), agent: req.agent, model: 'scripted', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 });
    return req.schema.parse(await h(req as StructuredRequest<z.ZodType>));
  }
}
