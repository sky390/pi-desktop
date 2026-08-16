import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("renderer loads KaTeX CSS from the installed package and Inter/Noto fonts via CDN", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
  const katexCss = readFileSync(new URL("../../node_modules/katex/dist/katex.min.css", import.meta.url), "utf8");

  assert.match(html, /fonts\.googleapis\.com/);
  assert.match(html, /family=Inter/);
  assert.match(main, /import\s+["']katex\/dist\/katex\.min\.css["']/);
  assert.match(katexCss, /@font-face/);
  assert.match(katexCss, /url\(fonts\/KaTeX_[^)]+\.woff2\)/);
});

test("production renderer CSP permits packaged styles plus Google Fonts and KaTeX CDN", () => {
  const protocol = readFileSync(new URL("../main/protocol.ts", import.meta.url), "utf8");
  const appCsp = protocol.slice(protocol.indexOf("const CSP ="), protocol.indexOf("const HTML_PREVIEW_CSP"));

  assert.match(appCsp, /fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net/);
  assert.match(appCsp, /style-src 'self' app:/);
  assert.match(appCsp, /font-src 'self' app: data:/);
});
