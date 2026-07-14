import { installNodeRuntimeIsolation, verifyHostIsolation } from "./node-runtime-isolation";

async function main(): Promise<void> {
  const hostIsolation = await verifyHostIsolation();
  const isolation = installNodeRuntimeIsolation();
  isolation.runCanaries();
  isolation.beginEvaluation();
  const { runCoachEvals } = await import("./coach-eval-runner");
  await runCoachEvals(isolation, hostIsolation.summary());
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
