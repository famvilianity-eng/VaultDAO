import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BackendEnv } from "../../config/env.js";
import type { BackendRuntime } from "../../server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");

const getPackageMetadata = () => {
  try {
    const packageJsonPath = join(__dirname, "../../../package.json");
    const packageJsonContent = readFileSync(packageJsonPath, "utf8");
    return JSON.parse(packageJsonContent);
  } catch (_error) {
    return { version: "unknown" };
  }
};

const packageMetadata = getPackageMetadata();
const VERSION = packageMetadata.version;

export type DependencyStatus = "ready" | "not_ready";

export interface DependencyReadiness {
  readonly name: string;
  readonly required: boolean;
  readonly status: DependencyStatus;
  readonly configured: boolean;
  readonly checked: boolean;
  readonly details: string;
}

export interface ReadinessPayload {
  readonly ready: boolean;
  readonly service: string;
  readonly version: string;
  readonly build?: { channel: string; updatedAt: string };
  readonly environment: string;
  readonly timestamp: string;
  readonly uptimeSeconds: number;
  readonly checks: {
    readonly app: DependencyReadiness;
    readonly rpc: DependencyReadiness;
    readonly websocket: DependencyReadiness;
    readonly storage: DependencyReadiness;
  };
}

export function buildHealthPayload(env: BackendEnv, runtime: BackendRuntime) {
  return {
    ok: true,
    service: "vaultdao-backend",
    version: VERSION,
    build: packageMetadata.build,
    environment: env.nodeEnv,
    network: env.stellarNetwork,
    contractId: env.contractId,
    timestamp: new Date().toISOString(),
    eventPolling: runtime.eventPollingService.getStatus(),
  };
}

export function buildStatusPayload(env: BackendEnv, runtime: BackendRuntime) {
  return {
    service: "vaultdao-backend",
    version: VERSION,
    build: packageMetadata.build,
    environment: env.nodeEnv,
    rpcUrl: env.sorobanRpcUrl,
    horizonUrl: env.horizonUrl,
    websocketUrl: env.websocketUrl,
    timestamp: new Date().toISOString(),
    eventPolling: runtime.eventPollingService.getStatus(),
  };
}

function getUptimeSeconds(startedAt: string): number {
  const startedAtTime = new Date(startedAt).getTime();
  const uptimeMs = Math.max(0, Date.now() - startedAtTime);
  return Math.floor(uptimeMs / 1000);
}

const CHECK_CACHE_TTL_MS = 10_000;

interface CachedCheck {
  status: DependencyStatus;
  checkedAt: number;
}

const checkCache = new Map<string, CachedCheck>();

async function liveCheck(
  url: string,
  cacheKey: string,
): Promise<DependencyStatus> {
  const cached = checkCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt < CHECK_CACHE_TTL_MS) {
    return cached.status;
  }

  let status: DependencyStatus;
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(3_000),
    });
    status = res.ok || res.status < 500 ? "ready" : "not_ready";
  } catch {
    status = "not_ready";
  }

  checkCache.set(cacheKey, { status, checkedAt: Date.now() });
  return status;
}

function buildDependencyChecks(env: BackendEnv): ReadinessPayload["checks"] {
  const hasRpcUrl = env.sorobanRpcUrl.length > 0;
  const hasWebsocketUrl = env.websocketUrl.length > 0;

  // Return synchronous shape; live checks are done in buildReadinessPayload
  return {
    app: {
      name: "app",
      required: true,
      status: "ready",
      configured: true,
      checked: true,
      details:
        "Process is running in-memory and the application can accept HTTP requests.",
    },
    rpc: {
      name: "rpc",
      required: true,
      status: hasRpcUrl ? "ready" : "not_ready",
      configured: hasRpcUrl,
      checked: false,
      details: hasRpcUrl
        ? "RPC endpoint URL is configured, but no live connectivity check is performed yet."
        : "RPC endpoint URL is missing, so required backend integrations are not ready.",
    },
    websocket: {
      name: "websocket",
      required: false,
      status: hasWebsocketUrl ? "ready" : "not_ready",
      configured: hasWebsocketUrl,
      checked: false,
      details: hasWebsocketUrl
        ? "Websocket endpoint URL is configured for future realtime features, but no live connectivity check is performed yet."
        : "Websocket endpoint URL is not configured yet, so realtime features remain optional and inactive.",
    },
    storage: {
      name: "storage",
      required: false,
      status: "ready",
      configured: false,
      checked: false,
      details:
        "No database or persistent storage dependency is configured yet, so there is nothing to check at startup.",
    },
  };
}

export async function buildReadinessPayload(
  env: BackendEnv,
  runtime: BackendRuntime,
): Promise<ReadinessPayload> {
  const checks = buildDependencyChecks(env);

  // Perform live RPC check
  let rpcStatus: DependencyStatus = checks.rpc.status;
  let rpcChecked = false;
  if (env.sorobanRpcUrl.length > 0) {
    rpcStatus = await liveCheck(env.sorobanRpcUrl, "rpc");
    rpcChecked = true;
  }

  // Perform live WebSocket check (HTTP upgrade endpoint)
  let wsStatus: DependencyStatus = checks.websocket.status;
  let wsChecked = false;
  if (env.websocketUrl.length > 0) {
    const wsHttpUrl = env.websocketUrl.replace(/^ws(s?):\/\//, "http$1://");
    wsStatus = await liveCheck(wsHttpUrl, "websocket");
    wsChecked = true;
  }

  const liveChecks: ReadinessPayload["checks"] = {
    ...checks,
    rpc: {
      ...checks.rpc,
      status: rpcStatus,
      checked: rpcChecked,
      details: rpcChecked
        ? rpcStatus === "ready"
          ? "RPC endpoint is reachable."
          : "RPC endpoint is not reachable."
        : checks.rpc.details,
    },
    websocket: {
      ...checks.websocket,
      status: wsStatus,
      checked: wsChecked,
      details: wsChecked
        ? wsStatus === "ready"
          ? "WebSocket endpoint is reachable."
          : "WebSocket endpoint is not reachable."
        : checks.websocket.details,
    },
  };

  const requiredReady = [liveChecks.app, liveChecks.rpc].every(
    (check) => check.status === "ready",
  );

  return {
    ready: requiredReady,
    service: "vaultdao-backend",
    version: VERSION,
    build: packageMetadata.build,
    environment: env.nodeEnv,
    timestamp: new Date().toISOString(),
    uptimeSeconds: getUptimeSeconds(runtime.startedAt),
    checks: liveChecks,
  };
}
