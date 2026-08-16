import assert from "node:assert/strict";
import test from "node:test";

import {
  filterSessionsForQuery,
  getSessionDisplayTitle,
  resolveInitialSessionRestore,
  sessionDateGroup,
} from "./session-list.ts";

function session(id, overrides = {}) {
  return {
    id,
    name: "",
    firstMessage: "",
    cwd: "/workspace/pi-desktop",
    modified: "2026-07-15T12:00:00.000Z",
    messageCount: 1,
    ...overrides,
  };
}

test("groups sessions into calendar-aware recency buckets", () => {
  const now = new Date("2026-07-15T18:00:00.000Z");
  // Buckets follow the local calendar (sessionDateGroup uses local time), so
  // build timestamps from local date components to stay timezone-independent.
  const localTime = (dayOffset, hour) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour).toISOString();
  assert.equal(sessionDateGroup(localTime(0, 9), now), "today");
  assert.equal(sessionDateGroup(localTime(-3, 9), now), "recent");
  assert.equal(sessionDateGroup(localTime(-20, 9), now), "older");
  assert.equal(sessionDateGroup("invalid", now), "older");
});

test("searches useful session metadata and retains matching ancestors", () => {
  const parent = session("parent", { name: "Root session" });
  const child = session("child", {
    parentSessionId: "parent",
    firstMessage: "Investigate keyboard navigation",
    worktreeBranch: "codex/accessibility",
  });
  const unrelated = session("other", { firstMessage: "Unrelated task", cwd: "/workspace/other" });

  assert.deepEqual(
    filterSessionsForQuery([parent, child, unrelated], "keyboard").map((item) => item.id),
    ["parent", "child"],
  );
  assert.deepEqual(
    filterSessionsForQuery([parent, child, unrelated], "ACCESSIBILITY").map((item) => item.id),
    ["parent", "child"],
  );
  assert.deepEqual(
    filterSessionsForQuery([parent, child, unrelated], "/workspace/other").map((item) => item.id),
    ["other"],
  );
});

test("builds stable compact titles from names, prompts, and ids", () => {
  assert.equal(getSessionDisplayTitle(session("id", { name: "  Named session  " })), "Named session");
  assert.equal(
    getSessionDisplayTitle(session("id", { firstMessage: "Investigate\n  keyboard   navigation" })),
    "Investigate keyboard navigation",
  );
  assert.equal(getSessionDisplayTitle(session("fallback-id")), "fallback-id");
  assert.equal(
    getSessionDisplayTitle(session("id", { firstMessage: "A long title for truncation" }), 12),
    "A long titl…",
  );
});

test("initial session restore waits for a successful list result", () => {
  assert.deepEqual(resolveInitialSessionRestore([], "missing", true, false, false), { status: "wait" });
  assert.deepEqual(resolveInitialSessionRestore([], "missing", false, true, false), { status: "wait" });
});

test("a successfully loaded empty list completes the not-found restore path", () => {
  assert.deepEqual(resolveInitialSessionRestore([], "missing", false, false, false), { status: "not-found" });
  assert.deepEqual(resolveInitialSessionRestore([], "missing", false, false, true), { status: "none" });
});

test("initial session restore returns the matching session", () => {
  const target = session("target");
  assert.deepEqual(resolveInitialSessionRestore([session("other"), target], "target", false, false, false), {
    status: "restore",
    session: target,
  });
});
