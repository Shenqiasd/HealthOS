import type { Metadata } from "next";

import styles from "./operations.module.css";
import { OperationsShell } from "./operations-shell";

export const metadata: Metadata = {
  title: "Rule Bundles | HealthOS Operations",
};

const bundles = [
  {
    approval: "Medical 0 / Technical 0",
    boundary: "Locked",
    digest: "sha256:4a7e...91c2",
    id: "rules-syn-2026.07.11-rc3",
    rollback: "Not eligible",
    scope: "Daily action / Beta candidate",
    state: "Draft unapproved",
    stateClass: styles.stateDraft,
  },
  {
    approval: "Digest superseded",
    boundary: "Locked",
    digest: "sha256:d13b...5f80",
    id: "rules-syn-2026.07.11-rc2",
    rollback: "Not eligible",
    scope: "Daily action / Alpha",
    state: "Superseded draft",
    stateClass: styles.stateBlocked,
  },
  {
    approval: "Medical 0 / Technical 0",
    boundary: "Locked",
    digest: "sha256:8c05...2dd4",
    id: "safety-syn-2026.07.10-rc1",
    rollback: "Not eligible",
    scope: "Safety policy",
    state: "Draft unapproved",
    stateClass: styles.stateDraft,
  },
  {
    approval: "Synthetic fixture only",
    boundary: "No runtime authority",
    digest: "sha256:0f2a...be17",
    id: "rollback-syn-exercise-014",
    rollback: "Exercise passed",
    scope: "Rollback rehearsal",
    state: "Synthetic exercise",
    stateClass: styles.stateComplete,
  },
] as const;

const metrics = [
  { label: "Published bundles", note: "No production head", value: "0" },
  { label: "Draft candidates", note: "All unpublished", value: "3" },
  { label: "Bound approvals", note: "Distinct roles required", value: "0 / 2" },
  { label: "Rollback target", note: "No eligible bundle", value: "None" },
] as const;

export default function RuleBundlesPage() {
  return (
    <OperationsShell
      active="rules"
      eyebrow="Governance snapshot"
      timestamp="Synthetic snapshot | 11 Jul 2026 | 09:30 CST"
      title="Rule bundles"
    >
      <section aria-label="Bundle summary" className={styles.metrics}>
        {metrics.map((metric) => (
          <div className={styles.metric} key={metric.label}>
            <span className={styles.metricLabel}>{metric.label}</span>
            <strong className={styles.metricValue}>{metric.value}</strong>
            <span className={styles.metricNote}>{metric.note}</span>
          </div>
        ))}
      </section>

      <section aria-labelledby="bundle-registry" className={styles.section}>
        <div className={styles.sectionHeading}>
          <h2 id="bundle-registry">Bundle registry</h2>
          <p className={styles.sectionMeta}>4 synthetic records | 0 published</p>
        </div>
        <div className={styles.tableFrame}>
          <table className={styles.table}>
            <colgroup>
              <col style={{ width: "22%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "15%" }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: "15%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "9%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Bundle</th>
                <th>Scope</th>
                <th>Status</th>
                <th>Content digest</th>
                <th>Approval evidence</th>
                <th>Boundary</th>
                <th>Rollback</th>
              </tr>
            </thead>
            <tbody>
              {bundles.map((bundle) => (
                <tr key={bundle.id}>
                  <td>
                    <span className={`${styles.primaryCell} ${styles.mono}`}>
                      {bundle.id}
                    </span>
                    <span className={styles.cellMeta}>SYNTHETIC / DRAFT</span>
                  </td>
                  <td>{bundle.scope}</td>
                  <td>
                    <span className={styles.stateLine}>
                      <span
                        aria-hidden="true"
                        className={`${styles.stateDot} ${bundle.stateClass}`}
                      />
                      <span>{bundle.state}</span>
                    </span>
                  </td>
                  <td className={styles.mono}>{bundle.digest}</td>
                  <td>{bundle.approval}</td>
                  <td>{bundle.boundary}</td>
                  <td>{bundle.rollback}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="approval-boundary" className={styles.section}>
        <div className={styles.sectionHeading}>
          <h2 id="approval-boundary">Approval boundary</h2>
          <p className={styles.sectionMeta}>Fail closed</p>
        </div>
        <div className={styles.detailGrid}>
          <div className={styles.definition}>
            <span className={styles.definitionLabel}>Medical authority</span>
            <strong className={styles.definitionValue}>Not provisioned</strong>
            <span className={styles.definitionMeta}>
              Named role-bound identity required
            </span>
          </div>
          <div className={styles.definition}>
            <span className={styles.definitionLabel}>Technical authority</span>
            <strong className={styles.definitionValue}>Not provisioned</strong>
            <span className={styles.definitionMeta}>
              Must be distinct from medical actor
            </span>
          </div>
          <div className={styles.definition}>
            <span className={styles.definitionLabel}>Digest binding</span>
            <strong className={styles.definitionValue}>Exact content only</strong>
            <span className={styles.definitionMeta}>
              Superseded content voids evidence
            </span>
          </div>
          <div className={styles.definition}>
            <span className={styles.definitionLabel}>Publication state</span>
            <strong className={styles.definitionValue}>Locked</strong>
            <span className={styles.definitionMeta}>
              No authenticated mutation surface
            </span>
          </div>
        </div>
      </section>

      <section aria-labelledby="rollback-state" className={styles.section}>
        <div className={styles.sectionHeading}>
          <h2 id="rollback-state">Rollback state</h2>
          <p className={styles.sectionMeta}>Synthetic rehearsal evidence</p>
        </div>
        <div className={styles.detailGrid}>
          <div className={styles.definition}>
            <span className={styles.definitionLabel}>Published head</span>
            <strong className={styles.definitionValue}>None</strong>
            <span className={styles.definitionMeta}>No production bundle</span>
          </div>
          <div className={styles.definition}>
            <span className={styles.definitionLabel}>Eligible target</span>
            <strong className={styles.definitionValue}>None</strong>
            <span className={styles.definitionMeta}>
              Drafts cannot be rollback targets
            </span>
          </div>
          <div className={styles.definition}>
            <span className={styles.definitionLabel}>Latest exercise</span>
            <strong className={`${styles.definitionValue} ${styles.mono}`}>
              RB-SYN-014
            </strong>
            <span className={styles.definitionMeta}>Passed | synthetic only</span>
          </div>
          <div className={styles.definition}>
            <span className={styles.definitionLabel}>Runtime effect</span>
            <strong className={styles.definitionValue}>None</strong>
            <span className={styles.definitionMeta}>
              Static draft scenario
            </span>
          </div>
        </div>
      </section>

      <p className={styles.footerNote}>
        Synthetic operational fixture. No real user data, reviewer identity,
        approval evidence or production bundle is represented.
      </p>
    </OperationsShell>
  );
}
