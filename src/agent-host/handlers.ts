/**
 * Register all Api handlers on the RPC server.
 * Implements the desktop RPC contract in the Agent Host process.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { execSync } from "child_process";
import { ProxyAgent } from "undici";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import { homedir, tmpdir } from "os";
import { applyProxyEnvVars, configureProxyDispatcher } from "./proxy-config";
import path from "path";
import { createHash, randomUUID } from "crypto";
import {
  DefaultResourceLoader,
  CredentialSynchronizationError,
  ModelRuntime,
  SessionManager,
  createAgentSessionServices,
  getAgentDir,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type AuthInteraction } from "@earendil-works/pi-ai";
import {
  getLegacyProviderModelFiltersPath,
  patternMatchesModel,
  readAgentSettingsModelFilterMap,
  readDesktopModelFilterMap,
  readEnabledModelPatterns,
  readLegacyDesktopSettingsFilters,
  readLegacyProviderModelFilters,
  readProviderModelFilters,
  repairEnabledModelsMirror,
  writeProviderModelFilters,
} from "./provider-model-filters";
import type { RpcServer } from "../contract/rpc";
import {
  RpcError,
  type BuiltinModelInfo,
  type HistoryWindow,
  type ModelCatalogStatus,
  type ModelCatalogWarning,
  ModelsListResult,
  type SessionDetail,
  type SessionRuntimeState,
} from "../contract/types";
import type { SessionTreeNode } from "../shared/types";
import { allowFileRoot, getAllowedFileRoots, isFilePathAllowed } from "./file-access";
import {
  activateSession,
  forceRunningChange,
  disposeAllRpcSessions,
  getRpcSession,
  getRunningRpcSessionIds,
  startRpcSession,
  subscribeRunningSessions,
} from "./rpc-manager";
import {
  buildSessionContext,
  buildSessionInfoFromManager,
  getSessionIndexMetrics,
  invalidateAllSessionPathCache,
  invalidateSessionPathCache,
  listAllSessions,
  resolveSessionPath,
} from "./session-reader";
import { restartSessionWatcher } from "./session-watcher";
// Re-exported so the esbuild-bundled test module can stop the watcher that a
// host.refresh restarts (the watcher keeps the process alive if left open).
export { stopSessionWatcher } from "./session-watcher";
import { isFilePathReferencedBySession } from "./session-file-references";
import {
  addWorktree,
  getGitStatus,
  isDirtyWorktreeError,
  listGitFiles,
  listWorktrees,
  removeWorktree,
  resolveProject,
} from "../shared/worktree";
import { buildEntriesFromFiles, filterFileEntries } from "../shared/file-fuzzy";
import {
  DOCX_PREVIEW_MAX_BYTES,
  FILE_DOWNLOAD_MAX_BYTES,
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  documentPreviewKind,
  getAudioMime,
  getDocumentMime,
  getImageMime,
} from "../shared/file-types";
import { createFileWatchService, stopAllFileWatches } from "./file-watch";
import { callMain } from "./parent-rpc";
import { createAuthLoginService, resolveLoginCode } from "./auth-login";
import { getSharedModelRuntime, modelCatalogRefreshCoordinator, reloadSharedModelRuntimeConfig } from "./model-runtime";
import { applyPluginAction, readPlugins } from "./plugins-service";
import { installSkill, searchSkills } from "./skills-service";
import { updateSkillModelInvocation } from "./skill-frontmatter";
import { projectSessionTreeForResponse } from "./project-tree";
import { ChannelManager } from "./channels/channel-manager";
import { safeChannelError } from "./channels/redaction";
import { ToolchainError } from "../shared/toolchains/errors";
import { toolchainRuntime } from "./toolchain-runtime";
import {
  logSessionPerformance,
  resolveSessionTraceId,
  roundSessionMilliseconds,
  sessionPerformanceBytesEnabled,
} from "./session-performance";
import {
  buildHistoryRevision,
  buildSessionHistoryPage,
  decodeHistoryCursor,
  readSessionEntryContent,
  StaleHistoryCursorError,
} from "./session-history";
import { getSessionContentSnapshot, invalidateSessionContent } from "./session-content-cache";
import { sessionIndex } from "./session-index";
import { credentialStateMatches, recoverCommittedCredential, type CredentialTarget } from "./credential-sync";

const IGNORED_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".turbo",
  ".cache",
  "coverage",
  ".pytest_cache",
  ".mypy_cache",
  "target",
  "vendor",
  ".DS_Store",
]);

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  less: "css",
  json: "json",
  jsonl: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  md: "markdown",
  mdx: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  sql: "sql",
  txt: "text",
};

function getLanguage(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "bash";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  const ext = base.split(".").pop() ?? "";
  return EXT_TO_LANGUAGE[ext] ?? "text";
}

async function emitIndexedSessionChange(server: RpcServer, sessionId: string, cwd: string | null): Promise<void> {
  try {
    const filePath = await resolveSessionPath(sessionId);
    const session = filePath ? await sessionIndex.refreshPath(filePath) : null;
    if (session) {
      server.emit("sessions.changed", session.id, { cwd: session.cwd, sessionId: session.id, session });
      return;
    }
  } catch (error) {
    console.error("[agent-host] failed to refresh changed session:", error);
  }
  server.emit("sessions.changed", "*", { cwd, fullRefresh: true });
}

async function assertPathAllowed(target: string, sourceSessionId?: string): Promise<void> {
  const allowed = await getAllowedFileRoots();
  if (isFilePathAllowed(target, allowed)) return;
  if (sourceSessionId && (await isFilePathReferencedBySession(target, sourceSessionId))) return;
  throw new RpcError({ code: "FORBIDDEN", message: "Access denied" });
}

function getModelsPath(): string {
  return path.join(getAgentDir(), "models.json");
}

function withHttpScheme(value: string): string {
  const v = value.trim();
  if (!v) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`;
}

/** Build a proxy URL, bracketing IPv6 hosts so the result is a valid URL. */
function formatProxyUrl(hostValue: string, port: string | undefined): string {
  const host = hostValue.trim();
  if (!host) return "";
  const hostWithBrackets = host.includes(":") && !/^\[.*\]$/.test(host) ? `[${host}]` : host;
  return withHttpScheme(`${hostWithBrackets}${port ? `:${port}` : ""}`);
}

/**
 * Parse `scutil --proxy` output. Values are matched case-insensitively and
 * trimmed; `<NULL>` and missing/zero ports are treated as absent. A PAC-only
 * configuration is reported as disabled: the PAC URL is a script, not a usable
 * HTTP(S) proxy endpoint, and would only produce a broken proxy URL.
 */
export function parseScutilProxyOutput(output: string): { httpProxy: string; httpsProxy: string; enabled: boolean } {
  const value = (name: string): string | undefined => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^\\s*${escaped}\\s*:\\s*(.+?)\\s*$`, "im").exec(output);
    if (!match) return undefined;
    const raw = match[1].trim();
    return raw === "<NULL>" ? undefined : raw;
  };
  const port = (name: string): string | undefined => {
    const p = value(name);
    if (!p) return undefined;
    const n = Number(p);
    return Number.isFinite(n) && n > 0 ? String(n) : undefined;
  };
  const enabledFlag = (name: string): boolean => value(name) === "1";

  if (enabledFlag("ProxyAutoConfigEnable")) {
    return { httpProxy: "", httpsProxy: "", enabled: false };
  }

  const httpProxy =
    enabledFlag("HTTPEnable") && value("HTTPProxy")
      ? formatProxyUrl(value("HTTPProxy") as string, port("HTTPPort"))
      : "";
  const httpsProxy =
    enabledFlag("HTTPSEnable") && value("HTTPSProxy")
      ? formatProxyUrl(value("HTTPSProxy") as string, port("HTTPSPort"))
      : "";
  const enabled = !!(httpProxy || httpsProxy);
  return { httpProxy, httpsProxy: httpsProxy || httpProxy, enabled };
}

/**
 * Parse the Windows "ProxyServer" value. Supports both the per-protocol form
 * (`http=host:port;https=host:port;ftp=...`) and the legacy form
 * (`host:port` or `host:port;secure=other:port`). Only HTTP(S) entries are used.
 */
export function parseProxyServerString(server: string): { httpProxy: string; httpsProxy: string; enabled: boolean } {
  if (!server) return { httpProxy: "", httpsProxy: "", enabled: false };
  let http = "";
  let https = "";
  for (const rawPart of server.split(";")) {
    const part = rawPart.trim();
    if (!part) continue;
    const secureMatch = /^secure=(.*)$/i.exec(part);
    if (secureMatch) {
      https = withHttpScheme(secureMatch[1]);
      continue;
    }
    const protocolMatch = /^([a-z]+)=(.*)$/i.exec(part);
    if (protocolMatch) {
      const protocol = protocolMatch[1].toLowerCase();
      if (protocol === "http") http = withHttpScheme(protocolMatch[2]);
      else if (protocol === "https") https = withHttpScheme(protocolMatch[2]);
      continue;
    }
    if (!http) http = withHttpScheme(part);
  }
  const enabled = !!(http || https);
  return { httpProxy: http, httpsProxy: https || http, enabled };
}

/** Resolve the OS-level proxy (env vars, Windows registry, macOS scutil, GNOME gsettings). */
export function readSystemProxySettings(): { httpProxy: string; httpsProxy: string; enabled: boolean } {
  const envHttp = process.env.HTTP_PROXY || process.env.http_proxy || "";
  const envHttps = process.env.HTTPS_PROXY || process.env.https_proxy || "";
  if (envHttp || envHttps) {
    return { httpProxy: envHttp, httpsProxy: envHttps || envHttp, enabled: true };
  }
  if (process.platform === "win32") {
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    try {
      const enableOut = execSync(`reg query "${key}" /v ProxyEnable`, { encoding: "utf8", windowsHide: true });
      const enableMatch = /0x([0-9a-fA-F]+)/.exec(enableOut);
      if (!enableMatch || parseInt(enableMatch[1], 16) === 0) {
        return { httpProxy: "", httpsProxy: "", enabled: false };
      }
      const serverOut = execSync(`reg query "${key}" /v ProxyServer`, { encoding: "utf8", windowsHide: true });
      const serverMatch = /ProxyServer\s+REG_SZ\s+(.+)$/m.exec(serverOut);
      if (!serverMatch) return { httpProxy: "", httpsProxy: "", enabled: false };
      return parseProxyServerString(serverMatch[1].trim());
    } catch {
      return { httpProxy: "", httpsProxy: "", enabled: false };
    }
  }
  if (process.platform === "darwin") {
    try {
      const out = execSync("scutil --proxy", { encoding: "utf8" });
      return parseScutilProxyOutput(out);
    } catch {
      return { httpProxy: "", httpsProxy: "", enabled: false };
    }
  }
  if (process.platform === "linux") {
    try {
      const mode = execSync("gsettings get org.gnome.system.proxy mode", { encoding: "utf8" }).trim();
      if (mode !== "'manual'") return { httpProxy: "", httpsProxy: "", enabled: false };
      const host = execSync("gsettings get org.gnome.system.proxy.http host", { encoding: "utf8" })
        .trim()
        .replace(/^'|'$/g, "");
      const port = execSync("gsettings get org.gnome.system.proxy.http port", { encoding: "utf8" }).trim();
      if (!host) return { httpProxy: "", httpsProxy: "", enabled: false };
      const http = formatProxyUrl(host, port && port !== "0" ? port : undefined);
      const httpsHost = execSync("gsettings get org.gnome.system.proxy.https host", { encoding: "utf8" })
        .trim()
        .replace(/^'|'$/g, "");
      const httpsPort = execSync("gsettings get org.gnome.system.proxy.https port", { encoding: "utf8" }).trim();
      const https = httpsHost
        ? formatProxyUrl(httpsHost, httpsPort && httpsPort !== "0" ? httpsPort : undefined)
        : http;
      return { httpProxy: http, httpsProxy: https, enabled: true };
    } catch {
      return { httpProxy: "", httpsProxy: "", enabled: false };
    }
  }
  return { httpProxy: "", httpsProxy: "", enabled: false };
}

export interface ProxyProbeResult {
  protocol: "http" | "https";
  ok: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
}

const PROXY_TEST_TIMEOUT_MS = 8_000;

/** Targets used to prove a proxy can actually carry traffic. */
export const PROXY_TEST_TARGETS = [
  { protocol: "https" as const, url: "https://api.openai.com/v1/models" },
  { protocol: "http" as const, url: "http://www.msftconnecttest.com/connecttest.txt" },
];

export async function runProxyProbe(
  protocol: "http" | "https",
  url: string,
  proxyUrl: string,
  timeoutMs = PROXY_TEST_TIMEOUT_MS,
): Promise<ProxyProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let dispatcher: ProxyAgent | undefined;
  try {
    dispatcher = new ProxyAgent(proxyUrl);
    const response = await fetch(url, {
      method: "GET",
      dispatcher,
      redirect: "manual",
      signal: controller.signal,
    });
    // Any HTTP response (even 401/403) proves the proxy reached the target.
    return { protocol, ok: true, status: response.status, latencyMs: Date.now() - startedAt };
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    const message =
      cause instanceof Error && cause.name === "AbortError"
        ? "timeout"
        : cause instanceof Error
          ? cause.message
          : String(cause);
    return { protocol, ok: false, error: message, latencyMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
    if (dispatcher) void dispatcher.close().catch(() => {});
  }
}

/**
 * Probe connectivity through a proxy configuration. HTTPS falls back to the
 * HTTP proxy (mirroring `networkProxy.set`), so a single HTTP proxy is tested
 * over both protocols.
 */
export async function testProxyConnectivity(
  httpProxy: string,
  httpsProxy: string,
  targets: ReadonlyArray<{ protocol: "http" | "https"; url: string }> = PROXY_TEST_TARGETS,
): Promise<{ ok: boolean; error?: string; probes: ProxyProbeResult[] }> {
  const http = httpProxy.trim();
  const https = httpsProxy.trim() || http;
  if (!http && !https) {
    return { ok: false, error: "No proxy configured", probes: [] };
  }
  const probes: ProxyProbeResult[] = [];
  for (const target of targets) {
    const proxy = target.protocol === "https" ? https : http;
    if (!proxy) continue;
    probes.push(await runProxyProbe(target.protocol, target.url, proxy));
  }
  return { ok: probes.length > 0 && probes.every((probe) => probe.ok), probes };
}

function getSettingsPath(): string {
  return path.join(getAgentDir(), "settings.json");
}

function readSettingsJson(): Record<string, unknown> {
  const p = getSettingsPath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new RpcError({ code: "PARSE_ERROR", message: "settings.json must contain a JSON object" });
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    // ISSUE-009 parity with readModelsJson: never silently return empty and
    // allow a corrupt settings.json to be overwritten; surface the parse error
    // so the UI refuses to save until the file is fixed.
    if (error instanceof RpcError) throw error;
    throw new RpcError({
      code: "PARSE_ERROR",
      message: `Failed to parse settings.json: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * Restore persisted proxy settings at agent-host startup. Best-effort: a
 * corrupt settings.json must not prevent startup — the proxy panel surfaces
 * the parse error when the user opens it, and nothing is written back.
 */
export function applySavedProxySettings(): void {
  let settings: Record<string, unknown> = {};
  try {
    settings = readSettingsJson();
  } catch (error) {
    console.warn(
      `[agent-host] ignoring corrupt settings.json at startup: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  applyProxyEnvVars(
    typeof settings.httpProxy === "string" ? settings.httpProxy : undefined,
    typeof settings.httpsProxy === "string" ? settings.httpsProxy : undefined,
  );
  configureProxyDispatcher();
}

function writeSettingsJson(data: Record<string, unknown>): void {
  const p = getSettingsPath();
  mkdirSync(path.dirname(p), { recursive: true });
  // Atomic write via temp + rename, matching writeModelsJson.
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    renameSync(tmp, p);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw new RpcError({
      code: "WRITE_ERROR",
      message: `Failed to write settings.json: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

function readModelsJson(): Record<string, unknown> {
  const p = getModelsPath();
  if (!existsSync(p)) return { providers: {} };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch (e) {
    // ISSUE-009: never silently return empty and allow overwrite of corrupt file
    throw new RpcError({
      code: "PARSE_ERROR",
      message: `Failed to parse models.json: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

type ModelsFileSnapshot = { raw: string | null; version: string };

function modelsContentVersion(raw: string | null): string {
  return raw === null ? "missing" : `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`;
}

function readModelsFileSnapshot(): ModelsFileSnapshot {
  const p = getModelsPath();
  if (!existsSync(p)) return { raw: null, version: modelsContentVersion(null) };
  const raw = readFileSync(p, "utf8");
  return { raw, version: modelsContentVersion(raw) };
}

function readModelsJsonSnapshot(): { config: Record<string, unknown>; version: string } {
  const snapshot = readModelsFileSnapshot();
  if (snapshot.raw === null) return { config: { providers: {} }, version: snapshot.version };
  try {
    return { config: JSON.parse(snapshot.raw) as Record<string, unknown>, version: snapshot.version };
  } catch (e) {
    // ISSUE-009: never silently return empty and allow overwrite of corrupt file
    throw new RpcError({
      code: "PARSE_ERROR",
      message: `Failed to parse models.json: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

function modelsConfigConflict(expectedVersion: string, currentVersion: string): RpcError {
  return new RpcError({
    code: "CONFLICT",
    message: "models.json changed outside this editor; current edits were not saved",
    detail: { expectedVersion, currentVersion },
  });
}

function writeModelsJson(data: Record<string, unknown>, expectedVersion?: string): string {
  const p = getModelsPath();
  mkdirSync(path.dirname(p), { recursive: true });
  // Compare-and-swap: refuse to overwrite when the file changed since the
  // editor's snapshot (another editor/session may have saved meanwhile).
  if (expectedVersion !== undefined) {
    const initial = readModelsFileSnapshot();
    if (initial.version !== expectedVersion) throw modelsConfigConflict(expectedVersion, initial.version);
  }
  const serialized = JSON.stringify(data, null, 2);
  // ISSUE-009: atomic write via temp + rename; keep .bak of previous good file
  const tmp = `${p}.${process.pid}.tmp`;
  const bak = `${p}.bak`;
  writeFileSync(tmp, serialized, "utf8");
  try {
    if (existsSync(p)) {
      try {
        writeFileSync(bak, readFileSync(p), "utf8");
      } catch {
        /* ignore bak failure */
      }
    }
    renameSync(tmp, p);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
  return modelsContentVersion(serialized);
}

// ── Enabled-model filters (agent `enabledModels` + desktop map, NOT models.json) ──
//
// The desktop's "enabled models" selection lives in two places: pi's native
// `enabledModels` patterns in `~/.pi/agent/settings.json` (the same setting
// pi's CLI reads at startup to scope its available models), and the
// desktop-owned per-provider map in `~/.pi/desktop/settings.json` (a file pi's
// CLI never reads, so unknown-to-pi fields stay there). pi's CLI rejects
// `enabledModels` inside models.json provider entries, so it must never be
// written there. Older desktop versions wrote the filter into models.json and
// a desktop sidecar file; the migrations below lift any leftovers into the
// two canonical files. They are cheap and idempotent, so they run on every
// read/write entry point and keep repairing old files even if the user
// hand-edits them back.

/**
 * Every provider id pi can see: the built-in catalog plus any provider entry
 * present in models.json (so `providerId/*` patterns never exclude custom
 * providers the user configured).
 */
function knownProviderIds(): string[] {
  const ids = new Set<string>();
  for (const provider of builtinProviderCatalog.builtinProviders()) ids.add(provider.id);
  try {
    const config = readModelsJson();
    for (const providerId of Object.keys((config.providers ?? {}) as Record<string, unknown>)) ids.add(providerId);
  } catch {
    // Corrupt models.json: built-in catalog only.
  }
  return [...ids];
}

/**
 * Best-effort per-provider model id lists for pattern resolution: the built-in
 * catalog, overridden by any `models` arrays in models.json. Never throws — a
 * corrupt models.json falls back to the built-in catalog.
 */
function buildModelsByProvider(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const provider of builtinProviderCatalog.builtinProviders()) {
    result[provider.id] = provider.getModels().map((m) => m.id);
  }
  try {
    const config = readModelsJson();
    const providers = (config.providers ?? {}) as Record<string, { models?: unknown[] }>;
    for (const [providerId, entry] of Object.entries(providers)) {
      if (!entry || typeof entry !== "object" || !Array.isArray(entry.models)) continue;
      const ids = entry.models
        .map((m) =>
          m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string" ? (m as { id: string }).id : "",
        )
        .filter(Boolean);
      if (ids.length > 0) result[providerId] = ids;
    }
  } catch {
    // Corrupt models.json: built-in catalog only.
  }
  return result;
}

/**
 * The providers pi actually resolves models for — the ones the shared model
 * runtime reports as having usable auth (stored credential, models.json
 * apiKey/headers, or an environment variable). pi scopes its model list to
 * configured providers, so `enabledModels` patterns must only reference these:
 * a pattern for an unconfigured provider matches nothing and makes pi warn
 * "No models match pattern".
 */
async function resolvableProviderIds(): Promise<string[]> {
  const runtime = await getSharedModelRuntime();
  return knownProviderIds().filter((id) => runtime.getProviderAuthStatus(id)?.configured === true);
}

/**
 * Lift any `enabledModels` an older desktop version wrote into models.json
 * provider entries into the desktop-owned map (mirrored to the agent settings
 * `enabledModels`), so pi's CLI never trips over them. A provider entry left
 * with no pi-recognized fields at all would still fail pi's validation, so the
 * whole entry is dropped.
 */
async function migrateLegacyEnabledModels(): Promise<boolean> {
  let config: Record<string, unknown>;
  try {
    config = readModelsJson();
  } catch {
    // Corrupt models.json: leave it untouched (ISSUE-009) and retry on the next
    // call once the user has fixed the file.
    return false;
  }
  const providers = (config.providers ?? {}) as Record<string, Record<string, unknown>>;
  const leftovers: Record<string, string[]> = {};
  let dirty = false;
  for (const [providerId, entry] of Object.entries(providers)) {
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.enabledModels)) continue;
    leftovers[providerId] = entry.enabledModels.filter(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
    delete entry.enabledModels;
    // A provider entry that ends up with no pi-recognized fields at all would
    // still fail pi's validation, so drop the whole entry.
    if (Object.keys(entry).length === 0) delete providers[providerId];
    dirty = true;
  }
  if (dirty) {
    const filters = readProviderModelFilters(buildModelsByProvider());
    for (const [providerId, ids] of Object.entries(leftovers)) {
      if (!(providerId in filters)) filters[providerId] = ids;
    }
    writeProviderModelFilters(filters, await resolvableProviderIds());
    writeModelsJson(config);
  }
  return dirty;
}

/**
 * Lift the per-provider filter map from the legacy sidecar file
 * (`<agent dir>/pi-desktop-provider-model-filters.json`) into the desktop
 * settings file (mirrored to the agent settings `enabledModels`), then remove
 * the legacy file. Idempotent: once the legacy file is gone nothing is left to
 * migrate.
 */
export async function migrateLegacyProviderModelFilters(): Promise<boolean> {
  const legacy = readLegacyProviderModelFilters();
  if (legacy === undefined) return false;
  const filters = readProviderModelFilters(buildModelsByProvider());
  for (const [providerId, ids] of Object.entries(legacy)) {
    if (!(providerId in filters)) filters[providerId] = ids;
  }
  writeProviderModelFilters(filters, await resolvableProviderIds());
  try {
    unlinkSync(getLegacyProviderModelFiltersPath());
  } catch {
    /* ignore cleanup failure */
  }
  return true;
}

/**
 * Move the per-provider filter map a recent desktop version stored in the
 * agent settings file under `piDesktopModelFilters` into the desktop settings
 * file. The stored map is the user's explicit per-provider state, so its
 * entries override any pattern-derived guess; a provider already present in an
 * existing desktop map is newer state and is kept. The map is desktop-owned,
 * so it never belonged in the agent settings file pi parses; the write also
 * removes the leftover key from the agent settings file.
 */
export async function migrateLegacyAgentSettingsMap(): Promise<boolean> {
  const legacy = readAgentSettingsModelFilterMap();
  if (legacy === undefined) return false;
  const desktopMap = readDesktopModelFilterMap();
  const filters = readProviderModelFilters(buildModelsByProvider());
  for (const [providerId, ids] of Object.entries(legacy)) {
    if (desktopMap && providerId in desktopMap) continue;
    filters[providerId] = ids;
  }
  writeProviderModelFilters(filters, await resolvableProviderIds());
  return true;
}

/**
 * Rename the per-provider filter map an intermediate desktop version stored in
 * the desktop settings file under the legacy `providerModelFilters` key to the
 * current `piDesktopModelFilters` key (merging any entries the current map
 * lacks). The desktop settings file is the canonical home of the map, so it is
 * kept — only the key name is fixed.
 */
export async function migrateLegacyDesktopSettingsFilters(): Promise<boolean> {
  const legacy = readLegacyDesktopSettingsFilters();
  if (legacy === undefined) return false;
  const filters = readProviderModelFilters(buildModelsByProvider());
  for (const [providerId, ids] of Object.entries(legacy)) {
    if (!(providerId in filters)) filters[providerId] = ids;
  }
  writeProviderModelFilters(filters, await resolvableProviderIds());
  return true;
}

/**
 * Startup-time one-off cleanup: lift any legacy `enabledModels` an older
 * desktop version wrote into models.json or a desktop sidecar file into the
 * canonical files (agent `enabledModels` mirror + desktop-owned map), so pi's
 * CLI and the desktop agree on the enabled models. Best-effort — failures are
 * logged, never fatal.
 */
export async function runStartupMigrations(): Promise<void> {
  // The agent-settings map must be moved before anything rewrites the agent
  // settings file: `writeProviderModelFilters` self-heals by dropping the
  // agent-side `piDesktopModelFilters` key it no longer owns.
  try {
    if (await migrateLegacyAgentSettingsMap()) {
      console.log("[agent-host] moved piDesktopModelFilters from agent settings into desktop settings.json");
    }
  } catch (error) {
    console.warn(
      `[agent-host] failed to migrate agent-settings filter map: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    if (await migrateLegacyEnabledModels()) {
      console.log("[agent-host] migrated legacy enabledModels from models.json into agent settings.json");
    }
  } catch (error) {
    console.warn(
      `[agent-host] failed to migrate legacy enabledModels: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // The desktop-key rename must run before the sidecar migration: both write
  // the desktop settings file, and its self-heal drops the legacy
  // `providerModelFilters` key — if the sidecar wrote first, the desktop-key
  // migration would find nothing left to read.
  try {
    if (await migrateLegacyDesktopSettingsFilters()) {
      console.log("[agent-host] renamed legacy desktop providerModelFilters key to piDesktopModelFilters");
    }
  } catch (error) {
    console.warn(
      `[agent-host] failed to migrate legacy desktop settings: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    if (await migrateLegacyProviderModelFilters()) {
      console.log("[agent-host] migrated legacy provider-model filter sidecar into desktop settings.json");
    }
  } catch (error) {
    console.warn(
      `[agent-host] failed to migrate legacy provider-model filter file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Self-heal: regenerate the mirror from the desktop-owned map (if any),
  // restricted to providers pi actually resolves. An older desktop version
  // wrote `providerId/**` for every built-in provider, so unconfigured ones
  // polluted the mirror and pi warned "No models match pattern"; dropping
  // them is safe because pi has no models for those providers anyway.
  try {
    if (repairEnabledModelsMirror(await resolvableProviderIds())) {
      console.log("[agent-host] repaired enabledModels mirror (dropped patterns for unresolvable providers)");
    }
  } catch (error) {
    console.warn(
      `[agent-host] failed to repair enabledModels mirror: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ── Built-in provider overlays (custom Base URL + enabled models) ────────────

function getBuiltinProviderDefaults(): Map<
  string,
  { id: string; name: string; baseUrl: string; api: string; getModels: () => { id: string; name: string }[] }
> {
  const result = new Map<
    string,
    { id: string; name: string; baseUrl: string; api: string; getModels: () => { id: string; name: string }[] }
  >();
  for (const provider of builtinProviderCatalog.builtinProviders()) {
    const models = provider.getModels();
    result.set(provider.id, {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl ?? "",
      api: models[0]?.api ?? "",
      getModels: () => models.map((m) => ({ id: m.id, name: m.name ?? m.id })),
    });
  }
  return result;
}

function getProviderOverlay(
  config: Record<string, unknown>,
  providerId: string,
  defaultBaseUrl: string,
  modelIds: readonly string[],
): {
  customBaseUrl?: string;
  enabledModels?: string[];
} {
  const providers = (config.providers ?? {}) as Record<string, Record<string, unknown>>;
  const entry = providers[providerId] ?? {};
  const rawBaseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl.trim() : "";
  // A Base URL identical to the official endpoint is not a customization.
  const customBaseUrl = rawBaseUrl && rawBaseUrl !== defaultBaseUrl ? rawBaseUrl : undefined;
  // The enabled-model filter never lives in models.json — pi's CLI rejects
  // `enabledModels` in provider entries. It lives in the desktop's per-provider
  // `piDesktopModelFilters` map (`~/.pi/desktop/settings.json`, desktop-owned)
  // mirrored to pi's native `enabledModels` key (`~/.pi/agent/settings.json`).
  // A provider the user never touched is absent from the map and stays omitted
  // here, so the model panel does not list it as "configured".
  const filters = readProviderModelFilters({ [providerId]: modelIds });
  const enabledModels = providerId in filters ? filters[providerId] : undefined;
  return { customBaseUrl, enabledModels };
}

/**
 * Resolve a models.json-style config value (literal, `$ENV_VAR` / `${ENV_VAR}`,
 * or `!shell-command`) to a concrete string for outbound model-list requests.
 */
function resolveConfigValueSafely(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("!")) {
    try {
      const out = execSync(value.slice(1), { encoding: "utf8", timeout: 10_000 });
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
    const name: string | undefined = braced ?? bare;
    return name && process.env[name] !== undefined ? (process.env[name] as string) : match;
  });
}

function parseModelsResponse(data: unknown): BuiltinModelInfo[] {
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  let list: unknown = record.data;
  if (!Array.isArray(list)) list = record.models;
  if (Array.isArray(list)) {
    const out: BuiltinModelInfo[] = [];
    for (const item of list) {
      if (typeof item === "string") {
        if (item.trim()) out.push({ id: item.trim(), name: item.trim() });
      } else if (item && typeof item === "object") {
        const entry = item as Record<string, unknown>;
        const rawId =
          typeof entry.id === "string"
            ? entry.id
            : typeof entry.model === "string"
              ? entry.model
              : typeof entry.name === "string"
                ? entry.name
                : undefined;
        if (rawId && rawId.trim()) {
          const trimmed = rawId.trim();
          // Google lists models as "models/<id>" with a separate display name.
          const id = trimmed.startsWith("models/") ? trimmed.slice("models/".length) : trimmed;
          const name =
            typeof entry.displayName === "string" && entry.displayName.trim()
              ? entry.displayName.trim()
              : typeof entry.name === "string" && entry.name.trim() && entry.name.trim() !== trimmed
                ? entry.name.trim()
                : id;
          out.push({ id, name });
        }
      }
    }
    return out;
  }
  // Object keyed by model id (some gateways / proxies return this shape).
  const out: BuiltinModelInfo[] = [];
  for (const [id, value] of Object.entries(record)) {
    if (!id.trim()) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const name = (value as Record<string, unknown>).name;
      out.push({ id: id.trim(), name: typeof name === "string" ? name : id.trim() });
    }
  }
  return out;
}

function extractApiErrorBody(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
    if (parsed.error && typeof parsed.error === "object") {
      const msg = (parsed.error as Record<string, unknown>).message;
      if (typeof msg === "string" && msg) return msg;
    }
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
  } catch {
    return text.slice(0, 300);
  }
  return undefined;
}

async function resolveLoadedSkill(cwd: string, filePath: string) {
  if (!cwd || !filePath) {
    throw new RpcError({ code: "BAD_REQUEST", message: "cwd and filePath are required" });
  }
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
  await loader.reload();
  const requested = realpathSync(filePath);
  const skill = loader.getSkills().skills.find((candidate) => {
    try {
      return realpathSync(candidate.filePath) === requested;
    } catch {
      return false;
    }
  });
  if (!skill) {
    throw new RpcError({ code: "FORBIDDEN", message: "Skill is not loaded for this project" });
  }
  return skill;
}

function writeTextAtomically(filePath: string, content: string): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    throw error;
  }
}

/**
 * Filter the chat model picker by the `enabledModels` patterns in the agent
 * settings file — the same allowlist pi's CLI applies at startup, so the
 * desktop picker and pi agree on which models are usable. `undefined` (no
 * key) means every model is usable; an empty array disables everything.
 */
function filterByEnabledModelPatterns<T extends { id: string; provider: string }>(available: T[]): T[] {
  const patterns = readEnabledModelPatterns();
  if (patterns === undefined) return available;
  return available.filter((m) => patterns.some((pattern) => patternMatchesModel(pattern, m.provider, m.id)));
}

export async function credentialMutationFailure(
  modelRuntime: ModelRuntime,
  providerId: string,
  target: CredentialTarget,
  error: unknown,
) {
  if (error instanceof CredentialSynchronizationError) {
    const recovered = await recoverCommittedCredential(modelRuntime, providerId, target);
    if (recovered) {
      if (!recovered.synchronized) {
        console.warn(`[agent-host] credential ${error.operation} committed for ${providerId}; model sync retry failed`);
      }
      return recovered;
    }
    throw new RpcError({ code: "INTERNAL", message: `Credential change for ${providerId} could not be verified` });
  }
  throw new RpcError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : String(error) });
}

function resolveModelsCwd(params: { cwd?: string } | void): string {
  const cwd = params?.cwd || process.cwd();
  try {
    const st = statSync(cwd);
    if (!st.isDirectory()) throw new Error("not-directory");
  } catch {
    throw new RpcError({ code: "BAD_REQUEST", message: `Directory does not exist: ${cwd}` });
  }
  return cwd;
}

type DirectoryValidation = { ok: true; path: string; canonicalPath: string } | { ok: false; error: string };

function validateExistingDirectory(candidate: unknown): DirectoryValidation {
  if (typeof candidate !== "string" || !candidate) return { ok: false, error: "Directory does not exist" };
  try {
    const realpath = realpathSync.native ?? realpathSync;
    const canonicalPath = realpath(candidate);
    if (!statSync(canonicalPath).isDirectory()) return { ok: false, error: "Not a directory" };
    return { ok: true, path: candidate, canonicalPath };
  } catch {
    return { ok: false, error: "Directory does not exist" };
  }
}

function canonicalPathForComparison(candidate: string): string {
  const resolved = path.resolve(candidate);
  let canonical = resolved;
  try {
    const realpath = realpathSync.native ?? realpathSync;
    canonical = realpath(resolved);
  } catch {
    // Historical session cwd values can refer to directories that no longer exist.
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

type AvailableModel = Awaited<ReturnType<ModelRuntime["getAvailable"]>>[number];

async function resolveAvailableModels(
  modelRuntime: ModelRuntime,
  signal?: AbortSignal,
): Promise<{ models: AvailableModel[]; warnings: ModelCatalogWarning[] }> {
  const snapshot = [...modelRuntime.getAvailableSnapshot()];
  const snapshotByProvider = new Map<string, AvailableModel[]>();
  for (const model of snapshot) {
    const models = snapshotByProvider.get(model.provider) ?? [];
    models.push(model);
    snapshotByProvider.set(model.provider, models);
  }

  const results = await Promise.all(
    [...modelRuntime.getProviders()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(async (provider) => {
        try {
          const models = [...(await modelRuntime.getAvailable(provider.id, { signal }))];
          return { models, warning: undefined };
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
          return {
            models: snapshotByProvider.get(provider.id) ?? [],
            warning: {
              provider: provider.id,
              code: "PROVIDER_AVAILABILITY_FAILED" as const,
              message: `Unable to check ${provider.id} model availability; the last known state remains available.`,
            },
          };
        }
      }),
  );
  signal?.throwIfAborted();
  return {
    models: results.flatMap((result) => result.models),
    warnings: results.flatMap((result) => (result.warning ? [result.warning] : [])),
  };
}

export async function projectModelsList(
  modelRuntime: ModelRuntime,
  settings: SettingsManager,
  catalog: ModelCatalogStatus,
  options: { signal?: AbortSignal; cachedOnly?: boolean } = {},
): Promise<ModelsListResult> {
  // Per-provider availability with graceful degradation: a provider that fails
  // its live check keeps its last known snapshot models instead of failing the
  // whole list, and the warning is surfaced to the UI (PROVIDER_AVAILABILITY_FAILED).
  const availability = options.cachedOnly
    ? { models: [...modelRuntime.getAvailableSnapshot()], warnings: [] }
    : await resolveAvailableModels(modelRuntime, options.signal);
  const available = availability.models;
  // Lift any `enabledModels` left in models.json by older desktop versions into
  // the agent settings file; a corrupt models.json is left untouched (see ISSUE-009).
  await migrateLegacyEnabledModels();
  // Self-heal the mirror (drop patterns for unconfigured providers) so the
  // picker and pi CLI agree without requiring a restart.
  try {
    repairEnabledModelsMirror(await resolvableProviderIds());
  } catch {
    // Runtime unavailable — picker keeps the stored patterns as-is.
  }
  // The chat picker honors the same `enabledModels` allowlist pi's CLI applies
  // at startup (agent settings.json), so both surfaces agree on the models.
  const visible = filterByEnabledModelPatterns(available);
  const models = visible
    .map((model) => ({ id: model.id, name: model.name, provider: model.provider }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider));

  const nameMap: Record<string, string> = {};
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};
  for (const model of visible) {
    const key = `${model.provider}:${model.id}`;
    nameMap[key] = model.name;
    thinkingLevels[key] = getSupportedThinkingLevels(model);
    if (model.thinkingLevelMap) thinkingLevelMaps[key] = model.thinkingLevelMap;
  }

  let defaultModel: { provider: string; modelId: string } | null = null;
  const provider = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  if (provider && modelId && visible.some((model) => model.provider === provider && model.id === modelId)) {
    defaultModel = { provider, modelId };
  }

  return {
    models,
    defaultModel,
    thinkingLevels,
    thinkingLevelMaps,
    nameMap,
    catalog: {
      ...catalog,
      warnings: [...(catalog.warnings ?? []), ...availability.warnings],
    },
  };
}

export function initializeChannels(
  manager: Pick<ChannelManager, "initialize">,
  report: (message: string) => void = (message) => {
    try {
      process.parentPort?.postMessage({ type: "log", message: `[channels] initialization failed: ${message}` });
    } catch {
      /* ignore logging failure */
    }
  },
): void {
  void manager.initialize().catch((error) => report(safeChannelError(error)));
}

export function registerHandlers(server: RpcServer): () => Promise<void> {
  const fileWatch = createFileWatchService(server);
  const authLogin = createAuthLoginService(server);
  const channelManager = new ChannelManager(server, (session, sessionId) =>
    ensureSessionEvents(server, session, sessionId),
  );
  initializeChannels(channelManager);

  // Running sessions stream + tray badge signal to main via parentPort
  subscribeRunningSessions((ids) => {
    // Both fields remain in the current stream contract for renderer compatibility.
    server.emit("agent.running", "*", {
      type: "running",
      sessionIds: ids,
      runningSessionIds: ids,
    } as never);
    try {
      process.parentPort?.postMessage({ type: "running-sessions", sessionIds: ids });
    } catch {
      /* ignore */
    }
  });

  server.handle({
    "host.ping": () => ({ ok: true as const, ts: Date.now() }),

    "host.refresh": async () => {
      // Full soft-reset, mirroring what a restart of the app rebuilds:
      // 1. Re-scan the session index from disk (fingerprint-reused so this is
      //    cheap when nothing changed) and drop stale path-cache entries.
      const sessions = await listAllSessions();
      const indexMetrics = getSessionIndexMetrics();
      invalidateAllSessionPathCache();

      // 2. Reload the shared model runtime's local config/cache. Best-effort:
      //    a failure must not abort the refresh — the next network refresh
      //    (models.refresh) can still rebuild it. getSharedModelRuntime() is
      //    called first so a freshly added model is picked up even when the
      //    runtime was never initialized yet (otherwise reloadSharedModelRuntimeConfig
      //    would be a silent no-op until the next app restart).
      let modelRuntimeReloaded = false;
      try {
        await getSharedModelRuntime();
        await reloadSharedModelRuntimeConfig();
        modelRuntimeReloaded = true;
      } catch (error) {
        console.warn(
          `[agent-host] host.refresh: model runtime reload failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // 3. Re-run startup migrations so self-healing (legacy enabledModels,
      //    sidecar renames, mirror repair) applies to external edits made since
      //    launch — same as a restart would do.
      let migrations = false;
      try {
        await runStartupMigrations();
        migrations = true;
      } catch (error) {
        console.warn(
          `[agent-host] host.refresh: startup migrations failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // 4. Re-apply persisted proxy settings in case settings.json changed.
      applySavedProxySettings();

      // 5. Tear down and rebuild the session watcher (a wedged fs.watch is the
      //    most common reason a manual refresh appears to do nothing).
      const watcherRestarted = restartSessionWatcher(server) !== null;

      // 6. Force-broadcast the current running set so the sidebar re-syncs
      //    even when no running state changed.
      forceRunningChange();

      return {
        sessions: {
          count: sessions.length,
          indexMs: indexMetrics.totalMs,
          filesDiscovered: indexMetrics.filesDiscovered,
          filesParsed: indexMetrics.filesParsed,
          filesReused: indexMetrics.filesReused,
          invalidFiles: indexMetrics.invalidFiles,
        },
        modelRuntimeReloaded,
        migrations,
        proxyRestored: true,
        watcherRestarted,
        runningSessionIds: getRunningRpcSessionIds(),
      };
    },

    "host.toolchain": async (params) => {
      const { cwd } = params as { cwd: string };
      if (!cwd || !path.isAbsolute(cwd)) throw new RpcError({ code: "BAD_REQUEST", message: "absolute cwd required" });
      const context = await toolchainRuntime.createExecutionContext({ cwd, intent: "project-command" });
      return {
        inventoryRevision: context.inventoryRevision,
        resolutionId: context.resolutionId,
        capabilities: Object.fromEntries(
          Object.entries(context.commands).map(([capability, command]) => [
            capability,
            { provider: command.provider, version: command.version },
          ]),
        ),
      };
    },

    "sessions.list": async (params) => {
      const traceId = resolveSessionTraceId();
      const startedAt = performance.now();
      try {
        const requestedCwd = (params as { cwd?: unknown } | undefined)?.cwd;
        if (requestedCwd !== undefined && (typeof requestedCwd !== "string" || !path.isAbsolute(requestedCwd))) {
          throw new RpcError({ code: "BAD_REQUEST", message: "absolute cwd required" });
        }
        const canonicalCwd = typeof requestedCwd === "string" ? canonicalPathForComparison(requestedCwd) : undefined;
        const allSessions = await listAllSessions();
        const sessions = canonicalCwd
          ? allSessions.filter((session) => canonicalPathForComparison(session.cwd) === canonicalCwd)
          : allSessions;
        const indexMetrics = getSessionIndexMetrics();
        logSessionPerformance("sessions.list", {
          traceId,
          ok: true,
          totalMs: roundSessionMilliseconds(performance.now() - startedAt),
          sessionsReturned: sessions.length,
          filesDiscovered: indexMetrics.filesDiscovered,
          filesParsed: indexMetrics.filesParsed,
          filesReused: indexMetrics.filesReused,
          invalidFiles: indexMetrics.invalidFiles,
          indexRefreshMs: indexMetrics.totalMs,
        });
        return { sessions, runningSessionIds: getRunningRpcSessionIds() };
      } catch (error) {
        logSessionPerformance("sessions.list", {
          traceId,
          ok: false,
          totalMs: roundSessionMilliseconds(performance.now() - startedAt),
          error: error instanceof Error ? error.name : "UnknownError",
        });
        throw error;
      }
    },

    "sessions.get": async (params) => {
      const {
        id,
        includeState,
        traceId: requestedTraceId,
        historyWindow,
      } = params as {
        id: string;
        includeState?: boolean;
        traceId?: string;
        historyWindow?: HistoryWindow;
      };
      const traceId = resolveSessionTraceId(requestedTraceId);
      const startedAt = performance.now();
      let stateMs = 0;
      try {
        const agentStatePromise: Promise<SessionDetail["agentState"]> = (async () => {
          if (!includeState) return undefined;
          const stateStartedAt = performance.now();
          const existing = getRpcSession(id);
          const result = existing?.isAlive()
            ? { running: true, state: (await existing.send({ type: "get_state" })) as SessionRuntimeState }
            : { running: false };
          stateMs = performance.now() - stateStartedAt;
          return result;
        })();

        const resolveStartedAt = performance.now();
        const filePath = await resolveSessionPath(id);
        const resolvePathMs = performance.now() - resolveStartedAt;
        if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });

        const openStartedAt = performance.now();
        const { manager: sm, entries } = getSessionContentSnapshot(filePath);
        const openMs = performance.now() - openStartedAt;

        const contextStartedAt = performance.now();
        const leafId = sm.getLeafId();
        const tree = projectSessionTreeForResponse(sm.getTree() as never) as SessionTreeNode[];
        const historyRevision = buildHistoryRevision(filePath, id);
        const context = buildSessionHistoryPage({ entries, leafId, historyWindow, historyRevision });
        const contextMs = performance.now() - contextStartedAt;

        const infoStartedAt = performance.now();
        const [info, agentState] = await Promise.all([
          buildSessionInfoFromManager(filePath, sm, entries),
          agentStatePromise,
        ]);
        const infoMs = performance.now() - infoStartedAt;

        const detail: SessionDetail = {
          sessionId: id,
          filePath,
          info,
          leafId,
          tree,
          context,
          ...(agentState !== undefined ? { agentState } : {}),
        };
        const responseBytes = sessionPerformanceBytesEnabled()
          ? Buffer.byteLength(JSON.stringify(detail), "utf8")
          : undefined;
        logSessionPerformance("sessions.get", {
          traceId,
          ok: true,
          totalMs: roundSessionMilliseconds(performance.now() - startedAt),
          resolvePathMs: roundSessionMilliseconds(resolvePathMs),
          openMs: roundSessionMilliseconds(openMs),
          contextMs: roundSessionMilliseconds(contextMs),
          infoMs: roundSessionMilliseconds(infoMs),
          stateMs: roundSessionMilliseconds(stateMs),
          entryCount: entries.length,
          messageCount: context.messages.length,
          fileBytes: statSync(filePath).size,
          ...(responseBytes === undefined ? {} : { responseBytes }),
        });
        return detail;
      } catch (error) {
        logSessionPerformance("sessions.get", {
          traceId,
          ok: false,
          totalMs: roundSessionMilliseconds(performance.now() - startedAt),
          error: error instanceof Error ? error.name : "UnknownError",
        });
        throw error;
      }
    },

    "sessions.context": async (params) => {
      const { id, leafId, historyWindow } = params as { id: string; leafId?: string; historyWindow?: HistoryWindow };
      const filePath = await resolveSessionPath(id);
      if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
      const { entries } = getSessionContentSnapshot(filePath);
      const context = buildSessionHistoryPage({
        entries,
        leafId,
        historyWindow,
        historyRevision: buildHistoryRevision(filePath, id),
      });
      return { context };
    },

    "sessions.contextPage": async (params) => {
      const { id, cursor, maxTurns, maxBytes } = params as {
        id: string;
        cursor: string;
        maxTurns?: number;
        maxBytes?: number;
      };
      const filePath = await resolveSessionPath(id);
      if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
      const { entries } = getSessionContentSnapshot(filePath);
      try {
        const context = buildSessionHistoryPage({
          entries,
          historyWindow: { maxTurns, maxBytes },
          historyRevision: buildHistoryRevision(filePath, id),
          cursor: decodeHistoryCursor(cursor),
        });
        return { context };
      } catch (error) {
        if (error instanceof StaleHistoryCursorError) {
          throw new RpcError({ code: "STALE_CURSOR", message: error.message });
        }
        if (error instanceof Error && error.message === "Invalid session history cursor") {
          throw new RpcError({ code: "BAD_REQUEST", message: error.message });
        }
        throw error;
      }
    },

    "sessions.entryContent": async (params) => {
      const { id, entryId, blockIndex = 0 } = params as { id: string; entryId: string; blockIndex?: number };
      const filePath = await resolveSessionPath(id);
      if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
      const { entries } = getSessionContentSnapshot(filePath);
      const content = readSessionEntryContent(entries, entryId, blockIndex);
      if (content === null) {
        throw new RpcError({ code: "NOT_FOUND", message: "Session entry content not found" });
      }
      return {
        content,
        deferredContent: {
          entryId,
          blockIndex,
          originalBytes: Buffer.byteLength(JSON.stringify(content), "utf8"),
          contentType: content.type,
        },
      };
    },

    "sessions.export": async (params) => {
      const { id, format = "md" } = params as { id: string; format?: "md" | "json" };
      const filePath = await resolveSessionPath(id);
      if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
      const raw = readFileSync(filePath, "utf8");
      if (format === "json") {
        return { content: raw, suggestedName: `session-${id}.json` };
      }
      // Simple markdown export of session file content
      const sm = SessionManager.open(filePath);
      const context = buildSessionContext(sm.getEntries() as never);
      const lines: string[] = [`# Session ${id}`, ""];
      for (const msg of context.messages as Array<{ role: string; content: unknown }>) {
        lines.push(`## ${msg.role}`, "");
        if (typeof msg.content === "string") lines.push(msg.content);
        else if (Array.isArray(msg.content)) {
          for (const block of msg.content as Array<{ type?: string; text?: string }>) {
            if (block.type === "text" && block.text) lines.push(block.text);
          }
        }
        lines.push("");
      }
      return { content: lines.join("\n"), suggestedName: `session-${id}.md` };
    },

    "sessions.delete": async (params) => {
      const { id, force } = params as { id: string; force?: boolean };
      const filePath = await resolveSessionPath(id);
      if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
      const existing = getRpcSession(id);
      if (existing?.isAlive()) {
        if (existing.isRunning() && !force) {
          throw new RpcError({
            code: "CONFLICT",
            message: "Session is still running. Stop it before deleting.",
          });
        }
        // ISSUE-001: fully stop agent before unlinking session file
        await existing.abortAndDispose();
        clearSessionEventBinding(existing.sessionId || id);
      }
      try {
        unlinkSync(filePath);
      } catch (e) {
        throw new RpcError({
          code: "INTERNAL",
          message: e instanceof Error ? e.message : String(e),
        });
      }
      invalidateSessionContent(filePath);
      const deletedSession = sessionIndex.removePath(filePath);
      invalidateSessionPathCache(id);
      void callMain("browser.sessionEnded", { sessionId: id }).catch(() => undefined);
      server.emit("sessions.changed", id, {
        cwd: deletedSession?.cwd ?? null,
        sessionId: id,
        deleted: true,
      });
      return { ok: true as const };
    },

    "sessions.rename": async (params) => {
      const { id, name } = params as { id: string; name: string };
      if (!name?.trim()) {
        throw new RpcError({ code: "BAD_REQUEST", message: "name is required" });
      }
      const existing = getRpcSession(id);
      if (existing?.isAlive()) {
        await existing.send({ type: "set_session_name", name: name.trim() });
      } else {
        const filePath = await resolveSessionPath(id);
        if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
        const sm = SessionManager.open(filePath);
        // ISSUE-014: SDK uses appendSessionInfo, not setSessionName
        sm.appendSessionInfo(name.trim());
        invalidateSessionContent(filePath);
      }
      await emitIndexedSessionChange(server, id, null);
      return { ok: true as const };
    },

    "worktrees.list": async (params) => {
      const { projectRoot } = params as { projectRoot: string };
      const allowed = await getAllowedFileRoots();
      if (!isFilePathAllowed(projectRoot, allowed)) {
        throw new RpcError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const project = await resolveProject(projectRoot);
      let worktrees: Awaited<ReturnType<typeof listWorktrees>> = [];
      let isGit = true;
      try {
        worktrees = await listWorktrees(existsSync(projectRoot) ? projectRoot : project.projectRoot);
      } catch {
        isGit = false;
      }
      for (const w of worktrees) allowFileRoot(w.path);
      return {
        worktrees,
        projectRoot: project.projectRoot,
        isGit,
        isTopLevel: project.isTopLevel,
      };
    },

    "worktrees.create": async (params) => {
      const body = params as { projectRoot: string; branch: string; cwd?: string };
      const cwd = body.cwd ?? body.projectRoot;
      const allowed = await getAllowedFileRoots();
      if (!isFilePathAllowed(cwd, allowed)) {
        throw new RpcError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const result = await addWorktree(cwd, body.branch);
      allowFileRoot(result.path);
      return { worktree: result };
    },

    "worktrees.remove": async (params) => {
      const body = params as { path: string; cwd?: string; force?: boolean };
      const cwd = body.cwd ?? body.path;
      const allowed = await getAllowedFileRoots();
      if (!isFilePathAllowed(cwd, allowed)) {
        throw new RpcError({ code: "FORBIDDEN", message: "Access denied" });
      }
      try {
        await removeWorktree(cwd, body.path, body.force === true);
      } catch (error) {
        if (!body.force && isDirtyWorktreeError(error)) {
          throw new RpcError({
            code: "CONFLICT",
            message: error instanceof Error ? error.message : String(error),
            detail: { dirty: true },
          });
        }
        throw error;
      }
      return { ok: true as const };
    },

    "git.status": async (params) => {
      const { path: cwd } = params as { path: string };
      await assertPathAllowed(cwd);
      return getGitStatus(cwd);
    },

    "agent.new": async (params) => {
      const body = params as {
        cwd: string;
        type?: string;
        message?: string;
        provider?: string;
        modelId?: string;
        toolNames?: string[];
        thinkingLevel?: string;
        [key: string]: unknown;
      };
      const { cwd, provider, modelId, toolNames, thinkingLevel, ...rest } = body;
      if (!cwd || typeof cwd !== "string") {
        throw new RpcError({ code: "BAD_REQUEST", message: "cwd is required" });
      }
      if (!existsSync(cwd)) {
        throw new RpcError({ code: "BAD_REQUEST", message: `Directory does not exist: ${cwd}` });
      }

      const tempKey = createAgentNewLockKey();
      const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, toolNames, { activate: true });
      allowFileRoot(cwd);

      // ISSUE-003: single event-binding entry only (ensureSessionEvents)
      ensureSessionEvents(server, session, realSessionId);

      if (provider && modelId) {
        await session.send({ type: "set_model", provider, modelId });
      }
      if (thinkingLevel) {
        await session.send({ type: "set_thinking_level", level: thinkingLevel });
      }

      if (rest.type === "ensure_session") {
        return { sessionId: realSessionId, data: null };
      }

      const command = rest.type ? rest : { type: "prompt", message: body.message ?? "" };
      const data = await session.send(command as Record<string, unknown>);
      await emitIndexedSessionChange(server, realSessionId, cwd);
      return { sessionId: realSessionId, data };
    },

    "agent.command": async (params) => {
      const { sessionId, command } = params as {
        sessionId: string;
        command: Record<string, unknown>;
      };
      const existing = getRpcSession(sessionId);
      if (existing?.isAlive()) {
        // Ensure event subscription
        ensureSessionEvents(server, existing, sessionId);
        // On a session switch, release the previous session's extension
        // foreground and re-bind this one so extensions (e.g. rpiv-todo) attach
        // to the currently shown session. No-op for repeated use of the same
        // session.
        await activateSession(sessionId);
        return existing.send(command);
      }
      const filePath = await resolveSessionPath(sessionId);
      if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
      const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
      const { session } = await startRpcSession(sessionId, filePath, cwd, undefined, { activate: true });
      ensureSessionEvents(server, session, sessionId);
      return session.send(command);
    },

    "agent.state": async (params) => {
      const { sessionId } = params as { sessionId: string };
      const session = getRpcSession(sessionId);
      if (!session || !session.isAlive()) return { running: false };
      const state = await session.send({ type: "get_state" });
      return { running: true, state };
    },

    "channels.list": async () => channelManager.snapshot(),

    "channels.accountUpsert": async (params) => channelManager.upsertAccount(params.account),

    "channels.accountConnect": async (params) => channelManager.connectAccount(params.account),

    "channels.accountDelete": async (params) => channelManager.deleteAccount(params.accountId),

    "channels.start": async (params) => {
      await channelManager.startAccount(params.accountId);
      return { ok: true as const };
    },

    "channels.stop": async (params) => {
      await channelManager.stopAccount(params.accountId);
      return { ok: true as const };
    },

    "channels.restart": async (params) => {
      await channelManager.restartAccount(params.accountId);
      return { ok: true as const };
    },

    "channels.probe": async (params) => channelManager.probe(params.accountId),

    "channels.loginStart": async (params) => channelManager.startLogin(params),

    "channels.loginWait": async (params) => channelManager.waitLogin(params.channel, params.sessionKey),

    "channels.loginSubmitCode": async (params) => {
      channelManager.submitLoginCode(params.channel, params.sessionKey, params.code);
      return { ok: true as const };
    },

    "channels.loginCancel": async (params) => {
      channelManager.cancelLogin(params.channel, params.sessionKey);
      return { ok: true as const };
    },

    "channels.pairingApprove": async (params) => channelManager.approvePairing(params.pairingId),

    "channels.pairingReject": async (params) => channelManager.rejectPairing(params.pairingId),

    "channels.bindingUpsert": async (params) => channelManager.upsertBinding(params.binding),

    "channels.bindingDelete": async (params) => channelManager.deleteBinding(params.bindingId),

    "channels.testSend": async (params) => channelManager.testSend(params.accountId, params.peerId, params.message),

    "files.list": async (params) => {
      const { path: dirPath } = params as { path: string };
      await assertPathAllowed(dirPath);
      if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
        throw new RpcError({ code: "NOT_FOUND", message: "Directory not found" });
      }
      const names = readdirSync(dirPath);
      const entries: Array<{
        name: string;
        isDir: boolean;
        size?: number;
        mtime?: number;
        path: string;
        type: "file" | "directory";
      }> = [];
      for (const name of names) {
        if (IGNORED_NAMES.has(name)) continue;
        const full = path.join(dirPath, name);
        try {
          const st = statSync(full);
          const isDir = st.isDirectory();
          entries.push({
            name,
            path: full,
            isDir,
            type: isDir ? "directory" : "file",
            size: st.size,
            mtime: st.mtimeMs,
          });
        } catch {
          /* skip unreadable */
        }
      }
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return { entries: entries as never };
    },

    "files.read": async (params) => {
      const { path: filePath, sourceSessionId } = params as {
        path: string;
        sourceSessionId?: string;
      };
      await assertPathAllowed(filePath, sourceSessionId);
      const st = statSync(filePath);
      if (!st.isFile()) {
        throw new RpcError({ code: "BAD_REQUEST", message: "Not a file" });
      }

      const imageMime = getImageMime(filePath);
      const audioMime = getAudioMime(filePath);
      const documentMime = getDocumentMime(filePath);
      const binaryMime = imageMime || audioMime || documentMime;

      // ISSUE-004: binary as base64+mime; never UTF-8 corrupt
      if (binaryMime) {
        const limit = imageMime ? IMAGE_PREVIEW_MAX_BYTES : documentMime ? DOCX_PREVIEW_MAX_BYTES : 50 * 1024 * 1024;
        if (st.size > limit) {
          return {
            content: "",
            encoding: "too_large" as const,
            mime: binaryMime,
            language: getLanguage(filePath),
            size: st.size,
            truncated: true,
          };
        }
        return {
          content: readFileSync(filePath).toString("base64"),
          encoding: "base64" as const,
          mime: binaryMime,
          language: getLanguage(filePath),
          size: st.size,
          truncated: false,
        };
      }

      // Text: only read up to limit
      const fd = await import("fs").then((fs) => fs.openSync(filePath, "r"));
      try {
        const max = Math.min(st.size, TEXT_PREVIEW_MAX_BYTES);
        const buf = Buffer.alloc(max);
        const n = (await import("fs")).readSync(fd, buf, 0, max, 0);
        return {
          content: buf.slice(0, n).toString("utf8"),
          encoding: "utf8" as const,
          language: getLanguage(filePath),
          size: st.size,
          truncated: st.size > TEXT_PREVIEW_MAX_BYTES,
        };
      } finally {
        (await import("fs")).closeSync(fd);
      }
    },

    "files.download": async (params) => {
      const { path: filePath, sourceSessionId } = params as {
        path: string;
        sourceSessionId?: string;
      };
      await assertPathAllowed(filePath, sourceSessionId);
      const st = statSync(filePath);
      if (!st.isFile()) {
        throw new RpcError({ code: "BAD_REQUEST", message: "Not a file" });
      }
      if (st.size > FILE_DOWNLOAD_MAX_BYTES) {
        throw new RpcError({
          code: "RESULT_TOO_LARGE",
          message: `File exceeds the ${FILE_DOWNLOAD_MAX_BYTES / 1024 / 1024} MiB download limit`,
          detail: { size: st.size, maxBytes: FILE_DOWNLOAD_MAX_BYTES },
        });
      }
      return {
        base64: readFileSync(filePath).toString("base64"),
        size: st.size,
        mime:
          getImageMime(filePath) || getAudioMime(filePath) || getDocumentMime(filePath) || "application/octet-stream",
      };
    },

    "files.meta": async (params) => {
      const { path: filePath, sourceSessionId } = params as {
        path: string;
        sourceSessionId?: string;
      };
      await assertPathAllowed(filePath, sourceSessionId);
      const st = statSync(filePath);
      const imageMime = getImageMime(filePath);
      const audioMime = getAudioMime(filePath);
      const documentMime = getDocumentMime(filePath);
      return {
        size: st.size,
        mtime: st.mtimeMs,
        language: getLanguage(filePath),
        kind: documentPreviewKind(filePath) ?? (imageMime ? "image" : "file"),
        mime: imageMime ?? audioMime ?? documentMime ?? "text/plain",
      };
    },

    "files.preview": async (params) => {
      const { path: filePath, sourceSessionId } = params as {
        path: string;
        sourceSessionId?: string;
      };
      await assertPathAllowed(filePath, sourceSessionId);
      const st = statSync(filePath);
      const imgMime = getImageMime(filePath);
      if (imgMime) {
        if (st.size > IMAGE_PREVIEW_MAX_BYTES) {
          return { kind: "too_large", mime: imgMime, size: st.size };
        }
        return {
          kind: "image",
          mime: imgMime,
          base64: readFileSync(filePath).toString("base64"),
        };
      }
      const docKind = documentPreviewKind(filePath);
      if (docKind === "docx") {
        if (st.size > DOCX_PREVIEW_MAX_BYTES) {
          return { kind: "too_large", mime: getDocumentMime(filePath) ?? undefined, size: st.size };
        }
        return {
          kind: "docx",
          mime: getDocumentMime(filePath) ?? undefined,
          base64: readFileSync(filePath).toString("base64"),
        };
      }
      if (st.size > TEXT_PREVIEW_MAX_BYTES) {
        return {
          kind: "text",
          content: readFileSync(filePath, "utf8").slice(0, TEXT_PREVIEW_MAX_BYTES),
          language: getLanguage(filePath),
          truncated: true,
        };
      }
      return {
        kind: "text",
        content: readFileSync(filePath, "utf8"),
        language: getLanguage(filePath),
      };
    },

    "files.index": async (params) => {
      // ISSUE-005: return relative POSIX paths + { files, truncated, matches }
      const { root, query } = params as { root: string; query?: string };
      await assertPathAllowed(root);
      let relFiles: string[] = [];
      let truncatedReason: "depth" | "count" | undefined;

      try {
        const all = await listGitFiles(root);
        if (all.length > 50_000) {
          truncatedReason = "count";
          relFiles = all.slice(0, 50_000);
        } else {
          relFiles = all;
        }
      } catch {
        const abs: string[] = [];
        const walk = (dir: string, depth: number) => {
          if (depth > 8) {
            truncatedReason ??= "depth";
            return;
          }
          if (abs.length >= 5000) {
            truncatedReason = "count";
            return;
          }
          let names: string[];
          try {
            names = readdirSync(dir);
          } catch {
            return;
          }
          for (const name of names) {
            if (IGNORED_NAMES.has(name) || name.startsWith(".")) continue;
            const full = path.join(dir, name);
            try {
              const st = statSync(full);
              if (st.isDirectory()) walk(full, depth + 1);
              else abs.push(full);
            } catch {
              /* skip */
            }
            if (abs.length >= 5000) {
              truncatedReason = "count";
              return;
            }
          }
        };
        walk(root, 0);
        const rootNorm = root.replace(/\\/g, "/").replace(/\/$/, "");
        relFiles = abs.map((f) => {
          const n = f.replace(/\\/g, "/");
          return n.startsWith(rootNorm + "/") ? n.slice(rootNorm.length + 1) : n;
        });
      }

      const CLIENT_CAP = 5000;
      const filesForClient = relFiles.slice(0, CLIENT_CAP);
      if (relFiles.length > CLIENT_CAP) truncatedReason = "count";
      const truncated = truncatedReason !== undefined;
      const entries = buildEntriesFromFiles(filesForClient);

      if (query?.trim()) {
        const matches = filterFileEntries(entries, query.trim()).slice(0, 50);
        return {
          files: filesForClient,
          truncated,
          ...(truncatedReason ? { truncatedReason } : {}),
          matches: matches.map((m) => ({
            path: m.path,
            isDir: m.isDir,
            score: "score" in m ? Number((m as { score?: number }).score ?? 0) : 0,
          })),
        };
      }

      return {
        files: filesForClient,
        truncated,
        ...(truncatedReason ? { truncatedReason } : {}),
        matches: entries.slice(0, 100).map((m) => ({
          path: m.path,
          isDir: m.isDir,
          score: 0,
        })),
      };
    },

    "models.list": async (params) => {
      const cwd = resolveModelsCwd(params as { cwd?: string } | void);
      const agentDir = getAgentDir();
      const services = await createAgentSessionServices({ cwd, agentDir });
      return projectModelsList(services.modelRuntime, services.settingsManager, {
        source: process.env.PI_OFFLINE === undefined ? "cache" : "offline",
        refreshed: false,
        aborted: false,
        warnings: [],
      });
    },

    "models.refresh": async (params) => {
      const { requestId } = params as { cwd?: string; requestId: string };
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) {
        throw new RpcError({ code: "BAD_REQUEST", message: "Invalid model refresh request id" });
      }
      const cwd = resolveModelsCwd(params);
      const agentDir = getAgentDir();
      return modelCatalogRefreshCoordinator.refresh(
        cwd,
        requestId,
        (signal) => createAgentSessionServices({ cwd, agentDir, modelRuntimeSignal: signal }),
        ({ services, catalog }, signal) =>
          projectModelsList(services.modelRuntime, services.settingsManager, catalog, {
            signal,
            cachedOnly: catalog.aborted,
          }),
      );
    },

    "models.refreshCancel": (params) => {
      const { requestId } = params as { requestId: string };
      return { ok: true as const, cancelled: modelCatalogRefreshCoordinator.cancel(requestId) };
    },

    "modelsConfig.get": async () => {
      // Lift legacy `providers.<id>.enabledModels` out of models.json so the
      // editor snapshot never re-saves the desktop-only field into pi's config.
      await migrateLegacyEnabledModels();
      return readModelsJsonSnapshot() as never;
    },

    "modelsConfig.set": async (params) => {
      const body = params as { config?: unknown; expectedVersion?: unknown };
      const config = body?.config as Record<string, unknown> | undefined;
      // ISSUE-009: refuse to persist empty overwrite without explicit providers key from a real load
      if (!config || typeof config !== "object" || !("providers" in config)) {
        throw new RpcError({ code: "BAD_REQUEST", message: "Invalid models config payload" });
      }
      if (typeof body.expectedVersion !== "string" || !body.expectedVersion) {
        throw new RpcError({ code: "BAD_REQUEST", message: "expectedVersion is required" });
      }
      await migrateLegacyEnabledModels();
      // A full-config save must never write the enabled-model filter into
      // models.json; lift any leftovers into the agent settings file instead.
      const providers = (config.providers ?? {}) as Record<string, Record<string, unknown>>;
      let filtersChanged = false;
      const filters = readProviderModelFilters(buildModelsByProvider());
      for (const [providerId, entry] of Object.entries(providers)) {
        if (!entry || typeof entry !== "object" || !Array.isArray(entry.enabledModels)) continue;
        if (!(providerId in filters)) {
          filters[providerId] = entry.enabledModels.filter(
            (v): v is string => typeof v === "string" && v.trim().length > 0,
          );
        }
        delete entry.enabledModels;
        // Drop entries that would be left with no pi-recognized fields (pi's CLI
        // rejects provider entries without baseUrl/headers/models/...).
        if (Object.keys(entry).length === 0) delete providers[providerId];
        filtersChanged = true;
      }
      // Persist models.json first (CAS against the editor's snapshot), then
      // reload the runtime so resolvable provider ids reflect the newly saved
      // config (e.g. a provider the user just gave an apiKey), then write the
      // mirror restricted to those.
      const version = writeModelsJson(config, body.expectedVersion);
      await reloadSharedModelRuntimeConfig();
      if (filtersChanged) writeProviderModelFilters(filters, await resolvableProviderIds());
      return { ok: true as const, version };
    },
    "networkProxy.get": () => {
      const settings = readSettingsJson();
      const http = settings.httpProxy;
      const https = settings.httpsProxy;
      return {
        httpProxy: typeof http === "string" ? http : "",
        httpsProxy: typeof https === "string" ? https : "",
      };
    },
    "networkProxy.set": (params) => {
      const body = params as { httpProxy?: string; httpsProxy?: string };
      const httpValue = typeof body.httpProxy === "string" ? body.httpProxy.trim() : "";
      const httpsValue = typeof body.httpsProxy === "string" ? body.httpsProxy.trim() : "";
      const settings = readSettingsJson();
      // httpProxy is the field pi-coding-agent reads natively (applied to both
      // protocols as a fallback); httpsProxy is our extension for a separate
      // HTTPS proxy. Env vars below apply the per-protocol values immediately.
      if (httpValue || httpsValue) {
        if (httpValue) settings.httpProxy = httpValue;
        else delete settings.httpProxy;
        if (httpsValue) settings.httpsProxy = httpsValue;
        else delete settings.httpsProxy;
      } else {
        delete settings.httpProxy;
        delete settings.httpsProxy;
      }
      writeSettingsJson(settings);
      // Apply to this process and spawned tool subprocesses immediately, and
      // reinstall the global dispatcher so fetch-based model traffic follows.
      // HTTPS falls back to the HTTP proxy when not configured separately;
      // pi-coding-agent's EnvHttpProxyAgent reads these env vars per protocol.
      applyProxyEnvVars(httpValue || undefined, httpsValue || undefined);
      configureProxyDispatcher();
      return { ok: true as const, applied: true };
    },
    "networkProxy.system": () => readSystemProxySettings(),
    "networkProxy.test": (params) =>
      testProxyConnectivity(
        String((params as { httpProxy?: string }).httpProxy ?? ""),
        String((params as { httpsProxy?: string }).httpsProxy ?? ""),
      ),
    "modelsConfig.test": async (params) => {
      const body = params as unknown as {
        providerName?: string;
        provider?: Record<string, unknown>;
        model?: Record<string, unknown>;
      };
      const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
      if (!providerName) return { ok: false, error: "providerName is required" };
      if (!body.provider || typeof body.provider !== "object") {
        return { ok: false, error: "provider is required" };
      }
      if (!body.model || typeof body.model !== "object") {
        return { ok: false, error: "model is required" };
      }
      const modelId = typeof body.model.id === "string" ? body.model.id.trim() : "";
      if (!modelId) return { ok: false, error: "Model ID is required" };

      let tempDir: string | undefined;
      try {
        tempDir = mkdtempSync(path.join(tmpdir(), "pi-desktop-model-test-"));
        const modelsPath = path.join(tempDir, "models.json");
        writeFileSync(
          modelsPath,
          JSON.stringify(
            {
              providers: {
                [providerName]: {
                  ...body.provider,
                  models: [{ ...body.model, id: modelId }],
                },
              },
            },
            null,
            2,
          ),
          "utf8",
        );

        const modelRuntime = await ModelRuntime.create({ modelsPath, allowModelNetwork: false });
        const loadError = modelRuntime.getError();
        if (loadError) return { ok: false, error: loadError };

        const model = modelRuntime.getModel(providerName, modelId);
        if (!model) return { ok: false, error: `Model not found: ${providerName}/${modelId}` };

        const auth = await modelRuntime.getAuth(model);
        if (!auth) return { ok: false, error: `No authentication found for "${providerName}"` };

        const TEST_TIMEOUT_MS = 20_000;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
        let status: number | undefined;
        const startedAt = Date.now();
        try {
          const message = await modelRuntime.completeSimple(
            model,
            {
              messages: [
                {
                  role: "user",
                  content: "Reply with OK only.",
                  timestamp: Date.now(),
                },
              ],
            },
            {
              maxTokens: 16,
              timeoutMs: TEST_TIMEOUT_MS,
              maxRetries: 0,
              cacheRetention: "none",
              signal: controller.signal,
              onResponse: (response: { status: number }) => {
                status = response.status;
              },
            },
          );

          const latencyMs = Date.now() - startedAt;
          if (message.stopReason === "error" || message.stopReason === "aborted") {
            return {
              ok: false,
              error: message.errorMessage ?? (controller.signal.aborted ? "Test timed out" : "Model returned an error"),
              latencyMs,
              status,
            };
          }
          const responseText = message.content
            .filter((b) => b.type === "text")
            .map((b) => (b as { text: string }).text)
            .join("")
            .slice(0, 300);
          return { ok: true, latencyMs, status, responseText };
        } finally {
          clearTimeout(timeout);
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      } finally {
        if (tempDir) {
          try {
            rmSync(tempDir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      }
    },

    "modelsConfig.providers": async () => {
      const defaults = getBuiltinProviderDefaults();
      const config = readModelsJson();
      const runtime = await getSharedModelRuntime();
      const result = [...defaults.values()]
        .map((defaultProvider) => {
          const composed = runtime.getProvider(defaultProvider.id);
          const models = composed?.getModels() ?? defaultProvider.getModels();
          const overlay = getProviderOverlay(
            config,
            defaultProvider.id,
            defaultProvider.baseUrl,
            models.map((m) => m.id),
          );
          const modelCount = models.length;
          const auth = runtime.getProviderAuthStatus(defaultProvider.id);
          return {
            id: defaultProvider.id,
            name: composed?.name ?? defaultProvider.name,
            defaultBaseUrl: defaultProvider.baseUrl,
            ...(overlay.customBaseUrl ? { customBaseUrl: overlay.customBaseUrl } : {}),
            ...(overlay.enabledModels ? { enabledModels: overlay.enabledModels } : {}),
            modelCount,
            api: defaultProvider.api,
            // True when the provider has usable credentials (stored API key / OAuth
            // token / models.json key / environment variable).
            configured: auth?.configured ?? false,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return { providers: result };
    },

    "modelsConfig.providerModels": async (params) => {
      const { providerId } = params as { providerId?: string };
      const id = typeof providerId === "string" ? providerId.trim() : "";
      if (!id) throw new RpcError({ code: "BAD_REQUEST", message: "providerId is required" });
      const defaults = getBuiltinProviderDefaults();
      const defaultProvider = defaults.get(id);
      if (!defaultProvider) {
        throw new RpcError({ code: "NOT_FOUND", message: `Unknown built-in provider: ${id}` });
      }
      const config = readModelsJson();
      const runtime = await getSharedModelRuntime();
      const composed = runtime.getProvider(id);
      const models = (composed?.getModels() ?? defaultProvider.getModels()).map((m) => ({ id: m.id, name: m.name }));
      const overlay = getProviderOverlay(
        config,
        id,
        defaultProvider.baseUrl,
        models.map((m) => m.id),
      );
      return {
        provider: {
          id: defaultProvider.id,
          name: composed?.name ?? defaultProvider.name,
          defaultBaseUrl: defaultProvider.baseUrl,
          ...(overlay.customBaseUrl ? { customBaseUrl: overlay.customBaseUrl } : {}),
          api: defaultProvider.api,
        },
        models,
        // null = no filter (all models enabled by default)
        enabledModels: overlay.enabledModels ?? null,
      };
    },

    "modelsConfig.setProviderOverlay": async (params) => {
      const body = params as { providerId?: string; baseUrl?: string; enabledModels?: string[] | null };
      const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
      if (!providerId) throw new RpcError({ code: "BAD_REQUEST", message: "providerId is required" });
      const defaults = getBuiltinProviderDefaults();
      const defaultProvider = defaults.get(providerId);
      if (!defaultProvider) {
        throw new RpcError({ code: "NOT_FOUND", message: `Unknown built-in provider: ${providerId}` });
      }

      // The Base URL override belongs in models.json (pi owns that file); the
      // enabled-model filter must NOT go there — pi's CLI rejects `enabledModels`
      // in provider entries, so it is persisted in the agent settings file under
      // pi's native `enabledModels` key.
      const config = readModelsJson();
      const providers = (config.providers ?? {}) as Record<string, Record<string, unknown>>;
      const next = { ...(providers[providerId] ?? {}) };
      // Never persist the enabled-model filter into models.json, even if a stale
      // entry was left there by an older desktop version.
      delete next.enabledModels;

      if (body.baseUrl !== undefined) {
        const trimmed = body.baseUrl.trim();
        if (trimmed && trimmed !== defaultProvider.baseUrl) next.baseUrl = trimmed;
        else delete next.baseUrl;
      }
      if (body.enabledModels !== undefined) {
        // Merge into the current per-provider state (the desktop's stored map,
        // or the map derived from hand-written `enabledModels` patterns) so
        // toggling one provider never drops another's.
        const providerIds = await resolvableProviderIds();
        const modelsByProvider: Record<string, string[]> = buildModelsByProvider();
        try {
          const runtime = await getSharedModelRuntime();
          for (const pid of knownProviderIds()) {
            const composed = runtime.getProvider(pid);
            const models = composed?.getModels() ?? defaults.get(pid)?.getModels() ?? [];
            modelsByProvider[pid] = models.map((m) => m.id);
          }
        } catch {
          // Fall back to the synchronous catalog view on runtime failure.
        }
        const filters = readProviderModelFilters(modelsByProvider);
        if (body.enabledModels === null) {
          delete filters[providerId];
        } else {
          const list = [...new Set(body.enabledModels.map((m) => m.trim()).filter(Boolean))];
          // Empty array is explicit: disable every model (absent means all enabled).
          filters[providerId] = list;
        }
        writeProviderModelFilters(filters, providerIds);
      }

      // Drop empty entries (no Base URL override left).
      if (Object.keys(next).length === 0) {
        delete providers[providerId];
      } else {
        providers[providerId] = next;
      }

      writeModelsJson(config);
      await reloadSharedModelRuntimeConfig();
      return { ok: true as const };
    },

    "modelsConfig.fetchModels": async (params) => {
      const body = params as { baseUrl?: string; apiKey?: string };
      const rawBaseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
      if (!rawBaseUrl) return { ok: false as const, error: "Base URL is required" };
      let base: URL;
      try {
        base = new URL(rawBaseUrl);
      } catch {
        return { ok: false as const, error: "Invalid Base URL — expected https://api.example.com/v1" };
      }
      if (base.protocol !== "https:" && base.protocol !== "http:") {
        return { ok: false as const, error: "Base URL must start with http:// or https://" };
      }
      const modelsUrl = `${base.toString().replace(/\/+$/, "")}/models`;
      // Google Generative Language API (generativelanguage.googleapis.com) uses a
      // different auth header (x-goog-api-key), returns models as "models/<id>"
      // entries, and paginates via nextPageToken — handle it specially.
      const isGoogle =
        base.hostname === "generativelanguage.googleapis.com" ||
        base.hostname.endsWith(".generativelanguage.googleapis.com");
      const apiKey = resolveConfigValueSafely(typeof body.apiKey === "string" ? body.apiKey : undefined);
      const headers: Record<string, string> = { Accept: "application/json" };
      if (apiKey) {
        if (isGoogle) {
          headers["x-goog-api-key"] = apiKey;
        } else {
          // Cover both OpenAI-compatible (Bearer) and Anthropic-compatible (x-api-key) endpoints.
          headers["Authorization"] = `Bearer ${apiKey}`;
          headers["x-api-key"] = apiKey;
        }
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const collected: BuiltinModelInfo[] = [];
        let pageToken: string | null = null;
        for (let page = 0; page < 10; page += 1) {
          let url = modelsUrl;
          if (isGoogle) {
            const u = new URL(modelsUrl);
            u.searchParams.set("pageSize", "100");
            if (pageToken) u.searchParams.set("pageToken", pageToken);
            url = u.toString();
          }
          const response = await fetch(url, { headers, signal: controller.signal });
          if (!response.ok) {
            const text = await response.text().catch(() => "");
            const detail = extractApiErrorBody(text);
            return {
              ok: false as const,
              error: detail ? `HTTP ${response.status}: ${detail}` : `Request failed with HTTP ${response.status}`,
              status: response.status,
            };
          }
          const data: unknown = await response.json().catch(() => null);
          const models = parseModelsResponse(data);
          if (page === 0 && models.length === 0) {
            return {
              ok: false as const,
              error: 'The response did not contain a model list (expected { "data": [...] })',
            };
          }
          const seen = new Set(collected.map((m) => m.id));
          for (const model of models) {
            if (!seen.has(model.id)) {
              seen.add(model.id);
              collected.push(model);
            }
          }
          if (!isGoogle) break;
          const token = (data as { nextPageToken?: unknown } | null)?.nextPageToken;
          if (typeof token !== "string" || !token) break;
          pageToken = token;
        }
        return { ok: true as const, models: collected };
      } catch (e) {
        if (controller.signal.aborted) return { ok: false as const, error: "Request timed out after 15 seconds" };
        const raw = e instanceof Error ? e.message : String(e);
        const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : "";
        const detail = cause && !raw.includes(cause) ? `${raw} — ${cause}` : raw;
        const friendly = /ENOTFOUND|EAI_AGAIN/.test(detail)
          ? "Could not resolve the host — check the Base URL"
          : /ECONNREFUSED|ECONNRESET/.test(detail)
            ? "Connection refused — is the endpoint reachable?"
            : detail;
        return { ok: false as const, error: friendly };
      } finally {
        clearTimeout(timer);
      }
    },

    "auth.providers": async () => {
      const modelRuntime = await getSharedModelRuntime();
      const storedProviders = new Set(
        (await modelRuntime.listCredentials())
          .filter((entry) => entry.type === "oauth")
          .map((entry) => entry.providerId),
      );
      const EXCLUDED = new Set(["anthropic"]);
      const DISPLAY_NAMES: Record<string, string> = {
        "openai-codex": "ChatGPT Plus/Pro",
        "github-copilot": "GitHub Copilot",
      };
      const result = modelRuntime
        .getProviders()
        .filter((p) => p.auth.oauth && !EXCLUDED.has(p.id))
        .map((p) => ({
          id: p.id,
          name: DISPLAY_NAMES[p.id] ?? p.name,
          usesCallbackServer: false,
          authenticated: storedProviders.has(p.id),
          loggedIn: storedProviders.has(p.id),
        }));
      return { providers: result };
    },

    "auth.allProviders": async () => {
      const modelRuntime = await getSharedModelRuntime();
      const all = modelRuntime.getModels();
      const OAUTH_PROVIDER_IDS = new Set(["anthropic", "github-copilot", "openai-codex"]);
      const seen = new Set<string>();
      const result: Array<{
        id: string;
        displayName: string;
        configured: boolean;
        source?: string;
        modelCount: number;
      }> = [];
      for (const model of all) {
        if (seen.has(model.provider)) continue;
        seen.add(model.provider);
        if (OAUTH_PROVIDER_IDS.has(model.provider)) continue;
        const provider = modelRuntime.getProvider(model.provider);
        if (!provider?.auth.apiKey) continue;
        const status = modelRuntime.getProviderAuthStatus(model.provider);
        if (status.source === "models_json_key") continue;
        result.push({
          id: model.provider,
          displayName: provider.name,
          configured: status.configured,
          source: status.label ?? status.source,
          modelCount: all.filter((candidate) => candidate.provider === model.provider).length,
        });
      }
      return { providers: result as never };
    },

    "auth.setApiKey": async (params) => {
      const { provider, key } = params as { provider: string; key: string };
      if (!provider || !key?.trim()) {
        throw new RpcError({ code: "BAD_REQUEST", message: "provider and key required" });
      }
      const modelRuntime = await getSharedModelRuntime();
      let promptCount = 0;
      const interaction: AuthInteraction = {
        async prompt(request) {
          promptCount += 1;
          if (promptCount !== 1 || request.type !== "secret") {
            throw new Error(`${provider} requires an interactive, multi-field login flow`);
          }
          return key.trim();
        },
        notify() {},
      };
      try {
        await modelRuntime.login(provider, "api_key", interaction);
      } catch (error) {
        return credentialMutationFailure(modelRuntime, provider, { present: true, type: "api_key" }, error);
      }
      if (!(await credentialStateMatches(modelRuntime, provider, { present: true, type: "api_key" }))) {
        throw new RpcError({
          code: "INTERNAL",
          message: `Key for ${provider} was written but not readable back`,
        });
      }
      return { ok: true as const, synchronized: true };
    },

    "auth.deleteApiKey": async (params) => {
      const { provider } = params as { provider: string };
      const modelRuntime = await getSharedModelRuntime();
      try {
        await modelRuntime.logout(provider);
      } catch (error) {
        return credentialMutationFailure(modelRuntime, provider, { present: false, type: "api_key" }, error);
      }
      if (!(await credentialStateMatches(modelRuntime, provider, { present: false, type: "api_key" }))) {
        throw new RpcError({ code: "INTERNAL", message: `Key removal for ${provider} could not be verified` });
      }
      return { ok: true as const, synchronized: true };
    },

    "auth.logout": async (params) => {
      const { provider } = params as { provider: string };
      const modelRuntime = await getSharedModelRuntime();
      try {
        await modelRuntime.logout(provider);
      } catch (error) {
        return credentialMutationFailure(modelRuntime, provider, { present: false }, error);
      }
      if (!(await credentialStateMatches(modelRuntime, provider, { present: false }))) {
        throw new RpcError({ code: "INTERNAL", message: `Logout for ${provider} could not be verified` });
      }
      return { ok: true as const, synchronized: true };
    },

    "auth.loginSubmit": async (params) => {
      const { provider, token, code } = params as {
        provider: string;
        token: string;
        code: string;
      };
      if (!resolveLoginCode(provider, token, code)) {
        throw new RpcError({ code: "NOT_FOUND", message: "No pending login for token" });
      }
      return { ok: true as const };
    },

    "auth.loginStart": async (params) => {
      const { provider } = params as { provider: string };
      const result = await authLogin.start(provider);
      return { ok: true as const, started: result.started };
    },

    "auth.loginCancel": async (params) => {
      const { provider } = params as { provider: string };
      authLogin.cancel(provider);
      return { ok: true as const };
    },

    "skills.list": async (params) => {
      const cwd = (params as { cwd?: string } | void)?.cwd;
      if (!cwd) throw new RpcError({ code: "BAD_REQUEST", message: "cwd required" });
      const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
      await loader.reload();
      const { skills, diagnostics } = loader.getSkills();
      return { skills, diagnostics };
    },

    "skills.search": async (params) => {
      const { query } = params as { query: string };
      try {
        return (await searchSkills(query)) as never;
      } catch (e) {
        if (e instanceof ToolchainError) throw e;
        throw new RpcError({
          code: "INTERNAL",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },

    "skills.install": async (params) => {
      try {
        return await installSkill(params as { package: string; scope?: "global" | "project"; cwd?: string });
      } catch (e) {
        if (e instanceof ToolchainError) throw e;
        throw new RpcError({
          code: "INTERNAL",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },

    "skills.set": async (params) => {
      const body = params as {
        cwd: string;
        filePath: string;
        disableModelInvocation?: boolean;
        content?: string;
      };
      const skill = await resolveLoadedSkill(body.cwd, body.filePath);
      const { filePath } = skill;
      const content = body.content ?? readFileSync(filePath, "utf8");
      if (content.length > 2 * 1024 * 1024) {
        throw new RpcError({ code: "BAD_REQUEST", message: "Skill file is too large" });
      }
      const updated =
        body.disableModelInvocation === undefined
          ? content
          : updateSkillModelInvocation(content, body.disableModelInvocation);
      writeTextAtomically(filePath, updated);
      return { ok: true as const };
    },

    "skills.getContent": async (params) => {
      const body = params as { cwd: string; filePath: string };
      const skill = await resolveLoadedSkill(body.cwd, body.filePath);
      return { content: readFileSync(skill.filePath, "utf8") };
    },

    "plugins.list": async (params) => {
      const cwd = (params as { cwd?: string } | void)?.cwd;
      if (!cwd) throw new RpcError({ code: "BAD_REQUEST", message: "cwd required" });
      return readPlugins(cwd);
    },

    "plugins.set": async (params) => {
      return applyPluginAction(params);
    },

    "files.watchStart": async (params, context) => {
      const { path: filePath, sourceSessionId } = params as {
        path: string;
        sourceSessionId?: string;
      };
      const leaseKey = `files.watch:${filePath}`;
      context?.releaseLease(leaseKey);
      const release = await fileWatch.start(filePath, sourceSessionId);
      context?.setLease(leaseKey, release);
      return { ok: true as const };
    },

    "files.watchStop": async (params, context) => {
      const { path: filePath } = params as { path: string };
      if (context) context.releaseLease(`files.watch:${filePath}`);
      else fileWatch.stop(filePath);
      return { ok: true as const };
    },

    "system.home": () => ({ home: homedir() }),

    "system.validateCwd": async (params) => {
      const { path: dir } = params as { path: string };
      const validation = validateExistingDirectory(dir);
      if (!validation.ok) return validation;
      allowFileRoot(validation.canonicalPath);
      return { ok: true as const, path: validation.path };
    },

    "system.defaultCwd": async () => {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const dir = path.join(homedir(), `pi-cwd-${date}`);
      mkdirSync(dir, { recursive: true });
      allowFileRoot(dir);
      return { cwd: dir };
    },

    "system.allowRoot": async (params) => {
      const { path: dir } = params as { path: string };
      const validation = validateExistingDirectory(dir);
      if (!validation.ok) throw new RpcError({ code: "BAD_REQUEST", message: validation.error });
      allowFileRoot(validation.canonicalPath);
      return { ok: true as const };
    },

    "system.runningCount": async () => {
      const sessionIds = getRunningRpcSessionIds();
      return { count: sessionIds.length, sessionIds };
    },
  });

  return async () => {
    modelCatalogRefreshCoordinator.cancelAll();
    await channelManager.shutdown();
    stopAllFileWatches();
    await disposeAllRpcSessions();
  };
}

export function createAgentNewLockKey(): string {
  return `__new__${randomUUID()}`;
}

/** ISSUE-003: track bindings per wrapper instance, not permanent sessionId set */
const eventBoundWrappers = new WeakSet<object>();
const eventUnsubsBySession = new Map<string, () => void>();

function clearSessionEventBinding(sessionId: string): void {
  const unsub = eventUnsubsBySession.get(sessionId);
  if (unsub) {
    try {
      unsub();
    } catch {
      /* ignore */
    }
    eventUnsubsBySession.delete(sessionId);
  }
}

function ensureSessionEvents(
  server: RpcServer,
  session: {
    sessionId: string;
    onEvent: (l: (e: { type: string; [k: string]: unknown }) => void) => () => void;
    onDestroy?: (cb: () => void) => void | (() => void);
  },
  sessionId: string,
): void {
  if (eventBoundWrappers.has(session as object)) return;
  eventBoundWrappers.add(session as object);

  const key = session.sessionId || sessionId;
  // Replace any stale binding for this session id (re-opened after idle destroy)
  clearSessionEventBinding(key);

  const unsub = session.onEvent((event) => {
    server.emit("agent.events", key, event as never);
    // ISSUE-015: only agent_end (not synthetic prompt_done) for system notifications
    if (event.type === "agent_end") {
      try {
        process.parentPort?.postMessage({
          type: "agent-end",
          sessionId: key,
          eventType: event.type,
        });
      } catch {
        /* ignore */
      }
    }
  });
  eventUnsubsBySession.set(key, unsub);
  session.onDestroy?.(() => {
    clearSessionEventBinding(key);
  });
}
