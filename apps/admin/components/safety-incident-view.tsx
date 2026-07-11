import type { SafetyQueueState } from "../lib/api/operations";
import styles from "../app/rules/operations.module.css";

export function SafetyIncidentView({ state }: { state: SafetyQueueState }) {
  if (state.kind !== "ready") {
    const title = state.kind === "empty" ? "No open incidents" : state.kind === "unavailable" ? "Administrator session is not configured" : "Incident queue could not be loaded";
    return <section aria-live="polite" className={styles.operationalState}><strong>{title}</strong></section>;
  }
  return <div className={styles.tableFrame}>
    <table className={styles.table}>
      <thead><tr><th>Incident</th><th>Severity</th><th>Status</th><th>Assignee</th><th>Opened</th><th>Version</th></tr></thead>
      <tbody>{state.items.map((item) => <tr key={item.id}>
        <td><span className={styles.primaryCell}>{item.source}</span><span className={`${styles.cellMeta} ${styles.mono}`}>{item.id}</span></td>
        <td>{item.severity}</td><td>{item.status}</td><td>{item.assignee_label ?? "Unassigned"}</td>
        <td><time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</time></td>
        <td className={styles.mono}>v{item.version}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}
