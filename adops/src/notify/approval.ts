/**
 * draft モードの承認を Slack で行うためのメッセージ。
 * 入稿（停止状態）した広告ごとに、プレビュー画像・コピー・ボタン（配信開始 / 却下）を送る。
 * ボタンを押すと、リポジトリの Next.js アプリの /api/adops/slack が媒体の広告を ON / 停止にする。
 *
 * 使うには Slack アプリで Interactivity を有効にし、Request URL に
 * https://<Vercel のドメイン>/api/adops/slack を設定する（README 参照）。
 */
import type { Creative, CreativeBrief, Job } from '../types.ts';
import { ANGLE_LABELS } from '../types.ts';
import { formatYen } from '../compliance/rules.ts';

export interface ApprovalValue {
  /** クリエイティブ ID */
  c: string;
  /** Meta の広告 ID */
  m: string[];
  /** Google の広告（adGroupAds のリソース名） */
  g: string[];
}

export function approvalValue(c: Creative): ApprovalValue {
  return {
    c: c.id,
    m: c.platformRefs.meta?.adIds ?? [],
    g: (c.platformRefs.google?.linkedTo ?? []).filter((rn) => rn.includes('/adGroupAds/')),
  };
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
          `*承認待ち: ${brief.overlay.main}*（${ANGLE_LABELS[c.angle]}・${c.format === 'video' ? '動画' : '画像'}${c.explore ? '・探索' : ''}）`,
          `${job.title}｜${job.location}｜${s.type}${formatYen(s.min)}〜`,
          `*見出し* ${brief.headline}`,
          `*本文* ${brief.primaryText.slice(0, 280)}`,
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
