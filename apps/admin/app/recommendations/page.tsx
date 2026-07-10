import type { Metadata } from "next";

import styles from "../rules/operations.module.css";
import { OperationsShell } from "../rules/operations-shell";

export const metadata: Metadata = {
  title: "Recommendation Queue | HealthOS Operations",
};

const queue = [
  {
    cohort: "Alpha",
    id: "REC-SYN-1042",
    integrity: "Complete 7 / 7",
    integrityClass: styles.integrityComplete,
    publication: "Held for review",
    safety: "normal",
    safetyClass: styles.pillNormal,
    sla: "12 min left",
    slaClass: styles.slaOnTrack,
    source: "Profile v18 | facts r31",
    status: "Awaiting review",
    subject: "subject-syn-042",
  },
  {
    cohort: "Beta",
    id: "REC-SYN-1043",
    integrity: "Complete 7 / 7",
    integrityClass: styles.integrityComplete,
    publication: "Held for review",
    safety: "caution",
    safetyClass: styles.pillCaution,
    sla: "4 min left",
    slaClass: styles.slaTight,
    source: "Profile v11 | facts r09",
    status: "Review required",
    subject: "subject-syn-017",
  },
  {
    cohort: "Beta",
    id: "REC-SYN-1044",
    integrity: "Complete 7 / 7",
    integrityClass: styles.integrityComplete,
    publication: "Fixed fallback only",
    safety: "doctor",
    safetyClass: styles.pillDoctor,
    sla: "Breached 6 min",
    slaClass: styles.slaBreached,
    source: "Profile v22 | facts r44",
    status: "Follow-up due",
    subject: "subject-syn-008",
  },
  {
    cohort: "Beta",
    id: "REC-SYN-1045",
    integrity: "Incomplete 5 / 7",
    integrityClass: styles.integrityPartial,
    publication: "No publish",
    safety: "blocked",
    safetyClass: styles.pillBlocked,
    sla: "19 min left",
    slaClass: styles.slaOnTrack,
    source: "Consent epoch missing",
    status: "Safety review open",
    subject: "subject-syn-031",
  },
  {
    cohort: "Beta sample",
    id: "REC-SYN-1046",
    integrity: "Complete 7 / 7",
    integrityClass: styles.integrityComplete,
    publication: "Held for review",
    safety: "normal",
    safetyClass: styles.pillNormal,
    sla: "27 min left",
    slaClass: styles.slaOnTrack,
    source: "Profile v07 | facts r16",
    status: "Sampled review",
    subject: "subject-syn-055",
  },
] as const;

const metrics = [
  { label: "Open review", note: "Synthetic queue", value: "5" },
  { label: "SLA breached", note: "Doctor follow-up", value: "1" },
  { label: "Blocked", note: "No publication", value: "1" },
  { label: "Source gaps", note: "Fail-closed records", value: "1" },
] as const;

export default function RecommendationQueuePage() {
  return (
    <OperationsShell
      active="recommendations"
      eyebrow="Review operations"
      timestamp="Synthetic queue | 11 Jul 2026 | 09:30 CST"
      title="Recommendation queue"
    >
      <section aria-label="Queue summary" className={styles.metrics}>
        {metrics.map((metric) => (
          <div className={styles.metric} key={metric.label}>
            <span className={styles.metricLabel}>{metric.label}</span>
            <strong className={styles.metricValue}>{metric.value}</strong>
            <span className={styles.metricNote}>{metric.note}</span>
          </div>
        ))}
      </section>

      <section aria-labelledby="review-queue" className={styles.section}>
        <div className={styles.sectionHeading}>
          <h2 id="review-queue">Open queue</h2>
          <p className={styles.sectionMeta}>5 synthetic records | 1 breached</p>
        </div>
        <div className={styles.tableFrame}>
          <table className={styles.table}>
            <colgroup>
              <col style={{ width: "17%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "20%" }} />
              <col style={{ width: "20%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Recommendation</th>
                <th>Cohort</th>
                <th>Safety class</th>
                <th>Status</th>
                <th>SLA</th>
                <th>Source integrity</th>
                <th>Publication</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span className={`${styles.primaryCell} ${styles.mono}`}>
                      {item.id}
                    </span>
                    <span className={`${styles.cellMeta} ${styles.mono}`}>
                      {item.subject}
                    </span>
                  </td>
                  <td>{item.cohort}</td>
                  <td>
                    <span className={`${styles.pill} ${item.safetyClass}`}>
                      {item.safety}
                    </span>
                  </td>
                  <td>{item.status}</td>
                  <td>
                    <span className={item.slaClass}>{item.sla}</span>
                  </td>
                  <td>
                    <span className={item.integrityClass}>{item.integrity}</span>
                    <span className={styles.cellMeta}>{item.source}</span>
                  </td>
                  <td>{item.publication}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="source-contract" className={styles.section}>
        <div className={styles.sectionHeading}>
          <h2 id="source-contract">Source completeness</h2>
          <p className={styles.sectionMeta}>Required for publication eligibility</p>
        </div>
        <div className={styles.detailGrid}>
          <div className={styles.definition}>
            <span className={styles.definitionLabel}>Profile snapshot</span>
            <strong className={styles.definitionValue}>Exact revision + hash</strong>
            <span className={styles.definitionMeta}>Immutable identity</span>
          </div>
          <div className={styles.definition}>
            <span className={styles.definitionLabel}>Daily facts</span>
            <strong className={styles.definitionValue}>Revision set complete</strong>
            <span className={styles.definitionMeta}>No mutable source rows</span>
          </div>
          <div className={styles.definition}>
            <span className={styles.definitionLabel}>Policy evidence</span>
            <strong className={styles.definitionValue}>Bundle digests bound</strong>
            <span className={styles.definitionMeta}>Rule + safety identities</span>
          </div>
          <div className={styles.definition}>
            <span className={styles.definitionLabel}>Privacy fence</span>
            <strong className={styles.definitionValue}>Consent epoch current</strong>
            <span className={styles.definitionMeta}>Deletion state checked</span>
          </div>
        </div>
      </section>

      <p className={styles.footerNote}>
        Synthetic operational fixture. No real health record, user identity,
        reviewer action or outbound delivery is represented.
      </p>
    </OperationsShell>
  );
}
