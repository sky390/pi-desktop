/**
 * Watch ~/.pi/agent session directory and push sessions.changed events.
 */
import fs from "fs";
import path from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RpcServer } from "../contract/rpc";
import { invalidateAllowedRootsCache, setAllowedRootsWatcherHealthy } from "./file-access";
import { sessionIndex } from "./session-index";
import { classifySessionWatchChange } from "./session-watch-policy";

export function startSessionWatcher(server: RpcServer): () => void {
  let agentDir: string;
  try {
    agentDir = getAgentDir();
  } catch {
    return () => {};
  }

  if (!fs.existsSync(agentDir)) {
    try {
      fs.mkdirSync(agentDir, { recursive: true });
    } catch {
      return () => {};
    }
  }

  const sessionsRoot = path.resolve(process.env.PI_CODING_AGENT_SESSION_DIR || path.join(agentDir, "sessions"));
  const changedPaths = new Set<string>();
  let fullRefreshRequired = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounce = (changedPath?: string) => {
    if (changedPath) changedPaths.add(changedPath);
    else fullRefreshRequired = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void (async () => {
        timer = null;
        try {
          invalidateAllowedRootsCache();
          const pendingPaths = [...changedPaths];
          changedPaths.clear();
          const shouldRefreshAll = fullRefreshRequired;
          fullRefreshRequired = false;
          if (shouldRefreshAll) {
            await sessionIndex.refreshAll();
            server.emit("sessions.changed", "*", { cwd: null, fullRefresh: true });
            return;
          }
          for (const filePath of pendingPaths) {
            const previous = sessionIndex.getByPath(filePath);
            const session = await sessionIndex.refreshPath(filePath);
            if (session) {
              server.emit("sessions.changed", session.id, { cwd: session.cwd, sessionId: session.id, session });
            } else if (previous) {
              server.emit("sessions.changed", previous.id, {
                cwd: previous.cwd,
                sessionId: previous.id,
                deleted: true,
              });
            } else {
              server.emit("sessions.changed", "*", { cwd: null, fullRefresh: true });
            }
          }
        } catch (error) {
          console.error("[agent-host] session watcher refresh failed:", error);
          server.emit("sessions.changed", "*", { cwd: null, fullRefresh: true });
        }
      })();
    }, 300);
  };

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(agentDir, { recursive: true }, (_event, filename) => {
      const change = classifySessionWatchChange(agentDir, sessionsRoot, filename);
      if (change.kind === "refresh-path") debounce(change.path);
      else if (change.kind === "refresh-all") debounce();
    });
    watcher.on("error", (err) => {
      console.error("[agent-host] session watcher error:", err);
      setAllowedRootsWatcherHealthy(false);
      invalidateAllowedRootsCache();
    });
    setAllowedRootsWatcherHealthy(true);
  } catch (err) {
    console.error("[agent-host] session watcher failed:", err);
  }

  const stop = () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
    setAllowedRootsWatcherHealthy(false);
  };
  trackSessionWatcher(stop);
  return stop;
}

// Module-level active watcher so a soft refresh (host.refresh) can tear down a
// possibly wedged fs.watch and rebuild it — the same effect as a full restart.
let activeStopWatcher: (() => void) | null = null;

/** Track the currently running watcher; called by startSessionWatcher. */
export function trackSessionWatcher(stop: () => void): void {
  activeStopWatcher = stop;
}

/** Stop and restart the session watcher (used by host.refresh). Returns the
 * new stop function, or null when the watcher could not be (re)started. */
export function restartSessionWatcher(server: RpcServer): (() => void) | null {
  stopSessionWatcher();
  try {
    const stop = startSessionWatcher(server);
    activeStopWatcher = stop;
    return stop;
  } catch (error) {
    console.error("[agent-host] failed to restart session watcher:", error);
    return null;
  }
}

/** Stop the currently active session watcher, if any. */
export function stopSessionWatcher(): void {
  try {
    activeStopWatcher?.();
  } catch (error) {
    console.error("[agent-host] failed to stop session watcher:", error);
  }
  activeStopWatcher = null;
}

export function agentSessionsPath(): string {
  return path.join(getAgentDir());
}
