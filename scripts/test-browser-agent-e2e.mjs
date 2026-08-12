#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Keep the ESM Host bundle under the project root so its external production
// dependencies resolve through this checkout's node_modules directory.
const temp = fs.mkdtempSync(path.join(root, ".browser-agent-e2e-build-"));
const hostOutfile = path.join(temp, "browser-agent-host.mjs");
const mainOutfile = path.join(temp, "browser-agent-e2e-harness.cjs");
const esbuild = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild");

function build(entry, outfile, format, externals) {
  const result = spawnSync(
    esbuild,
    [
      entry,
      "--bundle",
      "--platform=node",
      "--packages=external",
      `--format=${format}`,
      ...externals.map((external) => `--external:${external}`),
      `--outfile=${outfile}`,
    ],
    // .cmd shims are not directly spawnable on Windows (spawn EINVAL).
    { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (result.status !== 0) throw new Error(`esbuild failed for ${entry}`);
}

try {
  build("src/smoke/browser-agent-host.ts", hostOutfile, "esm", [
    "electron",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "silk-wasm",
  ]);
  build("src/smoke/browser-agent-e2e-harness.ts", mainOutfile, "cjs", ["electron"]);

  const electronBinary = path.join(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron.cmd" : "electron",
  );
  const child = spawn(electronBinary, [mainOutfile], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      PI_BROWSER_AGENT_E2E_HOST_ENTRY: hostOutfile,
    },
    // .cmd shims are not directly spawnable on Windows (spawn EINVAL).
    shell: process.platform === "win32",
  });
  const status = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error("Browser Agent E2E harness timed out");
      child.kill();
      resolve(1);
    }, 90_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      console.error(error);
      resolve(1);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
  // The harness holds Windows handles on its workspace until exit; clean up
  // only after the process is gone.
  try {
    const tempRoot = os.tmpdir();
    for (const entry of fs.readdirSync(tempRoot)) {
      if (entry.startsWith("pi-browser-agent-e2e-")) {
        fs.rmSync(path.join(tempRoot, entry), { recursive: true, force: true });
      }
    }
  } catch {
    /* best effort */
  }
  process.exitCode = status;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
