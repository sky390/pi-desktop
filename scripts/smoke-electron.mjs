#!/usr/bin/env node
/**
 * Smoke test: launch Electron and a hidden renderer, connect to the Host over
 * MessagePort, and verify
 * ping, sessions, Worktree conflict handling, Git status, directory watching,
 * exact binary download, and safe Skill editing.
 */
import { spawn, spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const main = path.join(root, ".artifacts", "smoke", "main.js");

const build = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["tsup", "--config", "tsup.smoke.config.ts"],
  { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
);
if (build.status !== 0) process.exit(build.status ?? 1);

if (!existsSync(main)) {
  console.error("Build first: npm run build");
  process.exit(1);
}

const electronBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");

const child = spawn(electronBin, [main], {
  cwd: root,
  env: {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
  },
  stdio: "inherit",
  // .cmd shims are not directly spawnable on Windows (spawn EINVAL).
  shell: process.platform === "win32",
});

const timer = setTimeout(() => {
  console.error("smoke timeout");
  child.kill();
  process.exit(1);
}, 45_000);

child.on("exit", (code) => {
  clearTimeout(timer);
  // The Electron process holds Windows handles on the smoke workspace until it
  // fully exits (EPERM while alive), so remove the temp dirs from here instead.
  const tempRoot = tmpdir();
  try {
    for (const entry of readdirSync(tempRoot)) {
      if (entry.startsWith("pi-desktop-smoke-")) {
        rmSync(path.join(tempRoot, entry), { recursive: true, force: true });
      }
    }
  } catch {
    /* best effort */
  }
  process.exit(code ?? 1);
});
