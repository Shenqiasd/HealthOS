import type { ReviewQueueState } from "../lib/api/operations";
import styles from "../app/rules/operations.module.css";
import { OperationsQueueContent } from "./operations-queue-content";

export function OperationsQueueView({ state }: { state: ReviewQueueState }) {
  return <OperationsQueueContent state={state} classes={styles} />;
}
