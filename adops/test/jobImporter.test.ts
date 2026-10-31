import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptedLlm } from '../src/llm/llm.ts';
import { importJob } from '../src/agents/jobImporter.ts';
import { validateCatalog } from '../src/config.ts';
import { catalog, persona } from './fixtures.ts';

test('importJob: ID を整え、未知のペルソナを除き、停止状態で返す', async () => {
  const llm = new ScriptedLlm().on('jobImporter', () => ({
    id: 'Factory Aichi!!',
    title: '製造スタッフ',
    category: '製造',
    location: '愛知県豊田市',
    employmentType: '派遣社員',
    salary: { type: '時給', min: 1500, max: 0, note: '' },
    perks: ['寮費無料'],
    hours: '',
    holidays: '土日休み',
    requirements: '',
    personas: ['p1', 'unknown'],
    landingUrl: '',
    warnings: ['求人票に「40歳まで」とあるが広告には使わない'],
  }));
  const { job, warnings } = await importJob(llm, '求人票本文', [persona()]);
  assert.equal(job.id, 'factory-aichi');
  assert.equal(job.active, false);
  assert.deepEqual(job.personas, ['p1']);
  assert.equal(job.salary.max, undefined);
  assert.equal(job.hours, undefined);
  assert.ok(warnings.some((w) => w.includes('40歳')));
  assert.ok(warnings.some((w) => w.includes('landingUrl')));
  // URL を入れれば設定検証も通る
  job.landingUrl = 'https://example.com/j';
  assert.doesNotThrow(() => validateCatalog({ ...catalog(), jobs: [job] }));
});
