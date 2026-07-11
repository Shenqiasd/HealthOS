import { OperationsQueueView } from "../../../components/operations-queue-view";
import { loadReviewQueue, serverOperationsConfig } from "../../../lib/api/operations";
import { loadAdminWebSession } from "../../../lib/api/admin-web-session";
import { notFound } from "next/navigation";
import { OperationsShell } from "../../rules/operations-shell";
import styles from "../../rules/operations.module.css";

export const dynamic = "force-dynamic";

export default async function ReviewTasksPage() {
  const session = await loadAdminWebSession();
  if (!session) notFound();
  const state = await loadReviewQueue(serverOperationsConfig(session));
  return <OperationsShell active="recommendations" eyebrow="Review operations" title="Review queue" timestamp="Live API scope">
    <section aria-labelledby="review-queue" className={styles.section}>
      <div className={styles.sectionHeading}><h2 id="review-queue">Open review work</h2><p className={styles.sectionMeta}>SLA order</p></div>
      <OperationsQueueView state={state} />
    </section>
  </OperationsShell>;
}
