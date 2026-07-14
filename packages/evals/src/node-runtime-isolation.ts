import { createRequire, syncBuiltinESMExports } from "node:module";

export type IsolationCategory =
  | "fetch" | "http" | "https" | "net" | "tls" | "dns" | "dgram" | "subprocess" | "worker";

export interface NodeRuntimeIsolation {
  runCanaries(): void;
  beginEvaluation(): void;
  evaluationAttempts(): number;
  canarySummary(): string;
}

export interface HostIsolationEvidence {
  summary(): string;
}

type Phase = "canary" | "evaluation";
type MutableModule = Record<string, unknown>;

const categories: IsolationCategory[] = [
  "fetch", "http", "https", "net", "tls", "dns", "dgram", "subprocess", "worker",
];

class IsolationViolation extends Error {
  constructor(readonly category: IsolationCategory, readonly mechanism: string) {
    super(`Coach eval isolation blocked ${category}:${mechanism}`);
    this.name = "IsolationViolation";
  }
}

function emptyCounts(): Record<IsolationCategory, number> {
  return Object.fromEntries(categories.map((category) => [category, 0])) as Record<IsolationCategory, number>;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function requirePermissionDenial(name: string, operation: () => unknown): void {
  try {
    const escaped = operation() as { terminate?: () => unknown } | undefined;
    escaped?.terminate?.();
  } catch (error) {
    if (errorCode(error) === "ERR_ACCESS_DENIED") return;
    throw new Error(`${name} isolation raised ${errorCode(error) ?? "an unknown error"} instead of ERR_ACCESS_DENIED`);
  }
  throw new Error(`${name} isolation was bypassed`);
}

async function requireOperatingSystemNetworkDenial(connect: (...args: unknown[]) => unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const socket = connect({ host: "1.1.1.1", port: 443 }) as {
      once(event: string, listener: (error?: unknown) => void): void;
      destroy(): void;
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(() => reject(new Error("OS network isolation probe timed out instead of being denied")));
    }, 2_000);
    socket.once("connect", () => {
      socket.destroy();
      finish(() => reject(new Error("OS network isolation was bypassed")));
    });
    socket.once("error", (error) => {
      const code = errorCode(error);
      finish(() => code === "EPERM" || code === "EACCES"
        ? resolve()
        : reject(new Error(`OS network isolation raised ${code ?? "an unknown error"} instead of EPERM/EACCES`)));
    });
  });
}

export async function verifyHostIsolation(): Promise<HostIsolationEvidence> {
  if (process.platform !== "darwin" || process.env.HEALTHOS_COACH_EVAL_SANDBOX !== "macos-deny-network-v1") {
    throw new Error("Coach eval isolation requires the macOS deny-network launcher");
  }
  const permissions = (process as unknown as { permission?: { has(scope: string): boolean } }).permission;
  if (!permissions || permissions.has("child") || permissions.has("worker")) {
    throw new Error("Coach eval isolation requires Node permission mode with child and worker denied");
  }
  const runtimeRequire = createRequire(__filename);
  const net = runtimeRequire("node:net") as { connect: (...args: unknown[]) => unknown };
  const childProcess = runtimeRequire("node:child_process") as {
    spawnSync: (...args: unknown[]) => unknown;
  };
  const workerThreads = runtimeRequire("node:worker_threads") as {
    Worker: new (source: string, options: { eval: boolean }) => { terminate(): unknown };
  };
  await requireOperatingSystemNetworkDenial(net.connect.bind(net));
  requirePermissionDenial("Node subprocess", () => childProcess.spawnSync(process.execPath, ["--version"]));
  requirePermissionDenial("Node worker", () => new workerThreads.Worker("", { eval: true }));
  return {
    summary: () => "os_network_attempts=1 os_network_blocked=1 node_subprocess_attempts=1 node_subprocess_blocked=1 node_worker_attempts=1 node_worker_blocked=1",
  };
}

export function installNodeRuntimeIsolation(): NodeRuntimeIsolation {
  let phase: Phase = "canary";
  const counts: Record<Phase, Record<IsolationCategory, number>> = {
    canary: emptyCounts(),
    evaluation: emptyCounts(),
  };
  const runtimeRequire = createRequire(__filename);
  const modules = {
    http: runtimeRequire("node:http") as MutableModule,
    https: runtimeRequire("node:https") as MutableModule,
    http2: runtimeRequire("node:http2") as MutableModule,
    net: runtimeRequire("node:net") as MutableModule,
    tls: runtimeRequire("node:tls") as MutableModule,
    dns: runtimeRequire("node:dns") as MutableModule,
    dgram: runtimeRequire("node:dgram") as MutableModule,
    childProcess: runtimeRequire("node:child_process") as MutableModule,
    cluster: runtimeRequire("node:cluster") as MutableModule,
    workerThreads: runtimeRequire("node:worker_threads") as MutableModule,
  };

  const block = (category: IsolationCategory, mechanism: string) => function blockedMechanism(): never {
    counts[phase][category] += 1;
    throw new IsolationViolation(category, mechanism);
  };
  const patch = (target: MutableModule, name: string, category: IsolationCategory, mechanism = name): void => {
    if (!(name in target)) throw new Error(`Required Node isolation mechanism is unavailable: ${category}:${mechanism}`);
    Object.defineProperty(target, name, {
      value: block(category, mechanism),
      configurable: true,
      enumerable: Object.prototype.propertyIsEnumerable.call(target, name),
      writable: true,
    });
  };

  Object.defineProperty(globalThis, "fetch", {
    value: block("fetch", "globalThis.fetch"),
    configurable: true,
    writable: true,
  });
  const globals = globalThis as unknown as MutableModule;
  if ("WebSocket" in globals) patch(globals, "WebSocket", "net", "globalThis.WebSocket");

  for (const name of ["request", "get"]) patch(modules.http, name, "http", `http.${name}`);
  for (const name of ["request", "get"]) patch(modules.https, name, "https", `https.${name}`);
  for (const name of ["connect", "createServer", "createSecureServer"]) {
    patch(modules.http2, name, name === "createSecureServer" ? "https" : "http", `http2.${name}`);
  }
  for (const name of ["connect", "createConnection", "createServer"]) patch(modules.net, name, "net", `net.${name}`);
  for (const name of ["connect", "createServer"]) patch(modules.tls, name, "tls", `tls.${name}`);
  patch(modules.dgram, "createSocket", "dgram", "dgram.createSocket");

  const netSocket = modules.net.Socket as { prototype?: MutableModule } | undefined;
  if (netSocket?.prototype) patch(netSocket.prototype, "connect", "net", "net.Socket.connect");
  const tlsSocket = modules.tls.TLSSocket as { prototype?: MutableModule } | undefined;
  if (tlsSocket?.prototype && "connect" in tlsSocket.prototype) {
    patch(tlsSocket.prototype, "connect", "tls", "tls.TLSSocket.connect");
  }

  const dnsMethods = [
    "lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa",
    "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa",
    "resolveSrv", "resolveTxt", "reverse",
  ];
  for (const name of dnsMethods) patch(modules.dns, name, "dns", `dns.${name}`);
  const dnsPromises = modules.dns.promises as MutableModule | undefined;
  if (!dnsPromises) throw new Error("Required Node isolation mechanism is unavailable: dns.promises");
  for (const name of dnsMethods.filter((name) => name !== "lookupService" || name in dnsPromises)) {
    if (name in dnsPromises) patch(dnsPromises, name, "dns", `dns.promises.${name}`);
  }
  const resolver = modules.dns.Resolver as { prototype?: MutableModule } | undefined;
  if (resolver?.prototype) {
    for (const name of dnsMethods.filter((name) => name.startsWith("resolve") || name === "reverse")) {
      if (name in resolver.prototype) patch(resolver.prototype, name, "dns", `dns.Resolver.${name}`);
    }
  }

  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    patch(modules.childProcess, name, "subprocess", `child_process.${name}`);
  }
  for (const name of ["fork", "setupMaster", "setupPrimary"]) {
    if (name in modules.cluster) patch(modules.cluster, name, "subprocess", `cluster.${name}`);
  }
  patch(modules.workerThreads, "Worker", "worker", "worker_threads.Worker");
  syncBuiltinESMExports();

  const expectBlocked = (category: IsolationCategory, operation: () => unknown): void => {
    const before = counts.canary[category];
    let violation: unknown;
    try {
      operation();
    } catch (error) {
      violation = error;
    }
    if (!(violation instanceof IsolationViolation) || violation.category !== category) {
      throw new Error(`Node isolation canary escaped or raised the wrong error: ${category}`);
    }
    if (counts.canary[category] !== before + 1) {
      throw new Error(`Node isolation canary was not counted exactly once: ${category}`);
    }
  };

  return {
    runCanaries() {
      expectBlocked("fetch", () => globalThis.fetch("https://example.invalid"));
      expectBlocked("http", () => (modules.http.get as (...args: unknown[]) => unknown)("http://127.0.0.1:9"));
      expectBlocked("https", () => (modules.https.get as (...args: unknown[]) => unknown)("https://example.invalid"));
      expectBlocked("net", () => (modules.net.connect as (...args: unknown[]) => unknown)(9, "127.0.0.1"));
      expectBlocked("tls", () => (modules.tls.connect as (...args: unknown[]) => unknown)(443, "example.invalid"));
      expectBlocked("dns", () => (modules.dns.lookup as (...args: unknown[]) => unknown)("example.invalid"));
      expectBlocked("dgram", () => (modules.dgram.createSocket as (...args: unknown[]) => unknown)("udp4"));
      expectBlocked("subprocess", () => (modules.childProcess.spawn as (...args: unknown[]) => unknown)(process.execPath, ["--version"]));
      expectBlocked("worker", () => {
        const Worker = modules.workerThreads.Worker as new (source: string, options: { eval: boolean }) => unknown;
        return new Worker("", { eval: true });
      });
      if (categories.some((category) => counts.canary[category] !== 1)) {
        throw new Error("Every Node isolation canary must execute and be blocked exactly once");
      }
    },
    beginEvaluation() {
      phase = "evaluation";
    },
    evaluationAttempts() {
      return Object.values(counts.evaluation).reduce((total, count) => total + count, 0);
    },
    canarySummary() {
      return `isolation_canaries=${categories.map((category) => `${category}:${counts.canary[category]}`).join(",")} blocked=${categories.length}`;
    },
  };
}
