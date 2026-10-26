import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBrief, checkPayClaims, extractPayClaims, googleWidth, hasBlocker } from '../src/compliance/rules.ts';
import { brand, brief, job } from './fixtures.ts';

test('給与表記を円に直して取り出す', () => {
  assert.deepEqual(
    extractPayClaims('月給30万円〜、日給1万2000円、時給1,500円、年収500万').map((c) => [c.type, c.yen]),
    [
      ['月給', 300000],
      ['日給', 12000],
      ['時給', 1500],
      ['年収', 5000000],
    ],
  );
  assert.deepEqual(extractPayClaims('月給３５万円').map((c) => c.yen), [350000]);
  assert.deepEqual(extractPayClaims('月給30.5万円').map((c) => c.yen), [305000]);
});

test('求人の上限を超える給与は blocker', () => {
  const j = job();
  assert.equal(checkPayClaims('月給38万円', j).length, 0);
  const over = checkPayClaims('月給45万円も可能', j);
  assert.equal(over.length, 1);
  assert.equal(over[0].severity, 'blocker');
});

test('給与形態と違う単位の金額は major', () => {
  const issues = checkPayClaims('年収450万円', job());
  assert.equal(issues[0].severity, 'major');
});

test('問題のない企画は blocker なし', () => {
  const issues = checkBrief(brief(), job(), brand());
  assert.equal(hasBlocker(issues), false, JSON.stringify(issues));
});

test('年齢制限・性別限定は blocker', () => {
  for (const text of ['35歳まで歓迎', '20代限定の募集', '男性歓迎！', '若い方募集']) {
    const issues = checkBrief(brief({ headline: text }), job(), brand());
    assert.ok(hasBlocker(issues), `${text} が blocker になっていない`);
  }
});

test('「○代活躍中」は minor の注意にとどめる', () => {
  const issues = checkBrief(brief({ headline: '40代も活躍中' }), job(), brand());
  assert.equal(hasBlocker(issues), false);
  assert.ok(issues.some((i) => i.severity === 'minor' && i.field === 'headline'));
});

test('成果保証・個人属性の示唆は blocker', () => {
  assert.ok(hasBlocker(checkBrief(brief({ primaryText: '必ず稼げる仕事です' }), job(), brand())));
  assert.ok(hasBlocker(checkBrief(brief({ hook: '借金がある人でもOK' }), job(), brand())));
});

test('求人に無い待遇は blocker（虚偽表示）', () => {
  const j = job({ perks: ['未経験歓迎'], holidays: 'シフト制' });
  const issues = checkBrief(brief({ overlay: { main: '寮費無料で働ける', sub: '', badges: [] } }), j, brand());
  assert.ok(issues.some((i) => i.severity === 'blocker' && i.problem.includes('寮費無料')));
  const ok = checkBrief(brief({ overlay: { main: '寮費無料で働ける', sub: '', badges: [] } }), job(), brand());
  assert.ok(!ok.some((i) => i.problem.includes('寮費無料')));
});

test('最上級表現・社内NG表現は major', () => {
  const issues = checkBrief(brief({ description: '業界No.1の待遇。誰でも簡単' }), job(), brand());
  assert.ok(issues.some((i) => i.severity === 'major' && i.problem.includes('最上級')));
  assert.ok(issues.some((i) => i.problem.includes('社内NG')));
});

test('画像プロンプトの日本語・no text 抜けを指摘する', () => {
  const issues = checkBrief(brief({ imagePrompt: '工場で働く人' }), job(), brand());
  assert.ok(issues.some((i) => i.field === 'imagePrompt' && i.severity === 'major'));
  assert.ok(issues.some((i) => i.field === 'imagePrompt' && i.problem.includes('no text')));
});

test('動画の尺とカット数を確認する', () => {
  const issues = checkBrief(brief({ format: 'video', storyboard: [{ seconds: 3, text: 'a', visual: 'b' }] }), job(), brand());
  assert.ok(issues.some((i) => i.field === 'storyboard' && i.severity === 'major'));
});

test('Google の文字数は全角を2で数える', () => {
  assert.equal(googleWidth('abc'), 3);
  assert.equal(googleWidth('寮費0円'), 7);
  assert.equal(googleWidth('ｱｲｳ'), 3);
});
