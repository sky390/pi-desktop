/**
 * bash-file-ops.ts — Extract file operations from a bash command string so the
 * Changes panel can record files modified through the bash tool (mkdir / echo >
 * / rm / touch), which the SDK's edit/write tools never see.
 *
 * This is a best-effort heuristic parser: it simulates a small cd chain and
 * recognizes the common shell file-operation forms. It deliberately ignores
 * fd redirects (2>), pipes, and reads. Paths are resolved against the session
 * cwd and the user's home (inferred from the cwd's \\Users\\<name> prefix).
 */

export type BashFileOp =
  | { op: "write"; path: string; append: boolean }
  | { op: "mkdir"; path: string }
  | { op: "remove"; path: string }
  | { op: "touch"; path: string };

export function extractBashFileOps(command: string, cwd: string): BashFileOp[] {
  const ops: BashFileOp[] = [];
  const home = inferHome(cwd);
  let curDir = cwd;

  // Split on &&, ;, |, or newline boundaries (but not || which is a fallback
  // and not part of a compound write). We re-join tokens so quoted spaces stay
  // intact; the split points only matter at the segment level.
  const segments = splitSegments(command);

  for (const raw of segments) {
    const segment = raw.trim();
    if (!segment) continue;

    // cd chain: `cd dir` or `cd dir && ...`
    const cdMatch = segment.match(/^cd(?:\s+(-[A-Za-z]+)\s+)?\s*(.*)$/);
    if (cdMatch && !segment.startsWith("cdrecord")) {
      const target = cdMatch[2]?.trim();
      if (target) {
        const resolved = resolvePath(target, curDir, home);
        if (resolved) curDir = resolved;
      }
      continue;
    }

    // echo/cat/printf/tee "..." >|>> file — a write with a redirect target.
    // The redirect operator must sit OUTSIDE quotes: echo output text may
    // itself contain `>` (e.g. `echo "a -> b"`), which bash treats as literal
    // text but a naive `[^>]*?` scan would mistake for a redirect and record a
    // bogus write to `b"`.
    const writeMatch = segment.match(/(?:^|[;&|]\s*)(?:echo|cat|printf|tee)\b(.*)$/i);
    if (writeMatch && !segment.includes("2>&1") && !segment.includes("2>")) {
      const redirIdx = findRedirectOp(writeMatch[1], 0);
      if (redirIdx !== -1) {
        const after = writeMatch[1].slice(redirIdx);
        const redir = after.match(/^(\d?>>?)/);
        if (redir) {
          const append = redir[1].includes(">>");
          const target = firstToken(after.slice(redir[1].length));
          const resolved = resolvePath(target, curDir, home);
          if (resolved) ops.push({ op: "write", path: resolved, append });
        }
      }
      continue;
    }

    // Generic > / >> redirect (e.g. `some-cmd > file`), same quote-awareness.
    // Only fall through to the mkdir/rm/touch checks when no redirect exists.
    if (!segment.includes("2>&1") && !segment.includes("2>")) {
      const redirIdx = findRedirectOp(segment, 0);
      if (redirIdx !== -1) {
        const after = segment.slice(redirIdx);
        const redir = after.match(/^(\d?>>?)/);
        if (redir) {
          const append = redir[1].includes(">>");
          const target = firstToken(after.slice(redir[1].length));
          const resolved = resolvePath(target, curDir, home);
          if (resolved) ops.push({ op: "write", path: resolved, append });
        }
        continue;
      }
    }

    // mkdir [-p] dir
    const mkdirMatch = segment.match(/^mkdir(?:\s+-[A-Za-z]+)*\s+(.+)$/);
    if (mkdirMatch) {
      const target = firstToken(mkdirMatch[1]);
      const resolved = resolvePath(target, curDir, home);
      if (resolved) ops.push({ op: "mkdir", path: resolved });
      continue;
    }

    // rm [-rf] file
    const rmMatch = segment.match(/^rm(?:\s+-[A-Za-z]+)*\s+(.+)$/);
    if (rmMatch) {
      const target = firstToken(rmMatch[1]);
      const resolved = resolvePath(target, curDir, home);
      if (resolved) ops.push({ op: "remove", path: resolved });
      continue;
    }

    // touch file
    const touchMatch = segment.match(/^touch(?:\s+-[A-Za-z]+)*\s+(.+)$/);
    if (touchMatch) {
      const target = firstToken(touchMatch[1]);
      const resolved = resolvePath(target, curDir, home);
      if (resolved) ops.push({ op: "touch", path: resolved });
      continue;
    }
  }

  return ops;
}

/**
 * Find the first `>` redirect operator at or after `from` that is NOT inside
 * quotes. Echo/printf output text frequently contains literal `>` characters
 * (e.g. `echo "a -> b"`), and only an unquoted `>` acts as a shell redirect.
 * Returns -1 when there is no unquoted redirect in the text.
 */
function findRedirectOp(text: string, from: number): number {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ">") return i;
  }
  return -1;
}

/** Split on && / ; / | / newline, keeping quoted whitespace intact. */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let prev = "";
  for (const ch of command) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "&" && prev === "&") {
      segments.push(current.slice(0, -1));
      current = "";
      prev = "";
      continue;
    }
    if (ch === "|" && prev === "|") {
      // logical OR — not a pipeline; treat as boundary
      segments.push(current.slice(0, -1));
      current = "";
      prev = "";
      continue;
    }
    if ((ch === "|" && prev !== "|") || ch === ";") {
      segments.push(current);
      current = "";
      prev = "";
      continue;
    }
    if (ch === "\n") {
      segments.push(current);
      current = "";
      prev = "";
      continue;
    }
    current += ch;
    prev = ch;
  }
  if (current.trim()) segments.push(current);
  return segments;
}

function firstToken(value: string): string {
  return stripQuotes(value.trim().split(/\s+/)[0] ?? "");
}

function stripQuotes(value: string): string {
  return value
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2")
    .replace(/^~/, "~"); // keep ~ for resolvePath
}

function inferHome(cwd: string): string {
  const match = cwd.match(/^([A-Za-z]:\\Users\\[^\\]+)/);
  return match ? match[1] : cwd;
}

function resolvePath(raw: string, curDir: string, home: string): string | null {
  let value = stripQuotes(raw);
  if (!value) return null;
  // Strip trailing punctuation that is not part of the path (e.g. `;` handled
  // earlier, but `file &&` may leave a trailing && removed already).
  value = value.replace(/[;&|]+$/, "").trim();
  if (!value) return null;
  // Shell glob patterns (e.g. `rm -rf *.txt`, `echo hi > logs-*.log`) expand
  // to many files; never record the pattern itself as a literal path.
  if (/[*?]/.test(value)) return null;

  if (value === "~") return home;
  if (value.startsWith("~/")) return joinPath(home, value.slice(2));
  if (value.startsWith("~\\")) return joinPath(home, value.slice(2));

  // msys path: /c/Users/... -> C:\Users\...
  const msys = value.match(/^\/([a-zA-Z])\/(.*)$/);
  if (msys) return `${msys[1].toUpperCase()}:\\${msys[2].replace(/\//g, "\\")}`;

  // Windows absolute path.
  if (/^[A-Za-z]:[\\/]/.test(value)) return value.replace(/\//g, "\\");

  // Relative — resolve against current dir.
  return joinPath(curDir, value);
}

function joinPath(base: string, relative: string): string {
  const normalized = relative.replace(/\//g, "\\").replace(/^[\\/]+/, "");
  const parts = normalized.split("\\").filter((p) => p && p !== ".");
  const stack = base.replace(/\//g, "\\").split("\\");
  for (const part of parts) {
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("\\");
}
