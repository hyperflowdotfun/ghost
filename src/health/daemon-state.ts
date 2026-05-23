/**
 * Daemon runtime state probe — combines gateway reachability with the OS
 * service controller's view, so `status` and `doctor` can report whether
 * the daemon is actually running, not just what config says.
 */

import type { Logger } from "pino";
import { resolveServiceController, type ServiceStatus } from "../services/os/controller.js";
import { waitForGatewayReachable } from "./reachability.js";

export interface DaemonState {
  gateway: { reachable: boolean; host: string; port: number };
  service: ServiceStatus | "unsupported";
}

export async function checkDaemonState(opts: {
  host: string;
  port: number;
  logger: Logger;
  deadlineMs?: number;
}): Promise<DaemonState> {
  const reachable = await waitForGatewayReachable({
    host: opts.host,
    port: opts.port,
    deadlineMs: opts.deadlineMs ?? 500,
  });

  let service: ServiceStatus | "unsupported";
  try {
    service = await resolveServiceController(opts.logger).status();
  } catch {
    service = "unsupported";
  }

  return {
    gateway: { reachable, host: opts.host, port: opts.port },
    service,
  };
}
