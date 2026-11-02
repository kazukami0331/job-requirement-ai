import { test } from "node:test";
import assert from "node:assert/strict";
import { runHandlesFeedback } from "./github.ts";

test("runHandlesFeedback: 依頼を反映して制作・入稿まで行う実行だけを数える", () => {
  assert.equal(runHandlesFeedback("adops schedule 0 21 * * *"), true);
  assert.equal(runHandlesFeedback("adops feedback,produce,publish,report"), true);
  assert.equal(runHandlesFeedback("adops lp feedback,produce,publish"), true);
  assert.equal(runHandlesFeedback("adops cycle"), true);
  assert.equal(runHandlesFeedback("adops schedule 30 0-12 * * *"), false, "応募通知");
  assert.equal(runHandlesFeedback("adops schedule 0 3,9 * * *"), false, "日中の停止判断");
  assert.equal(runHandlesFeedback("adops control resume"), false);
  assert.equal(runHandlesFeedback("adops lp,report"), false);
});
