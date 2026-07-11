import { SafetyIncidentView } from "../../../components/safety-incident-view";
import { loadSafetyQueue, serverOperationsConfig } from "../../../lib/api/operations";
import { loadAdminWebSession } from "../../../lib/api/admin-web-session";
import { notFound } from "next/navigation";
import { OperationsShell } from "../../rules/operations-shell";
import styles from "../../rules/operations.module.css";

export const dynamic = "force-dynamic";

export default async function SafetyIncidentsPage() {
  const session = await loadAdminWebSession();
  if (!session) notFound();
  const state = await loadSafetyQueue(serverOperationsConfig(session));
  return <OperationsShell active="incidents" eyebrow="Safety operations" title="Safety incidents" timestamp="Live API scope">
    <section aria-labelledby="incident-queue" className={styles.section}>
      <div className={styles.sectionHeading}><h2 id="incident-queue">Open incidents</h2><p className={styles.sectionMeta}>Encrypted detail excluded</p></div>
      <SafetyIncidentView state={state} />
    </section>
  </OperationsShell>;
}
