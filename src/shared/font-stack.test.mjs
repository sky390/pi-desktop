import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { APP_MONO_FONT_FAMILY, APP_SANS_FONT_FAMILY } from "./font-stack.ts";

function cssCustomProperty(source, property) {
  const match = source.match(new RegExp(`${property}:\\s*([^;]+);`));
  assert.ok(match, `Missing ${property}`);
  return match[1].replace(/\s+/g, " ").trim();
}

test("renderer CSS uses the Inter-first UI font stacks and shared fallbacks", () => {
  const css = readFileSync(new URL("../renderer/globals.css", import.meta.url), "utf8");

  const sans = cssCustomProperty(css, "--font-sans");
  const mono = cssCustomProperty(css, "--font-mono");
  // The desktop UI prefers Inter/Noto Sans Mono (loaded via Google Fonts in
  // index.html); the shared stacks keep the CJK/system fallbacks for Windows.
  assert.match(sans, /var\(--font-inter\)/);
  assert.match(sans, /Microsoft YaHei/);
  assert.match(sans, /PingFang SC/);
  assert.match(mono, /var\(--font-noto-mono\)/);
  assert.match(mono, /Microsoft YaHei/);
  // The shared stacks still carry CJK fallbacks for non-UI surfaces.
  assert.match(APP_SANS_FONT_FAMILY, /Microsoft YaHei/);
  assert.match(APP_SANS_FONT_FAMILY, /PingFang SC/);
  assert.match(APP_SANS_FONT_FAMILY, /Noto Sans CJK SC/);
});
