/**
 * Proxy configuration shared by the agent-host entry point and the
 * networkProxy RPC handlers.
 *
 * pi-coding-agent's SDK path (`createAgentSessionServices`) does not configure
 * an HTTP dispatcher the way its CLI entry does, so model API calls would not
 * honor HTTP_PROXY / HTTPS_PROXY. The agent host therefore installs an
 * EnvHttpProxyAgent over the global undici dispatcher (the same mechanism pi's
 * CLI uses via `configureHttpDispatcher`), making globalThis.fetch traffic —
 * LLM API calls, model list fetches — respect the configured proxy.
 *
 * `networkProxy.set` persists the values in settings.json and re-applies them
 * immediately; `applySavedProxySettings` restores them after a restart.
 */
import { EnvHttpProxyAgent, install as undiciInstall, setGlobalDispatcher } from "undici";

export interface ProxyUrlPair {
  httpProxy?: string;
  httpsProxy?: string;
}

/** Set HTTP_PROXY / HTTPS_PROXY for this process. HTTPS falls back to HTTP. */
export function applyProxyEnvVars(httpProxy: string | undefined, httpsProxy: string | undefined): void {
  const http = httpProxy?.trim() ?? "";
  const https = httpsProxy?.trim() ?? "";
  if (http) process.env.HTTP_PROXY = http;
  else delete process.env.HTTP_PROXY;
  if (https) process.env.HTTPS_PROXY = https;
  else if (http) process.env.HTTPS_PROXY = http;
  else delete process.env.HTTPS_PROXY;
}

let fetchPatched = false;

/**
 * (Re)create the EnvHttpProxyAgent and install it as the global dispatcher.
 * Recreated on every call so runtime proxy changes (networkProxy.set) apply
 * immediately; global fetch is patched only once.
 */
export function configureProxyDispatcher(): void {
  const dispatcher = new EnvHttpProxyAgent({
    allowH2: false,
    connect: {
      autoSelectFamilyAttemptTimeout: 2_000,
    },
  });
  setGlobalDispatcher(dispatcher);
  if (!fetchPatched) {
    // Route globalThis.fetch through the dispatcher (mirrors pi's CLI setup).
    undiciInstall?.();
    fetchPatched = true;
  }
}
