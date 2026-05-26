
import type { MethodHandler } from "./method-registry.js";
import type { Config } from "../config/schema.js";
import type { MemoryStore } from "../memory/store.js";
import type { ClientManager } from "./client-manager.js";
import type { VersionCheck } from "../update/version-check.js";
import type { ChannelManager } from "../channels/manager.js";
import { semverGt } from "../update/semver.js";
import { getCurrentVersion } from "../update/version.js";

export { resolvePackageJsonPath } from "../update/version.js";

export function registerStatusMethods(
  register: (method: string, handler: MethodHandler) => void,
  deps: {
    config: Config;
    memoryStore: MemoryStore;
    /**
     * Boot-time channel snapshot — kept as a fallback so legacy callers and
     * minimal test harnesses that don't wire a dispatcher still see at
     * least the channels that existed at boot. Live state is preferred
     * (see `dispatcher` below) — that path reflects channels added or
     * removed via the `channels.*` RPC surface.
     */
    channels: Array<{ name: string; healthCheck?(): Promise<boolean> }>;
    /**
     * Live channel manager — when present, `status.channels[name]` reflects
     * whether the channel is currently registered AND running. This makes
     * the dashboard chip update immediately after a live connect/disconnect
     * without a daemon restart.
     *
     * NOTE: `status.channels` is intentionally a `Record<string, boolean>` —
     * callers that need richer per-channel state (bot username,
     * pending pairing count, error string) should call `channels.status`.
     */
    manager?: ChannelManager;
    clientManager: ClientManager;
    /**
     * Optional version-check service. When provided, the status
     * response includes `latestVersion` and `updateAvailable`. When
     * absent (legacy tests, minimal harnesses), both fields are
     * reported as "no update available".
     */
    versionCheck?: VersionCheck;
    /** Override for tests — returns the current version string. Defaults to reading package.json. */
    readVersion?: () => string;
  },
): void {
  // Closure-scoped cache — package.json doesn't change during a process
  // lifetime, but we avoid re-reading disk on every status call.
  let cachedVersion: string | null = null;
  const readVersion = deps.readVersion ?? getCurrentVersion;
  const resolveVersion = () => cachedVersion ?? (cachedVersion = readVersion());

  register("health", async () => ({
    status: "ok",
  }));

  register("status", async () => {
    const uptime = Math.floor(process.uptime());
    const channelsMap: Record<string, boolean> = {};
    if (deps.manager) {
      // Live read — mirrors the channel manager's current registration state
      // so the dashboard chip reflects connect/disconnect events without
      // waiting for a daemon restart.
      for (const [name, info] of Object.entries(deps.manager.getStatus())) {
        channelsMap[name] = info.running;
      }
    } else {
      // Fallback for callers that didn't wire a channel manager (older tests,
      // minimal harnesses). Boot-time snapshot only — won't reflect live
      // register/unregister.
      for (const ch of deps.channels) {
        try {
          channelsMap[ch.name] = (await ch.healthCheck?.()) ?? true;
        } catch {
          channelsMap[ch.name] = false;
        }
      }
    }
    const version = resolveVersion();
    const latestVersion = deps.versionCheck
      ? await deps.versionCheck.getLatest()
      : null;
    const updateAvailable =
      latestVersion !== null &&
      version !== "unknown" &&
      semverGt(latestVersion, version);
    return {
      version,
      latestVersion,
      updateAvailable,
      provider: deps.config.provider ?? null,
      model: deps.config.model ?? null,
      uptime_seconds: uptime,
      memory_backend: "file",
      channels: channelsMap,
      clients: deps.clientManager.count,
      showToolCalls: (deps.config.verbosity ?? 0) > 0,
      paperMode: deps.config.mode === "paper",
    };
  });
}
