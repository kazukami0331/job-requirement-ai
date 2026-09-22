// Rules.gs / Jobs.gs は GAS のグローバルスコープ前提で書かれているため、
// vm で同じコンテキストに読み込んでから module.exports を取り出す。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src");

const context = { module: { exports: {} }, console };
context.globalThis = context;
vm.createContext(context);

for (const file of ["Jobs.gs", "Rules.gs"]) {
  vm.runInContext(fs.readFileSync(path.join(srcDir, file), "utf8"), context, {
    filename: file,
  });
}

export const rules = context.module.exports;
export const jobs = context.JOBS;
