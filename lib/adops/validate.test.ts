import { test } from "node:test";
import assert from "node:assert/strict";
import { lines, num, validateHypotheses, validateJobs, validateRubric } from "./validate.ts";

const job = { id: "factory", title: "製造", landingUrl: "https://x.jp", salary: { min: 300000 }, personas: ["p1"] };

test("validateJobs: 必須・URL・給与・ペルソナ・重複", () => {
  assert.deepEqual(validateJobs([job], ["p1"]), []);
  assert.match(validateJobs([{ ...job, salary: { min: 0 } }], ["p1"]).join(), /給与の下限/);
  assert.match(validateJobs([{ ...job, applyUrl: "javascript:alert(1)" }], ["p1"]).join(), /応募フォーム/);
  assert.match(validateJobs([{ ...job, personas: ["zz"] }], ["p1"]).join(), /未定義のペルソナ/);
  assert.match(validateJobs([job, job], ["p1"]).join(), /重複/);
  assert.match(validateJobs([{ ...job, id: "Bad ID" }], ["p1"]).join(), /英小文字/);
  assert.match(validateJobs([{ ...job, salary: { min: 300000, max: 200000 } }], ["p1"]).join(), /上限/);
});

test("validateHypotheses / validateRubric", () => {
  const h = { id: "h1", personaId: "p1", angle: "pay", title: "t", message: "m" };
  assert.deepEqual(validateHypotheses([h], ["p1"], ["factory"]), []);
  assert.match(validateHypotheses([{ ...h, angle: "x" }], ["p1"], []).join(), /訴求軸/);
  assert.match(validateHypotheses([{ ...h, jobIds: ["nope"] }], ["p1"], ["factory"]).join(), /未定義の求人/);
  assert.deepEqual(validateRubric({ version: "v1", items: [{ id: "a", label: "A", description: "d" }] }), []);
  assert.match(validateRubric({ version: "v1", items: [{ id: "a", label: "A", description: "d", appliesWhen: "hypothesis" }] }).join(), /仮説専用/);
  assert.match(validateRubric({ version: "", items: [] }).join(), /版/);
});

test("lines / num", () => {
  assert.deepEqual(lines(" a \n\n b\r\n"), ["a", "b"]);
  assert.equal(num("300,000円"), 300000);
  assert.equal(num(""), undefined);
  assert.ok(Number.isNaN(num("abc")));
});
