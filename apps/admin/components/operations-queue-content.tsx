import type { ReviewQueueState } from "../lib/api/operations";

interface QueueClasses {
  operationalState?: string;
  tableFrame?: string;
  table?: string;
  primaryCell?: string;
  cellMeta?: string;
  mono?: string;
}

const stateCopy = {
  empty: ["No review work", "The scoped queue is clear."],
  error: ["Queue could not be loaded", "The API did not return a valid operations response."],
  unavailable: ["Administrator session is not configured", "The console remains fail-closed."],
} as const;

export function OperationsQueueContent({ state, classes = {} }: { state: ReviewQueueState; classes?: QueueClasses }) {
  if (state.kind !== "ready") {
    const [title, detail] = stateCopy[state.kind];
    return <section aria-live="polite" className={classes.operationalState}>
      <strong>{title}</strong><span>{detail}</span>
    </section>;
  }
  return <div className={classes.tableFrame}>
    <table className={classes.table}>
      <thead><tr><th>Task</th><th>Priority</th><th>Status</th><th>Assignee</th><th>SLA</th><th>Version</th></tr></thead>
      <tbody>{state.items.map((item) => <tr key={item.id}>
        <td><span className={classes.primaryCell}>{item.task_type}</span><span className={`${classes.cellMeta ?? ""} ${classes.mono ?? ""}`.trim()}>{item.id}</span></td>
        <td>{item.priority}</td><td>{item.status}</td><td>{item.assignee_label ?? "Unassigned"}</td>
        <td><time dateTime={item.sla_at}>{new Date(item.sla_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</time></td>
        <td className={classes.mono}>v{item.version}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}
