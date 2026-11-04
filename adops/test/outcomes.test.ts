import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateOutcomes, parseCsv } from '../src/pipeline/outcomes.ts';

test('parseCsv: 引用符・カンマ・改行・BOM に対応', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x,1","he said ""hi"""\n\n'), [
    ['a', 'b'],
    ['x,1', 'he said "hi"'],
  ]);
});

test('aggregateOutcomes: 応募者ごとに最も進んだ段階で数え、前段にも計上する', () => {
  const csv = [
    '企画ID,応募者ID,ステータス,日付',
    'br_1,c1,応募,2026-10-01',
    'br_1,c1,面接,2026-10-03',
    'br_1,c1,入社,2026-10-20',
    'br_1,c2,応募,2026-10-02',
    'br_2,c3,内定,2026-10-05',
    'br_2,,interview,2026-10-05',
    'xx,c9,応募,2026-10-05',
    'br_3,c4,不明,2026-10-05',
  ].join('\n');
  const { byBrief, skipped } = aggregateOutcomes(csv);
  assert.deepEqual(byBrief.get('br_1'), { applied: 2, interview: 1, offer: 1, hired: 1 });
  assert.deepEqual(byBrief.get('br_2'), { applied: 2, interview: 2, offer: 1, hired: 0 });
  assert.equal(skipped, 2);
});

test('aggregateOutcomes: 必須列が無ければエラー', () => {
  assert.throws(() => aggregateOutcomes('name,stage\na,応募'), /utm_content/);
});
