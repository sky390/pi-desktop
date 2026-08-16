import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
const { extractBashFileOps } = await importTestBundle("src/renderer/lib/bash-file-ops", {
  entryPoints: [path.join(import.meta.dirname, "bash-file-ops.ts")],
});

const CWD = "C:\\Users\\test\\project";
const at = (p) => `${CWD}\\${p}`;

test("echo output text containing `->` inside quotes is not a redirect", () => {
  const ops = extractBashFileOps('echo "[主目录] root-modify.txt → 修改 (v1 -> v2)"', CWD);
  assert.deepEqual(ops, []);
});

test("quoted `>` text does not shadow a later real redirect target", () => {
  const ops = extractBashFileOps('echo "修改 (v1 -> v2)" > real.txt', CWD);
  assert.deepEqual(ops, [{ op: "write", path: at("real.txt"), append: false }]);
});

test("plain echo redirect still records a write", () => {
  const ops = extractBashFileOps('echo "hello" > a.txt', CWD);
  assert.deepEqual(ops, [{ op: "write", path: at("a.txt"), append: false }]);
});

test("append redirect is recorded with append flag", () => {
  const ops = extractBashFileOps('echo "a -> b" >> log.txt', CWD);
  assert.deepEqual(ops, [{ op: "write", path: at("log.txt"), append: true }]);
});

test("generic command redirect records a write", () => {
  const ops = extractBashFileOps("node script.js > out.log", CWD);
  assert.deepEqual(ops, [{ op: "write", path: at("out.log"), append: false }]);
});

test("fd redirect 2> makes the whole segment conservatively skipped", () => {
  const ops = extractBashFileOps("echo err 2> err.log > out.txt", CWD);
  assert.deepEqual(ops, []);
});

test("mkdir / rm / touch are still recognized after the redirect refactor", () => {
  const ops = extractBashFileOps("mkdir -p src/components && rm -rf old.txt && touch new.txt", CWD);
  assert.deepEqual(ops, [
    { op: "mkdir", path: at("src\\components") },
    { op: "remove", path: at("old.txt") },
    { op: "touch", path: at("new.txt") },
  ]);
});

test("cd chain resolves write targets relative to the new directory", () => {
  const ops = extractBashFileOps("cd sub && echo x > f.txt", CWD);
  assert.deepEqual(ops, [{ op: "write", path: at("sub\\f.txt"), append: false }]);
});

test("quoted `>` inside a longer echo line with no redirect yields no ops", () => {
  const ops = extractBashFileOps('echo "Card.tsx → 修改 (v1 -> v2)"', CWD);
  assert.deepEqual(ops, []);
});

test("shell glob patterns are not recorded as literal paths", () => {
  const ops = extractBashFileOps("rm -rf *.txt logs-?.log", CWD);
  assert.deepEqual(ops, []);
});

test("glob redirect target is skipped", () => {
  const ops = extractBashFileOps("echo hi > logs-*.log", CWD);
  assert.deepEqual(ops, []);
});

test("plain rm without glob is still recorded", () => {
  const ops = extractBashFileOps("rm -rf old.txt", CWD);
  assert.deepEqual(ops, [{ op: "remove", path: at("old.txt") }]);
});
