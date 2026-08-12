import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CredentialSynchronizationError } from "@earendil-works/pi-coding-agent";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");
// Desktop config lives next to the agent dir (<base>/desktop), so isolate both
// under one temp base to keep tests from touching the real ~/.pi/desktop.
const isolatedBaseDirectory = mkdtempSync(path.join(tmpdir(), "pi-handler-base-"));
const isolatedAgentDirectory = path.join(isolatedBaseDirectory, "agent");
mkdirSync(isolatedAgentDirectory, { recursive: true });
process.env.PI_CODING_AGENT_DIR = isolatedAgentDirectory;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(isolatedAgentDirectory, "sessions");
process.env.PI_OFFLINE = "1";
process.once("exit", () => rmSync(isolatedBaseDirectory, { recursive: true, force: true }));
// Enabled-model filters are split across two files: pi's native `enabledModels`
// key in the agent settings file pi itself reads (`<base>/agent/settings.json`),
// and the desktop-owned per-provider map in `<base>/desktop/settings.json`
// (which pi's CLI never reads).
const settingsPath = path.join(isolatedAgentDirectory, "settings.json");
const desktopSettingsPath = path.join(isolatedBaseDirectory, "desktop", "settings.json");
let modulePromise;

async function loadHandlersModule() {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const outputDirectory = path.join(root, ".artifacts", "test-modules");
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, `handlers-${process.pid}.mjs`);
    await build({
      absWorkingDir: root,
      entryPoints: ["src/agent-host/handlers.ts"],
      outfile: outputFile,
      bundle: true,
      format: "esm",
      platform: "node",
      packages: "external",
      sourcemap: false,
      logLevel: "silent",
    });
    return import(`${pathToFileURL(outputFile).href}?v=${Date.now()}`);
  })();
  return modulePromise;
}

async function captureHandlers() {
  const { registerHandlers } = await loadHandlersModule();
  const handlers = {};
  const events = [];
  registerHandlers({
    handle(next) {
      Object.assign(handlers, next);
    },
    emit(topic, key, data) {
      events.push({ topic, key, data });
    },
  });
  return { handlers, events };
}

test("registerHandlers exposes every contract method exactly once", async () => {
  const { handlers } = await captureHandlers();
  assert.equal(Object.keys(handlers).length, 76);
  for (const method of [
    "host.ping",
    "host.toolchain",
    "sessions.list",
    "sessions.contextPage",
    "sessions.entryContent",
    "worktrees.list",
    "git.status",
    "agent.state",
    "channels.list",
    "channels.accountConnect",
    "files.list",
    "files.download",
    "models.list",
    "models.refresh",
    "models.refreshCancel",
    "modelsConfig.providers",
    "modelsConfig.providerModels",
    "modelsConfig.setProviderOverlay",
    "modelsConfig.fetchModels",
    "networkProxy.get",
    "networkProxy.set",
    "networkProxy.system",
    "networkProxy.test",
    "auth.providers",
    "skills.list",
    "plugins.list",
    "system.allowRoot",
  ]) {
    assert.equal(typeof handlers[method], "function", `${method} must be registered`);
  }
});

test("credential mutation failures distinguish committed state from an unverified mutation", async () => {
  const { credentialMutationFailure } = await loadHandlersModule();
  const synchronizationError = new CredentialSynchronizationError("test-provider", "setRuntimeApiKey", undefined, {
    cause: new Error("secret upstream detail"),
  });

  const committed = await credentialMutationFailure(
    {
      async listCredentials() {
        return [{ providerId: "test-provider", type: "api_key" }];
      },
      async refresh() {
        throw new Error("secret retry detail");
      },
    },
    "test-provider",
    { present: true, type: "api_key" },
    synchronizationError,
  );
  assert.deepEqual(committed, {
    ok: true,
    synchronized: false,
    warning: {
      code: "MODEL_SYNC_FAILED",
      message: "Credentials were updated, but the local model state could not be refreshed. Retry model refresh.",
    },
  });
  assert.doesNotMatch(JSON.stringify(committed), /secret/);

  await assert.rejects(
    credentialMutationFailure(
      {
        async listCredentials() {
          return [];
        },
        async refresh() {
          throw new Error("must not refresh");
        },
      },
      "test-provider",
      { present: true, type: "api_key" },
      synchronizationError,
    ),
    (error) => error?.code === "INTERNAL" && !String(error?.message).includes("secret"),
  );
});

test("file, git, worktree, skill, plugin, and system handlers return contract-shaped results", async (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "pi-handler-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  mkdirSync(path.join(project, "nested"), { recursive: true });
  const textFile = path.join(project, "hello.txt");
  writeFileSync(textFile, "hello handler tests\n");

  const { handlers } = await captureHandlers();
  assert.deepEqual(await handlers["system.allowRoot"]({ path: project }), { ok: true });
  assert.deepEqual(await handlers["system.validateCwd"]({ path: project }), { ok: true, path: project });

  const listed = await handlers["files.list"]({ path: project });
  assert.equal(
    listed.entries.some((entry) => entry.name === "hello.txt" && entry.type === "file"),
    true,
  );

  const read = await handlers["files.read"]({ path: textFile });
  assert.equal(read.encoding, "utf8");
  assert.equal(read.content, "hello handler tests\n");

  const downloaded = await handlers["files.download"]({ path: textFile });
  assert.equal(Buffer.from(downloaded.base64, "base64").toString("utf8"), "hello handler tests\n");
  assert.equal(downloaded.size, Buffer.byteLength("hello handler tests\n"));

  const meta = await handlers["files.meta"]({ path: textFile });
  assert.equal(meta.language, "text");
  assert.equal(meta.mime, "text/plain");

  const preview = await handlers["files.preview"]({ path: textFile });
  assert.equal(preview.kind, "text");
  assert.equal(preview.content, "hello handler tests\n");

  const index = await handlers["files.index"]({ root: project, query: "hello" });
  assert.equal(Array.isArray(index.files), true);
  assert.equal(index.files.includes("hello.txt"), true);

  const git = await handlers["git.status"]({ path: project });
  assert.equal(git.isGit, false);

  const worktrees = await handlers["worktrees.list"]({ projectRoot: project });
  assert.equal(Array.isArray(worktrees.worktrees), true);
  assert.equal(worktrees.projectRoot, project);

  const agentState = await handlers["agent.state"]({ sessionId: "missing-session" });
  assert.deepEqual(agentState, { running: false });

  const skills = await handlers["skills.list"]({ cwd: project });
  assert.equal(Array.isArray(skills.skills), true);

  const plugins = await handlers["plugins.list"]({ cwd: project });
  assert.equal(typeof plugins, "object");

  const running = await handlers["system.runningCount"]();
  assert.equal(running.count, running.sessionIds.length);

  await handlers["files.watchStart"]({ path: project });
  assert.deepEqual(await handlers["files.watchStop"]({ path: project }), { ok: true });
});

test("session, model configuration, and auth handlers isolate state and preserve error codes", async () => {
  const { handlers } = await captureHandlers();

  const sessions = await handlers["sessions.list"]();
  assert.deepEqual(sessions.sessions, []);
  assert.deepEqual(sessions.runningSessionIds, []);

  await assert.rejects(handlers["sessions.get"]({ id: "missing" }), (error) => error.code === "NOT_FOUND");
  await assert.rejects(handlers["agent.command"]({ sessionId: "missing", command: { type: "abort" } }), (error) =>
    ["NOT_FOUND", "BAD_REQUEST"].includes(error.code),
  );

  assert.deepEqual(await handlers["modelsConfig.get"](), { providers: {} });
  await assert.rejects(handlers["modelsConfig.set"]({}), (error) => error.code === "BAD_REQUEST");
  assert.deepEqual(await handlers["modelsConfig.set"]({ providers: {} }), { ok: true });

  const v084Config = {
    providers: {
      custom: {
        headers: { Authorization: "Bearer test", "X-Remove-Me": null },
        models: [
          {
            id: "model-one",
            samplingParams: { temperature: 0.2, thinking_token_budget: 1024 },
            futureField: { preserved: true },
          },
        ],
      },
    },
    futureTopLevel: "preserved",
  };
  assert.deepEqual(await handlers["modelsConfig.set"](v084Config), { ok: true });
  assert.deepEqual(await handlers["modelsConfig.get"](), v084Config);

  const models = await handlers["models.list"]({ cwd: root });
  assert.equal(models.catalog.source, "offline");
  const refreshedModels = await handlers["models.refresh"]({ cwd: root, requestId: "offline-test" });
  assert.equal(refreshedModels.catalog.source, "offline");
  assert.deepEqual(await handlers["models.refreshCancel"]({ requestId: "offline-test" }), {
    ok: true,
    cancelled: false,
  });

  const invalidModelTest = await handlers["modelsConfig.test"]({});
  assert.deepEqual(invalidModelTest, { ok: false, error: "providerName is required" });

  const oauthProviders = await handlers["auth.providers"]();
  assert.equal(Array.isArray(oauthProviders.providers), true);
  const allProviders = await handlers["auth.allProviders"]();
  assert.equal(Array.isArray(allProviders.providers), true);

  assert.deepEqual(await handlers["auth.setApiKey"]({ provider: "openai", key: "secret" }), {
    ok: true,
    synchronized: true,
  });
  await assert.rejects(
    handlers["auth.setApiKey"]({ provider: "amazon-bedrock", key: "not-a-bearer-token" }),
    (error) => error.code === "BAD_REQUEST" && /interactive, multi-field/.test(error.message),
  );
  assert.deepEqual(await handlers["auth.deleteApiKey"]({ provider: "openai" }), {
    ok: true,
    synchronized: true,
  });
  assert.deepEqual(await handlers["auth.logout"]({ provider: "openai" }), { ok: true, synchronized: true });
  assert.deepEqual(await handlers["auth.loginCancel"]({ provider: "handler-test" }), { ok: true });
  await assert.rejects(
    handlers["auth.loginSubmit"]({ provider: "one", token: "two-token", code: "code" }),
    (error) => error.code === "BAD_REQUEST",
  );

  const modelsPath = path.join(isolatedAgentDirectory, "models.json");
  writeFileSync(modelsPath, "{broken json", "utf8");
  await assert.rejects(handlers["modelsConfig.get"](), (error) => error.code === "PARSE_ERROR");
  assert.equal(readFileSync(modelsPath, "utf8"), "{broken json");
});

test("built-in provider overlays persist, restore defaults, and filter the model picker", async () => {
  const { handlers } = await captureHandlers();
  // Reset the models + settings files left behind by earlier tests.
  writeFileSync(path.join(isolatedAgentDirectory, "models.json"), JSON.stringify({ providers: {} }), "utf8");
  rmSync(settingsPath, { force: true });

  // Configure credentials FIRST: the mirror only emits patterns for providers
  // pi actually resolves (configured ones), so openai + google must be
  // connected before their models can be filtered.
  await handlers["auth.setApiKey"]({ provider: "openai", key: "secret" });
  await handlers["auth.setApiKey"]({ provider: "google", key: "secret" });

  const providers = await handlers["modelsConfig.providers"]();
  const openai = providers.providers.find((p) => p.id === "openai");
  assert.ok(openai, "openai is a built-in provider");
  assert.ok(openai.defaultBaseUrl.length > 0);
  assert.ok(openai.modelCount > 0);
  assert.equal(openai.enabledModels, undefined);

  const detail = await handlers["modelsConfig.providerModels"]({ providerId: "openai" });
  assert.equal(detail.provider.id, "openai");
  assert.ok(detail.models.length > 0);
  assert.equal(detail.enabledModels, null);
  await assert.rejects(
    handlers["modelsConfig.providerModels"]({ providerId: "nope" }),
    (error) => error.code === "NOT_FOUND",
  );

  const firstModel = detail.models[0];
  await handlers["modelsConfig.setProviderOverlay"]({
    providerId: "openai",
    baseUrl: "https://proxy.example.com/v1",
    enabledModels: [firstModel.id],
  });
  const stored = await handlers["modelsConfig.get"]();
  assert.equal(stored.providers.openai.baseUrl, "https://proxy.example.com/v1");
  // The enabled-model filter must NOT be persisted inside models.json — pi's CLI
  // rejects `enabledModels` in provider entries. It lives in the agent settings
  // file under pi's native `enabledModels` key (which the pi CLI reads itself).
  assert.equal(stored.providers.openai.enabledModels, undefined);
  const agentSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.ok(
    agentSettings.enabledModels.includes(`openai/${firstModel.id}`),
    "the filter must be written as a pi-native enabledModels pattern",
  );
  assert.ok(
    agentSettings.enabledModels.some((pattern) => pattern.endsWith("/**")),
    "unfiltered configured providers must stay enabled via providerId/** patterns",
  );
  const desktopSettings = JSON.parse(readFileSync(desktopSettingsPath, "utf8"));
  assert.deepEqual(
    desktopSettings.piDesktopModelFilters.openai,
    [firstModel.id],
    "the desktop-owned per-provider map lives in the desktop settings file",
  );
  // Patterns must never be emitted for unconfigured providers — pi has no
  // models for them, so every such pattern would warn "No models match pattern".
  for (const id of ["anthropic", "amazon-bedrock", "groq"]) {
    assert.equal(
      agentSettings.enabledModels.some((pattern) => pattern.startsWith(`${id}/`)),
      false,
      `unconfigured ${id} must not appear in the enabledModels mirror`,
    );
  }

  const listed = await handlers["models.list"]({ cwd: root });
  const openaiModels = listed.models.filter((m) => m.provider === "openai");
  assert.deepEqual(
    openaiModels.map((m) => m.id),
    [firstModel.id],
  );

  // An explicit empty list disables every model of the provider.
  await handlers["modelsConfig.setProviderOverlay"]({ providerId: "openai", enabledModels: [] });
  const listedNone = await handlers["models.list"]({ cwd: root });
  assert.equal(listedNone.models.filter((m) => m.provider === "openai").length, 0);
  const settingsNone = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(
    settingsNone.enabledModels.some((pattern) => pattern.startsWith("openai/")),
    false,
    "an empty list must not emit openai patterns",
  );
  const desktopSettingsNone = JSON.parse(readFileSync(desktopSettingsPath, "utf8"));
  assert.deepEqual(
    desktopSettingsNone.piDesktopModelFilters.openai,
    [],
    "explicit empty list stays in the desktop map",
  );
  // The explicit "disable every model" state must round-trip through the panel
  // (an empty list, not the ambiguous "no filter").
  const detailNone = await handlers["modelsConfig.providerModels"]({ providerId: "openai" });
  assert.deepEqual(detailNone.enabledModels, []);

  // Clearing Base URL + enabled models removes the overlay entirely.
  await handlers["modelsConfig.setProviderOverlay"]({ providerId: "openai", baseUrl: "", enabledModels: null });
  const cleared = await handlers["modelsConfig.get"]();
  assert.equal(cleared.providers.openai, undefined);
  const listedRestored = await handlers["models.list"]({ cwd: root });
  assert.ok(listedRestored.models.filter((m) => m.provider === "openai").length > 0);
  const settingsCleared = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(
    settingsCleared.enabledModels,
    undefined,
    "clearing the last filter must remove the enabledModels key entirely",
  );
  const desktopSettingsCleared = JSON.parse(readFileSync(desktopSettingsPath, "utf8"));
  assert.equal(
    desktopSettingsCleared.piDesktopModelFilters,
    undefined,
    "clearing the last filter must remove the desktop map key entirely",
  );

  await handlers["auth.deleteApiKey"]({ provider: "openai" });
  await handlers["auth.deleteApiKey"]({ provider: "google" });
});

test("legacy enabledModels in models.json migrate into the agent settings file", async () => {
  const { handlers } = await captureHandlers();
  const modelsPath = path.join(isolatedAgentDirectory, "models.json");

  // Older desktop versions persisted the filter inside models.json, which pi's
  // CLI rejects. Reading must lift it into the agent settings `enabledModels`
  // and drop the leftover (an entry left with no pi-recognized fields would
  // still fail validation).
  // openai must be configured first: the mirror only emits patterns for
  // providers pi actually resolves, so a legacy filter for an unconfigured
  // provider is kept in the desktop map but not mirrored (pi has no models
  // for it and would warn on the pattern).
  await handlers["auth.setApiKey"]({ provider: "openai", key: "secret" });
  writeFileSync(
    modelsPath,
    JSON.stringify({ providers: { openai: { enabledModels: ["gpt-4o", "gpt-4o-mini"] } } }, null, 2),
    "utf8",
  );
  rmSync(settingsPath, { force: true });

  const stored = await handlers["modelsConfig.get"]();
  assert.equal(stored.providers.openai, undefined);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.ok(settings.enabledModels.includes("openai/gpt-4o"));
  assert.ok(settings.enabledModels.includes("openai/gpt-4o-mini"));
  assert.deepEqual(JSON.parse(readFileSync(modelsPath, "utf8")), { providers: {} });

  // A full-config save carrying the legacy field must lift it out of models.json.
  rmSync(settingsPath, { force: true });
  const legacySnapshot = {
    providers: { openai: { baseUrl: "https://proxy.example.com/v1", enabledModels: ["gpt-4o"] } },
  };
  assert.deepEqual(await handlers["modelsConfig.set"](legacySnapshot), { ok: true });
  const storedAfterSet = await handlers["modelsConfig.get"]();
  assert.equal(storedAfterSet.providers.openai.baseUrl, "https://proxy.example.com/v1");
  assert.equal(storedAfterSet.providers.openai.enabledModels, undefined);
  const settingsAfterSet = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.ok(settingsAfterSet.enabledModels.includes("openai/gpt-4o"));

  // Restore a clean state for the tests that follow.
  writeFileSync(modelsPath, JSON.stringify({ providers: {} }, null, 2), "utf8");
  rmSync(settingsPath, { force: true });
  await handlers["auth.deleteApiKey"]({ provider: "openai" });
});

test("runStartupMigrations lifts legacy enabledModels out of models.json at startup", async () => {
  const { handlers } = await captureHandlers();
  const { runStartupMigrations } = await loadHandlersModule();
  const modelsPath = path.join(isolatedAgentDirectory, "models.json");
  // google must be configured so its migrated filter pattern is mirrored
  // (unconfigured providers are kept in the map but never mirrored).
  await handlers["auth.setApiKey"]({ provider: "google", key: "secret" });
  writeFileSync(
    modelsPath,
    JSON.stringify(
      {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            enabledModels: ["gemini-2.5-pro"],
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  rmSync(settingsPath, { force: true });

  await runStartupMigrations();

  const rewritten = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.equal(rewritten.providers.google.baseUrl, "https://generativelanguage.googleapis.com/v1beta");
  assert.equal(rewritten.providers.google.enabledModels, undefined);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.ok(settings.enabledModels.includes("google/gemini-2.5-pro"));

  // Idempotent: a second run must not rewrite either file.
  const modelsBefore = readFileSync(modelsPath, "utf8");
  const settingsBefore = readFileSync(settingsPath, "utf8");
  await runStartupMigrations();
  assert.equal(readFileSync(modelsPath, "utf8"), modelsBefore);
  assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore);

  // Restore a clean state for the tests that follow.
  writeFileSync(modelsPath, JSON.stringify({ providers: {} }, null, 2), "utf8");
  rmSync(settingsPath, { force: true });
  await handlers["auth.deleteApiKey"]({ provider: "google" });
});

test("legacy sidecar file and desktop settings map key migrate into the canonical files", async () => {
  const { handlers } = await captureHandlers();
  const { migrateLegacyProviderModelFilters, runStartupMigrations } = await loadHandlersModule();
  const legacyPath = path.join(isolatedAgentDirectory, "pi-desktop-provider-model-filters.json");
  // google + anthropic must be configured so their migrated patterns are
  // mirrored; openai stays unconfigured (empty list → no pattern anyway).
  await handlers["auth.setApiKey"]({ provider: "google", key: "secret" });
  await handlers["auth.setApiKey"]({ provider: "anthropic", key: "secret" });

  // Earlier desktop versions stored the filter in <agent dir>/pi-desktop-provider-
  // model-filters.json; it must move into the desktop-owned map (mirrored to the
  // agent settings `enabledModels` key) and the legacy file removed.
  writeFileSync(legacyPath, JSON.stringify({ google: ["gemini-2.5-pro"], openai: [] }, null, 2), "utf8");
  rmSync(settingsPath, { force: true });
  rmSync(desktopSettingsPath, { force: true });

  await migrateLegacyProviderModelFilters();

  assert.equal(existsSync(legacyPath), false);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.ok(settings.enabledModels.includes("google/gemini-2.5-pro"));
  assert.equal(
    settings.enabledModels.some((pattern) => pattern.startsWith("openai/")),
    false,
    "an empty list must not emit openai patterns",
  );
  const desktopSettings = JSON.parse(readFileSync(desktopSettingsPath, "utf8"));
  assert.deepEqual(desktopSettings.piDesktopModelFilters.google, ["gemini-2.5-pro"]);
  assert.deepEqual(desktopSettings.piDesktopModelFilters.openai, []);

  // runStartupMigrations also renames the legacy `providerModelFilters` key an
  // intermediate desktop version wrote into ~/.pi/desktop/settings.json to
  // `piDesktopModelFilters` (the desktop settings file is kept — it is the
  // canonical home of the map).
  writeFileSync(legacyPath, JSON.stringify({ google: ["gemini-3.5-flash"] }, null, 2), "utf8");
  writeFileSync(
    desktopSettingsPath,
    JSON.stringify({ providerModelFilters: { anthropic: ["claude"] }, windowX: 10 }, null, 2),
    "utf8",
  );
  rmSync(settingsPath, { force: true });
  await runStartupMigrations();
  assert.equal(existsSync(legacyPath), false);
  const merged = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.ok(merged.enabledModels.includes("google/gemini-3.5-flash"));
  assert.ok(merged.enabledModels.includes("anthropic/claude"));
  const mergedDesktop = JSON.parse(readFileSync(desktopSettingsPath, "utf8"));
  assert.equal(
    mergedDesktop.providerModelFilters,
    undefined,
    "the legacy providerModelFilters key must be renamed, not kept alongside",
  );
  assert.deepEqual(mergedDesktop.piDesktopModelFilters.google, ["gemini-3.5-flash"]);
  assert.deepEqual(mergedDesktop.piDesktopModelFilters.anthropic, ["claude"]);
  assert.equal(mergedDesktop.windowX, 10, "unrelated desktop settings keys are preserved");

  // Idempotent: a second run must not rewrite either file.
  const settingsBefore = readFileSync(settingsPath, "utf8");
  const desktopBefore = readFileSync(desktopSettingsPath, "utf8");
  await runStartupMigrations();
  assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore);
  assert.equal(readFileSync(desktopSettingsPath, "utf8"), desktopBefore);

  rmSync(settingsPath, { force: true });
  rmSync(desktopSettingsPath, { force: true });
  await handlers["auth.deleteApiKey"]({ provider: "google" });
  await handlers["auth.deleteApiKey"]({ provider: "anthropic" });
});

test("piDesktopModelFilters left in agent settings.json moves into the desktop settings file", async () => {
  const { handlers } = await captureHandlers();
  const { runStartupMigrations } = await loadHandlersModule();
  const modelsPath = path.join(isolatedAgentDirectory, "models.json");
  writeFileSync(modelsPath, JSON.stringify({ providers: {} }, null, 2), "utf8");
  // openai must be configured so its migrated pattern is mirrored; groq stays
  // unconfigured (kept in the desktop map, never mirrored).
  await handlers["auth.setApiKey"]({ provider: "openai", key: "secret" });
  // A recent desktop version stored the desktop-owned map in the agent settings
  // file; it must move to ~/.pi/desktop/settings.json (pi never reads that
  // file, so only pi-native fields stay in the agent settings file).
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        windowX: 5,
        enabledModels: ["openai/gpt-4"],
        piDesktopModelFilters: { openai: ["gpt-4"], groq: [] },
      },
      null,
      2,
    ),
    "utf8",
  );
  rmSync(desktopSettingsPath, { force: true });

  await runStartupMigrations();

  const agent = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(
    agent.piDesktopModelFilters,
    undefined,
    "the desktop-owned map must leave the agent settings file pi parses",
  );
  assert.equal(agent.windowX, 5, "unrelated agent settings keys are preserved");
  assert.ok(agent.enabledModels.includes("openai/gpt-4"));
  assert.equal(
    agent.enabledModels.some((p) => p.startsWith("groq/")),
    false,
    "unconfigured providers must not be mirrored",
  );
  const desktop = JSON.parse(readFileSync(desktopSettingsPath, "utf8"));
  assert.deepEqual(desktop.piDesktopModelFilters.openai, ["gpt-4"]);
  assert.deepEqual(desktop.piDesktopModelFilters.groq, [], "unconfigured providers stay in the desktop map");
  assert.equal(desktop.enabledModels, undefined, "no pi-native key belongs in the desktop settings file");

  // Idempotent: a second run must not rewrite either file.
  const agentBefore = readFileSync(settingsPath, "utf8");
  const desktopBefore = readFileSync(desktopSettingsPath, "utf8");
  await runStartupMigrations();
  assert.equal(readFileSync(settingsPath, "utf8"), agentBefore);
  assert.equal(readFileSync(desktopSettingsPath, "utf8"), desktopBefore);

  // The stored map is the user's explicit state: an explicit empty list must
  // win over the pattern-derived guess (the `openai/<first>` pattern would
  // otherwise derive `openai: [<first>]`).
  const detail = await handlers["modelsConfig.providerModels"]({ providerId: "openai" });
  const firstId = detail.models[0].id;
  writeFileSync(
    settingsPath,
    JSON.stringify({ enabledModels: [`openai/${firstId}`], piDesktopModelFilters: { openai: [] } }, null, 2),
    "utf8",
  );
  rmSync(desktopSettingsPath, { force: true });
  await runStartupMigrations();
  const desktopOverride = JSON.parse(readFileSync(desktopSettingsPath, "utf8"));
  assert.deepEqual(
    desktopOverride.piDesktopModelFilters.openai,
    [],
    "explicit stored state overrides the pattern-derived guess",
  );
  const agentOverride = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(agentOverride.piDesktopModelFilters, undefined, "the agent-side map key is self-healed");

  rmSync(settingsPath, { force: true });
  rmSync(desktopSettingsPath, { force: true });
  await handlers["auth.deleteApiKey"]({ provider: "openai" });
});

test("modelsConfig.fetchModels validates input and reports failures clearly", async () => {
  const { handlers } = await captureHandlers();
  const missing = await handlers["modelsConfig.fetchModels"]({ baseUrl: "" });
  assert.equal(missing.ok, false);
  const invalid = await handlers["modelsConfig.fetchModels"]({ baseUrl: "not-a-url" });
  assert.equal(invalid.ok, false);
  const badProtocol = await handlers["modelsConfig.fetchModels"]({ baseUrl: "ftp://example.com/v1" });
  assert.equal(badProtocol.ok, false);
});

test("modelsConfig.fetchModels supports the Google Generative Language API", async () => {
  const { handlers } = await captureHandlers();
  const seenKeys = new Set();
  const seenTokens = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const key = req.headers["x-goog-api-key"];
    seenKeys.add(key ?? "(none)");
    assert.equal(url.pathname, "/v1beta/models");
    assert.equal(key, "TESTKEY");
    const pageToken = url.searchParams.get("pageToken") ?? "";
    seenTokens.add(pageToken || "(first)");
    const models = [{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(pageToken === "next" ? { models } : { models, nextPageToken: "next" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    const u = new URL(url);
    if (u.hostname === "generativelanguage.googleapis.com") {
      return realFetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, options);
    }
    return realFetch(url, options);
  };
  try {
    const res = await handlers["modelsConfig.fetchModels"]({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "TESTKEY",
    });
    assert.equal(res.ok, true);
    assert.deepEqual(res.models, [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }]);
    assert.ok(seenTokens.size >= 2, "pagination followed via nextPageToken");
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});

test("sessions.get returns the contract shape without rescanning known session paths", async (t) => {
  const sessionDirectory = path.join(process.env.PI_CODING_AGENT_SESSION_DIR, "contract-fixture");
  mkdirSync(sessionDirectory, { recursive: true });
  const sessionId = "contract-session";
  const sessionPath = path.join(sessionDirectory, `2026-08-06T00-00-00-000Z_${sessionId}.jsonl`);
  const entries = [
    {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-08-06T00:00:00.000Z",
      cwd: root,
    },
    {
      type: "message",
      id: "user-one",
      parentId: null,
      timestamp: "2026-08-06T00:00:01.000Z",
      message: { role: "user", content: "hello", timestamp: 1_786_060_801_000 },
    },
    {
      type: "message",
      id: "assistant-one",
      parentId: "user-one",
      timestamp: "2026-08-06T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
        stopReason: "stop",
        timestamp: 1_786_060_802_000,
      },
    },
    {
      type: "message",
      id: "user-two",
      parentId: "assistant-one",
      timestamp: "2026-08-06T00:00:03.000Z",
      message: { role: "user", content: "second", timestamp: 1_786_060_803_000 },
    },
    {
      type: "message",
      id: "assistant-two",
      parentId: "user-two",
      timestamp: "2026-08-06T00:00:04.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "second answer" }],
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
        stopReason: "stop",
        timestamp: 1_786_060_804_000,
      },
    },
  ];
  writeFileSync(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

  const { handlers } = await captureHandlers();
  const listed = await handlers["sessions.list"]();
  assert.equal(
    listed.sessions.some((session) => session.id === sessionId),
    true,
  );

  const originalListAll = SessionManager.listAll;
  SessionManager.listAll = async () => {
    throw new Error("global scan must not run");
  };
  t.after(() => {
    SessionManager.listAll = originalListAll;
  });

  const detail = await handlers["sessions.get"]({ id: sessionId });
  assert.deepEqual(Object.keys(detail).sort(), ["context", "filePath", "info", "leafId", "sessionId", "tree"]);
  assert.equal(detail.sessionId, sessionId);
  assert.equal(detail.filePath, sessionPath);
  assert.equal(detail.info.id, sessionId);
  assert.equal(detail.info.messageCount, 4);
  assert.equal(detail.info.firstMessage, "hello");
  assert.deepEqual(detail.context.entryIds, ["user-one", "assistant-one", "user-two", "assistant-two"]);
  assert.equal(detail.context.messages.length, 4);

  const paged = await handlers["sessions.get"]({ id: sessionId, historyWindow: { maxTurns: 1, maxBytes: 64 * 1024 } });
  assert.deepEqual(paged.context.entryIds, ["user-two", "assistant-two"]);
  assert.equal(paged.context.truncatedBefore, true);
  const older = await handlers["sessions.contextPage"]({ id: sessionId, cursor: paged.context.previousCursor });
  assert.deepEqual(older.context.entryIds, ["user-one", "assistant-one"]);
  const cursorPayload = JSON.parse(Buffer.from(paged.context.previousCursor, "base64url").toString("utf8"));
  const staleCursor = Buffer.from(
    JSON.stringify({ ...cursorPayload, historyRevision: "stale-revision" }),
    "utf8",
  ).toString("base64url");
  await assert.rejects(
    handlers["sessions.contextPage"]({ id: sessionId, cursor: staleCursor }),
    (error) => error.code === "STALE_CURSOR",
  );
  await assert.rejects(
    handlers["sessions.contextPage"]({ id: sessionId, cursor: "invalid" }),
    (error) => error.code === "BAD_REQUEST",
  );
  assert.deepEqual(await handlers["sessions.entryContent"]({ id: sessionId, entryId: "assistant-two" }), {
    content: { type: "text", text: "second answer" },
    deferredContent: {
      entryId: "assistant-two",
      blockIndex: 0,
      originalBytes: Buffer.byteLength(JSON.stringify({ type: "text", text: "second answer" }), "utf8"),
      contentType: "text",
    },
  });
  await assert.rejects(
    handlers["sessions.entryContent"]({ id: sessionId, entryId: "another-session-entry", blockIndex: 0 }),
    (error) => error.code === "NOT_FOUND",
  );
});

test("parseProxyServerString handles Windows ProxyServer formats", async () => {
  const { parseProxyServerString } = await loadHandlersModule();
  // Per-protocol form
  assert.deepEqual(parseProxyServerString("http=127.0.0.1:7890;https=127.0.0.1:7891;ftp=127.0.0.1:21"), {
    httpProxy: "http://127.0.0.1:7890",
    httpsProxy: "http://127.0.0.1:7891",
    enabled: true,
  });
  // Bare host:port applies to both protocols
  assert.deepEqual(parseProxyServerString("127.0.0.1:7890"), {
    httpProxy: "http://127.0.0.1:7890",
    httpsProxy: "http://127.0.0.1:7890",
    enabled: true,
  });
  // Legacy secure= suffix
  assert.deepEqual(parseProxyServerString("10.0.0.1:8080;secure=10.0.0.1:8443"), {
    httpProxy: "http://10.0.0.1:8080",
    httpsProxy: "http://10.0.0.1:8443",
    enabled: true,
  });
  // https= without a scheme means an HTTP-transport proxy used for HTTPS traffic
  assert.deepEqual(parseProxyServerString("https=proxy.example.com:443"), {
    httpProxy: "",
    httpsProxy: "http://proxy.example.com:443",
    enabled: true,
  });
  // Explicit scheme in the value is preserved
  assert.deepEqual(parseProxyServerString("https=https://proxy.example.com:443"), {
    httpProxy: "",
    httpsProxy: "https://proxy.example.com:443",
    enabled: true,
  });
  // Empty / no proxy
  assert.deepEqual(parseProxyServerString(""), {
    httpProxy: "",
    httpsProxy: "",
    enabled: false,
  });
});

test("models.list honors enabledModels in agent settings.json (pi-compatible patterns)", async () => {
  const { handlers } = await captureHandlers();
  // `enabledModels` in the agent settings file is pi's native allowlist, which
  // the pi CLI applies at startup. The desktop picker must scope models the
  // same way so both surfaces agree on the usable models.
  const settingsPath = path.join(isolatedAgentDirectory, "settings.json");
  const detail = await handlers["modelsConfig.providerModels"]({ providerId: "openai" });
  const firstId = detail.models[0].id;
  await handlers["auth.setApiKey"]({ provider: "openai", key: "secret" });
  try {
    writeFileSync(settingsPath, JSON.stringify({ enabledModels: [`openai/${firstId}`] }, null, 2));
    const listed = await handlers["models.list"]({ cwd: root });
    const openaiModels = listed.models.filter((m) => m.provider === "openai");
    assert.deepEqual(
      openaiModels.map((m) => m.id),
      [firstId],
      "canonical pattern must scope the picker",
    );

    // A bare glob matches every model, mirroring pi's resolver (provider/modelId
    // OR bare modelId).
    writeFileSync(settingsPath, JSON.stringify({ enabledModels: ["*"] }, null, 2));
    const listedAll = await handlers["models.list"]({ cwd: root });
    assert.ok(
      listedAll.models.filter((m) => m.provider === "openai").length > 1,
      "a catch-all pattern must not restrict models",
    );
  } finally {
    rmSync(settingsPath, { force: true });
    await handlers["auth.deleteApiKey"]({ provider: "openai" });
  }
});

test("a hand-written partial enabledModels allowlist filters the picker without listing every provider", async () => {
  const { handlers } = await captureHandlers();
  const settingsPath = path.join(isolatedAgentDirectory, "settings.json");
  rmSync(settingsPath, { force: true });
  const detail = await handlers["modelsConfig.providerModels"]({ providerId: "openai" });
  const firstId = detail.models[0].id;
  // pi-style patterns written by hand (no desktop-owned map key): only the
  // providers the allowlist mentions with a partial match may surface as
  // "filtered" in the model panel. Unmentioned providers are NOT configured.
  writeFileSync(
    settingsPath,
    JSON.stringify({ enabledModels: [`openai/${firstId}`, "google/**", "radius/**"] }, null, 2),
  );
  try {
    const providers = await handlers["modelsConfig.providers"]();
    const byId = new Map(providers.providers.map((p) => [p.id, p]));
    assert.ok(byId.has("openai"), "openai is a built-in provider");
    assert.deepEqual(
      byId.get("openai").enabledModels,
      [firstId],
      "a mentioned provider with a partial match is filtered to the matching models",
    );
    // google/** matches every google model → no filter reported.
    if (byId.has("google")) assert.equal(byId.get("google").enabledModels, undefined);
    // Providers the allowlist never mentions must not look configured.
    for (const id of ["anthropic", "amazon-bedrock", "groq"]) {
      if (byId.has(id)) assert.equal(byId.get(id).enabledModels, undefined, `${id} must not look filtered`);
    }
  } finally {
    rmSync(settingsPath, { force: true });
  }
});

test("testProxyConnectivity probes through a working proxy and reports failures", async () => {
  const { testProxyConnectivity } = await loadHandlersModule();

  // No proxy configured
  assert.deepEqual(await testProxyConnectivity("", ""), {
    ok: false,
    error: "No proxy configured",
    probes: [],
  });

  // Invalid proxy URL fails cleanly instead of throwing
  const invalid = await testProxyConnectivity("not a url", "", [{ protocol: "http", url: "http://127.0.0.1:1/probe" }]);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.probes.length, 1);
  assert.equal(invalid.probes[0].ok, false);

  // Working local proxy. undici tunnels even plain-HTTP traffic through
  // CONNECT, so the mock must answer CONNECT and pipe to the real target.
  const target = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetAddress = target.address();
  assert.ok(targetAddress && typeof targetAddress === "object");
  const targetPort = targetAddress.port;

  const proxy = http.createServer();
  proxy.on("connect", (req, clientSocket, head) => {
    const [host, port] = req.url.split(":");
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established" + "\r\n\r\n");
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  const proxyPort = proxyAddress.port;
  try {
    const result = await testProxyConnectivity(`http://127.0.0.1:${proxyPort}`, "", [
      { protocol: "http", url: `http://127.0.0.1:${targetPort}/probe` },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.probes.length, 1);
    assert.equal(result.probes[0].ok, true);
    assert.equal(result.probes[0].status, 200);
    assert.ok(typeof result.probes[0].latencyMs === "number");

    // Refused upstream reports a failure
    const refused = await testProxyConnectivity(`http://127.0.0.1:${proxyPort}`, "", [
      { protocol: "http", url: "http://127.0.0.1:1/probe" },
    ]);
    assert.equal(refused.ok, false);
    assert.equal(refused.probes[0].ok, false);
  } finally {
    proxy.close();
    target.close();
  }
});
test("parseScutilProxyOutput handles real scutil --proxy formats", async () => {
  const { parseScutilProxyOutput } = await loadHandlersModule();
  // Manual HTTP + HTTPS proxy (typical ClashX / Surge setup)
  assert.deepEqual(
    parseScutilProxyOutput(`<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
}`),
    { httpProxy: "http://127.0.0.1:7890", httpsProxy: "http://127.0.0.1:7890", enabled: true },
  );

  // HTTP only: HTTPS falls back to the HTTP proxy
  assert.deepEqual(
    parseScutilProxyOutput(`<dictionary> {
  HTTPEnable : 1
  HTTPPort : 8080
  HTTPProxy : proxy.example.com
}`),
    { httpProxy: "http://proxy.example.com:8080", httpsProxy: "http://proxy.example.com:8080", enabled: true },
  );

  // Missing or zero port: omitted from the URL
  assert.deepEqual(
    parseScutilProxyOutput(`<dictionary> {
  HTTPEnable : 1
  HTTPProxy : 10.0.0.1
  HTTPPort : 0
}`),
    { httpProxy: "http://10.0.0.1", httpsProxy: "http://10.0.0.1", enabled: true },
  );

  // <NULL> values are treated as unset, never as literal hosts
  assert.deepEqual(
    parseScutilProxyOutput(`<dictionary> {
  HTTPEnable : 1
  HTTPProxy : <NULL>
  HTTPSEnable : 0
}`),
    { httpProxy: "", httpsProxy: "", enabled: false },
  );

  // PAC mode: the URL is a script, not a usable proxy endpoint
  assert.deepEqual(
    parseScutilProxyOutput(`<dictionary> {
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://pac.example.com/proxy.pac
  HTTPEnable : 0
}`),
    { httpProxy: "", httpsProxy: "", enabled: false },
  );

  // IPv6 host is bracketed into a valid URL
  assert.deepEqual(
    parseScutilProxyOutput(`<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : ::1
}`),
    { httpProxy: "http://[::1]:7890", httpsProxy: "http://[::1]:7890", enabled: true },
  );

  // No proxy configured at all
  assert.deepEqual(parseScutilProxyOutput(`<dictionary> {\n}\n`), {
    httpProxy: "",
    httpsProxy: "",
    enabled: false,
  });
});

test("networkProxy.set persists settings.json and preserves unrelated keys", async () => {
  const settingsPath = path.join(isolatedAgentDirectory, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ npmCommand: ["npm"] }, null, 2));
  const { handlers } = await captureHandlers();
  try {
    const result = await handlers["networkProxy.set"]({ httpProxy: "http://127.0.0.1:7890" });
    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(stored.httpProxy, "http://127.0.0.1:7890");
    assert.deepEqual(stored.npmCommand, ["npm"], "unrelated settings keys must survive a proxy update");
    assert.deepEqual(await handlers["networkProxy.get"](), {
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "",
    });

    // Clearing both fields removes them from settings.json
    await handlers["networkProxy.set"]({ httpProxy: "", httpsProxy: "" });
    const cleared = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal("httpProxy" in cleared, false);
    assert.equal("httpsProxy" in cleared, false);
    assert.deepEqual(cleared.npmCommand, ["npm"]);
  } finally {
    writeFileSync(settingsPath, JSON.stringify({}, null, 2));
  }
});

test("corrupt settings.json surfaces PARSE_ERROR and is never overwritten", async () => {
  const settingsPath = path.join(isolatedAgentDirectory, "settings.json");
  const corrupt = "{ definitely not valid json";
  writeFileSync(settingsPath, corrupt);
  const { handlers } = await captureHandlers();
  try {
    assert.throws(
      () => handlers["networkProxy.get"](),
      (error) => error?.code === "PARSE_ERROR",
    );
    assert.throws(
      () => handlers["networkProxy.set"]({ httpProxy: "http://127.0.0.1:7890" }),
      (error) => error?.code === "PARSE_ERROR",
    );
    assert.equal(readFileSync(settingsPath, "utf8"), corrupt, "corrupt settings.json must not be clobbered");
  } finally {
    writeFileSync(settingsPath, JSON.stringify({}, null, 2));
  }
});

test("applySavedProxySettings restores proxy env vars from settings.json", async () => {
  const settingsPath = path.join(isolatedAgentDirectory, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ httpProxy: "http://proxy.local:8080" }, null, 2));
  const { applySavedProxySettings } = await loadHandlersModule();
  const savedHttp = process.env.HTTP_PROXY;
  const savedHttps = process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  try {
    applySavedProxySettings();
    assert.equal(process.env.HTTP_PROXY, "http://proxy.local:8080");
    assert.equal(process.env.HTTPS_PROXY, "http://proxy.local:8080", "HTTPS falls back to the HTTP proxy");
  } finally {
    if (savedHttp !== undefined) process.env.HTTP_PROXY = savedHttp;
    else delete process.env.HTTP_PROXY;
    if (savedHttps !== undefined) process.env.HTTPS_PROXY = savedHttps;
    else delete process.env.HTTPS_PROXY;
    writeFileSync(settingsPath, JSON.stringify({}, null, 2));
  }
});
