import Link from "next/link";
import type { ReactNode } from "react";

import styles from "./operations.module.css";

type OperationsSection = "recommendations" | "rules" | "incidents";

interface OperationsShellProps {
  active: OperationsSection;
  children: ReactNode;
  eyebrow: string;
  title: string;
  timestamp: string;
}
const sections: ReadonlyArray<{
  href: string;
  id: OperationsSection;
  label: string;
}> = [
  { href: "/rules", id: "rules", label: "Rule bundles" },
  {
    href: "/review-tasks",
    id: "recommendations",
    label: "Review queue",
  },
  { href: "/safety-incidents", id: "incidents", label: "Safety incidents" },
];

export function OperationsShell({
  active,
  children,
  eyebrow,
  title,
  timestamp,
}: OperationsShellProps) {
  return (
    <main className={styles.page}>
      <div className={styles.utilityBar}>
        <Link className={styles.brand} href="/">
          <span aria-hidden="true" className={styles.brandMark}>
            H
          </span>
          <span>
            <strong>HealthOS</strong>
            <small>Operations</small>
          </span>
        </Link>
        <nav aria-label="Operations views" className={styles.navigation}>
          {sections.map((section) => (
            <Link
              aria-current={active === section.id ? "page" : undefined}
              className={
                active === section.id ? styles.navLinkActive : styles.navLink
              }
              href={section.href}
              key={section.id}
            >
              {section.label}
            </Link>
          ))}
        </nav>
      </div>

      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>{eyebrow}</p>
          <h1 className={styles.pageTitle}>{title}</h1>
          <p className={styles.timestamp}>{timestamp}</p>
        </div>
        <div aria-label="Data classification" className={styles.classifiers}>
          <span className={styles.syntheticTag}>Synthetic data</span>
          <span className={styles.draftTag}>Synthetic authority</span>
          <span className={styles.readOnlyTag}>MFA required</span>
        </div>
      </header>

      <aside className={styles.boundary}>
        <span aria-hidden="true" className={styles.boundaryIndicator} />
        <div>
          <strong>Production authority unavailable</strong>
          <p>
            Queue actions cannot publish recommendations, approve medical rules,
            send messages, or process real health data.
          </p>
        </div>
      </aside>

      {children}
    </main>
  );
}
