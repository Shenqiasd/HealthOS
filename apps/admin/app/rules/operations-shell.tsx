import Link from "next/link";
import type { ReactNode } from "react";

import styles from "./operations.module.css";

type OperationsSection = "recommendations" | "rules";

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
    href: "/recommendations",
    id: "recommendations",
    label: "Review queue",
  },
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
          <span className={styles.draftTag}>Draft only</span>
          <span className={styles.readOnlyTag}>Read only</span>
        </div>
      </header>

      <aside className={styles.boundary}>
        <span aria-hidden="true" className={styles.boundaryIndicator} />
        <div>
          <strong>Write boundary locked</strong>
          <p>
            Administrator identity, MFA and RBAC are not provisioned for T112.
            No approval, publish, rollback or queue mutation is exposed.
          </p>
        </div>
      </aside>

      {children}
    </main>
  );
}
