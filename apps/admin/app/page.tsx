export const dynamic = "force-dynamic";

interface ReadinessResult {
  status: "ready" | "not_ready" | "unreachable";
  label: string;
}

async function loadReadiness(): Promise<ReadinessResult> {
  const apiBaseUrl = process.env.HEALTHOS_API_BASE_URL ?? "http://127.0.0.1:3000";
  try {
    const response = await fetch(`${apiBaseUrl}/health/ready`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
    });
    const body = (await response.json()) as { status?: string };
    return {
      status: body.status === "ready" ? "ready" : "not_ready",
      label: body.status === "ready" ? "Ready" : "Dependencies not configured",
    };
  } catch {
    return { status: "unreachable", label: "API unreachable" };
  }
}

export default async function OperationsHome() {
  const readiness = await loadReadiness();
  const environment = process.env.HEALTHOS_ENVIRONMENT ?? "local-synthetic";

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">HealthOS</p>
          <h1>Operations</h1>
        </div>
        <span className="environment">{environment}</span>
      </header>
      <section aria-labelledby="service-status">
        <h2 id="service-status">Service status</h2>
        <div className="status-row">
          <div>
            <strong>API readiness</strong>
            <p>Database, object storage, and worker lease</p>
          </div>
          <span className={`status status-${readiness.status}`}>
            {readiness.label}
          </span>
        </div>
      </section>
    </main>
  );
}
