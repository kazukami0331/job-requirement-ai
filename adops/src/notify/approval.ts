/**
 * draft モードの承認を Slack で行うためのメッセージ。
 * 入稿（停止状態）した広告ごとに、プレビュー画像・コピー・ボタン（配信開始 / 却下）を送る。
 * ボタンを押すと、リポジトリの Next.js アプリの /api/adops/slack が媒体の広告を ON / 停止にする。
 *
 * 使うには Slack アプリで Interactivity を有効にし、Request URL に
 * https://<Vercel のドメイン>/api/adops/slack を設定する（README 参照）。
 */
import { createHmac } from 'node:crypto';
import type { Creative, CreativeBrief, Job } from '../types.ts';
import { ANGLE_LABELS, FORMAT_LABEL, LANGUAGE_LABEL } from '../types.ts';
import { formatYen } from '../compliance/rules.ts';

export interface ApprovalValue {
  /** クリエイティブ ID */
  c: string;
  /** Meta の広告 ID */
  m: string[];
  /** Google の広告（adGroupAds のリソース名） */
  g: string[];
  /** 有効期限（UNIX 秒）。古いボタンで停止済みの広告を再開させないため */
  e: number;
  /** 改ざん防止の署名（ADOPS_APPROVAL_SECRET。Vercel 側と同じ値） */
  s: string;
}

/** 署名対象の文字列（受け口の route.ts と同じ組み立て方にすること） */
export function approvalPayload(v: Omit<ApprovalValue, 's'>): string {
  return `${v.c}|${v.m.join(',')}|${v.g.join(',')}|${v.e}`;
}

export function approvalValue(c: Creative, secret = process.env.ADOPS_APPROVAL_SECRET ?? '', ttlHours = 48): ApprovalValue {
  const v = {
    c: c.id,
    m: c.platformRefs.meta?.adIds ?? [],
    g: (c.platformRefs.google?.linkedTo ?? []).filter((rn) => rn.includes('/adGroupAds/')),
    e: Math.floor(Date.now() / 1000) + ttlHours * 3600,
  };
  return { ...v, s: createHmac('sha256', secret).update(approvalPayload(v)).digest('hex') };
}

export function approvalBlocks(c: Creative, brief: CreativeBrief, job: Job): unknown[] {
  const value = JSON.stringify(approvalValue(c));
  const s = job.salary;
  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*承認待ち: ${brief.overlay.main}*（${ANGLE_LABELS[c.angle]}・${FORMAT_LABEL[c.format]}${c.explore ? '・探索' : ''}）`,
          `${job.title}｜${job.location}｜${s.type}${formatYen(s.min)}〜`,
          `*見出し* ${brief.headline}`,
          `*本文* ${brief.primaryText.slice(0, 280)}`,
          ...(brief.translationJa
            ? [`*日本語訳（${LANGUAGE_LABEL[brief.language ?? ''] ?? brief.language}の広告）* ${brief.translationJa.main} ／ ${brief.translationJa.headline}\n${brief.translationJa.primaryText.slice(0, 280)}`]
            : []),
          `_仮説: ${brief.hypothesis}_`,
        ].join('\n'),
      },
    },
  ];
  const url = c.platformRefs.meta?.previewUrl;
  if (url) blocks.push({ type: 'image', image_url: url, alt_text: brief.overlay.main });
  blocks.push({
    type: 'actions',
    block_id: `adops_${c.id}`,
    elements: [
      { type: 'button', style: 'primary', text: { type: 'plain_text', text: '配信開始' }, action_id: 'adops_approve', value },
      {
        type: 'button',
        style: 'danger',
        text: { type: 'plain_text', text: '却下' },
        action_id: 'adops_reject',
        value,
        confirm: {
          title: { type: 'plain_text', text: '却下しますか？' },
          text: { type: 'plain_text', text: 'この広告は停止のままになり、配信されません。' },
          confirm: { type: 'plain_text', text: '却下' },
          deny: { type: 'plain_text', text: 'キャンセル' },
        },
      },
    ],
  });
  return blocks;
}
