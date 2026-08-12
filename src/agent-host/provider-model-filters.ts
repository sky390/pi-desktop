/**
 * Desktop-owned "enabled models" selection.
 *
 * The desktop lets users enable/disable individual models per built-in
 * provider. The selection is split across two files:
 *
 *  - `~/.pi/agent/settings.json` → `enabledModels` — pi's native key. pi's CLI
 *    reads it at startup to scope its available models (patterns matched with
 *    minimatch on `provider/modelId` or a bare `modelId`). Only pi-native
 *    fields live here: anything pi does not recognize belongs in the desktop
 *    settings file instead.
 *  - `~/.pi/desktop/settings.json` → `piDesktopModelFilters` — a desktop-owned
 *    per-provider map (providerId → enabled model ids) that is the source of
 *    truth for the desktop UI. pi's CLI never reads the desktop settings file,
 *    so the map lives there (not in the agent settings file pi parses); every
 *    desktop write regenerates the `enabledModels` patterns from it, and reads
 *    prefer it over pattern resolution so the model panel only ever shows
 *    providers the user actually touched.
 *
 * pi's setting is a flat allowlist of patterns while the desktop UI works per
 * provider, so this module bridges the two:
 *  - `providerFiltersToPatterns` turns the per-provider map into pi patterns:
 *    a provider absent from the map (every model enabled) becomes
 *    `providerId/**` (a glob that crosses `/` — some providers, e.g.
 *    huggingface, have model ids containing slashes); a provider with an
 *    explicit list becomes one `providerId/modelId` pattern per model; an
 *    empty list (every model disabled) contributes nothing. Only providers pi
 *    actually resolves models for are iterated — pi scopes its model list to
 *    configured providers, so a pattern for an unconfigured provider would
 *    match nothing and make pi warn "No models match pattern".
 *  - `patternsToProviderFilters` resolves hand-written or legacy patterns back
 *    into a per-provider map, treating a provider whose models all match as
 *    unfiltered, so `providerId/**` round-trips to "all enabled".
 *
 * The selection must NOT be persisted inside models.json: pi's CLI validates
 * provider entries and errors out on unknown fields such as `enabledModels`
 * (`Provider "x": must specify "baseUrl", "headers", ...`).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { RpcError } from "../contract/types";

/** Path of the agent settings file pi itself reads (e.g. `~/.pi/agent/settings.json`). */
function getAgentSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

/**
 * Path of the desktop-owned settings file (e.g. `~/.pi/desktop/settings.json`),
 * next to the agent dir. pi's CLI never reads this file — it only holds
 * desktop-owned config, so unknown-to-pi fields live here rather than in the
 * agent settings file.
 */
export function getDesktopSettingsPath(): string {
  return join(dirname(getAgentDir()), "desktop", "settings.json");
}

/**
 * Read the pi-native `enabledModels` patterns from the agent settings file.
 *
 * - `undefined` → no `enabledModels` key: every model is usable.
 * - `[]` → the key exists but is empty: nothing is usable (pi's scope is empty).
 *
 * A corrupt or missing settings file is treated as "no filter" so model
 * listing never breaks because of an unrelated, unparseable settings file.
 */
export function readEnabledModelPatterns(): string[] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(getAgentSettingsPath(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const raw = (parsed as Record<string, unknown>).enabledModels;
    if (!Array.isArray(raw)) return undefined;
    return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  } catch {
    return undefined;
  }
}

/**
 * Read-modify-write the agent settings file, preserving unrelated keys
 * (`httpProxy`, `httpsProxy`, `defaultProvider`, ...).
 *
 * A corrupt settings file surfaces PARSE_ERROR (ISSUE-009) and is never
 * clobbered — the caller must surface the error so the user can fix the file.
 */
function updateAgentSettings(mutate: (settings: Record<string, unknown>) => void): void {
  const filePath = getAgentSettingsPath();
  let settings: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new RpcError({ code: "PARSE_ERROR", message: "settings.json must contain a JSON object" });
    }
    settings = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RpcError) throw error;
    if (error instanceof SyntaxError) {
      throw new RpcError({
        code: "PARSE_ERROR",
        message: `Failed to parse settings.json: ${error.message}`,
      });
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      settings = {};
    } else {
      throw error;
    }
  }
  mutate(settings);
  const tmp = `${filePath}.${process.pid}.tmp`;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
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
 * Write the pi-native `enabledModels` patterns into the agent settings file.
 * `undefined` removes the key entirely (no filter). An empty array is written
 * as-is: it is pi's explicit "nothing enabled" scope, distinct from "no key".
 */
export function writeEnabledModelPatterns(patterns: string[] | undefined): void {
  updateAgentSettings((settings) => {
    if (patterns === undefined) delete settings.enabledModels;
    else settings.enabledModels = patterns;
  });
}

/** Desktop-owned per-provider filter map key, ignored by pi. */
const DESKTOP_MODEL_FILTERS_KEY = "piDesktopModelFilters";

/** Legacy key name an intermediate desktop version used for the same map. */
const LEGACY_DESKTOP_MODEL_FILTERS_KEY = "providerModelFilters";

/**
 * Read-modify-write the desktop settings file (`<pi-home>/desktop/settings.json`),
 * preserving unrelated keys. A corrupt file surfaces PARSE_ERROR (ISSUE-009)
 * and is never clobbered.
 */
function updateDesktopSettings(mutate: (settings: Record<string, unknown>) => void): void {
  const filePath = getDesktopSettingsPath();
  let settings: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new RpcError({ code: "PARSE_ERROR", message: "desktop settings.json must contain a JSON object" });
    }
    settings = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RpcError) throw error;
    if (error instanceof SyntaxError) {
      throw new RpcError({
        code: "PARSE_ERROR",
        message: `Failed to parse desktop settings.json: ${error.message}`,
      });
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      settings = {};
    } else {
      throw error;
    }
  }
  mutate(settings);
  const tmp = `${filePath}.${process.pid}.tmp`;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
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
 * Read the per-provider filter map (`piDesktopModelFilters`) from a settings
 * JSON object. Returns `undefined` when the key is absent.
 */
function readModelFilterMapFrom(parsed: unknown): Record<string, string[]> | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const raw = (parsed as Record<string, unknown>)[DESKTOP_MODEL_FILTERS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result: Record<string, string[]> = {};
  for (const [providerId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      result[providerId] = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    }
  }
  return result;
}

/**
 * Read the desktop-owned per-provider filter map (`piDesktopModelFilters`) from
 * the desktop settings file. Returns `undefined` when the key is absent.
 */
export function readDesktopModelFilterMap(): Record<string, string[]> | undefined {
  try {
    return readModelFilterMapFrom(JSON.parse(readFileSync(getDesktopSettingsPath(), "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * Read the per-provider filter map a recent desktop version stored in the
 * agent settings file under `piDesktopModelFilters` (before the map moved to
 * the desktop settings file). Returns `undefined` when the key is absent.
 */
export function readAgentSettingsModelFilterMap(): Record<string, string[]> | undefined {
  try {
    return readModelFilterMapFrom(JSON.parse(readFileSync(getAgentSettingsPath(), "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * Read the desktop-style per-provider filter map (providerId → enabled model
 * ids). Prefers the desktop-owned `piDesktopModelFilters` key; when it is
 * absent (hand-written or legacy `enabledModels`), the map is derived from the
 * patterns against the given per-provider model lists. `modelsByProvider` is
 * only consulted in that fallback, so it may be a single provider's models
 * when only one provider is being inspected.
 */
export function readProviderModelFilters(
  modelsByProvider?: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  const stored = readDesktopModelFilterMap();
  if (stored) return stored;
  return patternsToProviderFilters(readEnabledModelPatterns(), modelsByProvider ?? {});
}

/**
 * Write the desktop-style per-provider filter map into the desktop settings
 * file and its derived pi-native `enabledModels` mirror into the agent
 * settings file, preserving unrelated keys in both. pi's CLI only understands
 * the `enabledModels` mirror (agent file); the desktop-only map lives in the
 * desktop settings file pi never reads.
 *
 * `resolvableProviderIds` must be the providers pi actually resolves models
 * for (configured ones): patterns are only emitted for those, so the mirror
 * never mentions a provider pi has no models for (which would make pi warn
 * "No models match pattern").
 *
 * An empty map removes both keys (no filter at all).
 */
export function writeProviderModelFilters(
  filters: Record<string, string[]>,
  resolvableProviderIds: readonly string[],
): void {
  const patterns = providerFiltersToPatterns(filters, resolvableProviderIds);
  updateAgentSettings((settings) => {
    if (patterns === undefined) delete settings.enabledModels;
    else settings.enabledModels = patterns;
    // Self-heal: a recent desktop version stored the map in the agent settings
    // file under this key; it belongs in the desktop settings file instead.
    delete settings[DESKTOP_MODEL_FILTERS_KEY];
  });
  updateDesktopSettings((settings) => {
    if (Object.keys(filters).length === 0) delete settings[DESKTOP_MODEL_FILTERS_KEY];
    else settings[DESKTOP_MODEL_FILTERS_KEY] = filters;
    // Self-heal the legacy key name an intermediate desktop version used.
    delete settings[LEGACY_DESKTOP_MODEL_FILTERS_KEY];
  });
}

/**
 * Regenerate the pi-native `enabledModels` mirror from the desktop-owned map,
 * restricted to the providers pi actually resolves models for. This self-heals
 * a mirror polluted by an older desktop version (e.g. `providerId/**` patterns
 * for unconfigured providers, which make pi warn). Returns whether a write
 * happened. No-op when the desktop map is absent (hand-written patterns or no
 * selection) so user-authored `enabledModels` are never rewritten.
 */
export function repairEnabledModelsMirror(resolvableProviderIds: readonly string[]): boolean {
  const map = readDesktopModelFilterMap();
  if (map === undefined) return false;
  const patterns = providerFiltersToPatterns(map, resolvableProviderIds);
  const current = readEnabledModelPatterns();
  if (JSON.stringify(patterns ?? null) === JSON.stringify(current ?? null)) return false;
  writeProviderModelFilters(map, resolvableProviderIds);
  return true;
}

const THINKING_SUFFIXES = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

/** Drop a `:thinkingLevel` pin from a model reference (e.g. `anthropic/*:high`). */
export function stripThinkingSuffix(modelRef: string): string {
  const trimmed = modelRef.trim();
  const colonIndex = trimmed.lastIndexOf(":");
  if (colonIndex === -1) return trimmed;
  const suffix = trimmed.substring(colonIndex + 1);
  return THINKING_SUFFIXES.has(suffix) ? trimmed.substring(0, colonIndex) : trimmed;
}

/** Convert a glob (minimatch-style) into a case-insensitive anchored regex. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close !== -1) {
        let cls = glob.slice(i + 1, close).replace(/\\/g, "\\\\");
        if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
        out += `[${cls}]`;
        i = close;
      } else {
        out += "\\[";
      }
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "i");
}

/**
 * Match one pi-style `enabledModels` pattern against a model, mirroring pi's
 * resolver semantics: exact `provider/modelId` or bare `modelId` match, then
 * minimatch-style glob against `provider/modelId` or the bare `modelId`
 * (so `*sonnet*` matches without a provider prefix), then — for plain
 * non-glob patterns — substring matching on the bare model id.
 */
export function patternMatchesModel(pattern: string, providerId: string, modelId: string): boolean {
  const cleaned = stripThinkingSuffix(pattern).trim();
  if (!cleaned) return false;
  const fullId = `${providerId}/${modelId}`;
  if (fullId.toLowerCase() === cleaned.toLowerCase() || modelId.toLowerCase() === cleaned.toLowerCase()) {
    return true;
  }
  if (cleaned.includes("*") || cleaned.includes("?") || cleaned.includes("[")) {
    const re = globToRegExp(cleaned);
    return re.test(fullId) || re.test(modelId);
  }
  return modelId.toLowerCase().includes(cleaned.toLowerCase());
}

/**
 * Translate a desktop-style per-provider filter map (providerId → enabled
 * model ids) into pi-native `enabledModels` patterns.
 *
 * Only `resolvableProviderIds` (the providers pi resolves models for — i.e.
 * configured ones) are iterated. pi scopes its model list to configured
 * providers, so writing a pattern for an unconfigured provider would match
 * nothing and make pi emit "No models match pattern" warnings.
 *
 * - provider absent from the map → `providerId/**` (every model stays enabled;
 *   `**` crosses `/` so providers with slashed model ids are covered too);
 * - provider with a list → one `providerId/modelId` pattern per enabled model;
 * - provider with an empty list → contributes nothing (every model disabled).
 *
 * Returns `undefined` when no provider is filtered at all — callers should
 * then remove the `enabledModels` key instead of writing `providerId/**`
 * patterns that would pin the scope to today's provider set.
 */
export function providerFiltersToPatterns(
  filters: Record<string, string[]>,
  resolvableProviderIds: readonly string[],
): string[] | undefined {
  if (Object.keys(filters).length === 0) return undefined;
  const patterns: string[] = [];
  for (const providerId of resolvableProviderIds) {
    const enabled = filters[providerId];
    if (enabled === undefined) {
      patterns.push(`${providerId}/**`);
    } else {
      for (const id of enabled) {
        const trimmed = id.trim();
        if (trimmed) patterns.push(`${providerId}/${trimmed}`);
      }
    }
  }
  // No usable provider produced any pattern (e.g. nothing is configured yet):
  // treat as "no filter" rather than pi's empty scope.
  return patterns.length > 0 ? patterns : undefined;
}

/**
 * Resolve pi-native `enabledModels` patterns into a desktop-style per-provider
 * map (providerId → enabled model ids), using each provider's available model
 * ids. A provider whose models all match the patterns is left absent (no
 * filter = all enabled); a provider whose models match nothing is also left
 * absent — the allowlist simply never mentions it, which is different from an
 * explicit "disable every model" (that state only exists in the desktop-owned
 * `piDesktopModelFilters` map).
 */
export function patternsToProviderFilters(
  patterns: string[] | undefined,
  modelsByProvider: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!patterns || patterns.length === 0) return result;
  for (const [providerId, modelIds] of Object.entries(modelsByProvider)) {
    if (modelIds.length === 0) continue;
    const matched = modelIds.filter((id) => patterns.some((pattern) => patternMatchesModel(pattern, providerId, id)));
    if (matched.length === 0 || matched.length === modelIds.length) continue; // untouched or all enabled → no filter
    result[providerId] = matched;
  }
  return result;
}

/** Legacy per-provider filter file written by earlier desktop versions. */
export function getLegacyProviderModelFiltersPath(): string {
  return join(getAgentDir(), "pi-desktop-provider-model-filters.json");
}

/**
 * Read the legacy sidecar filter file (`<agent dir>/pi-desktop-provider-model-
 * filters.json`) written by earlier desktop versions. Returns `undefined` when
 * the file is absent or unreadable.
 */
export function readLegacyProviderModelFilters(): Record<string, string[]> | undefined {
  const legacyPath = getLegacyProviderModelFiltersPath();
  if (!existsSync(legacyPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(legacyPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const result: Record<string, string[]> = {};
    for (const [providerId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        result[providerId] = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
      }
    }
    return result;
  } catch {
    return undefined;
  }
}

/**
 * Read the per-provider filter map stored by an intermediate desktop version
 * under the legacy `providerModelFilters` key of the desktop settings file.
 * Returns `undefined` when the key is absent (nothing to migrate).
 */
export function readLegacyDesktopSettingsFilters(): Record<string, string[]> | undefined {
  const filePath = getDesktopSettingsPath();
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const raw = (parsed as Record<string, unknown>)[LEGACY_DESKTOP_MODEL_FILTERS_KEY];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const result: Record<string, string[]> = {};
    for (const [providerId, value] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        result[providerId] = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
      }
    }
    return result;
  } catch {
    return undefined;
  }
}
