import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { loadAdminWebSession } from "../../lib/api/admin-web-session";

export const dynamic = "force-dynamic";

export default async function AuthenticatedOperationsLayout({ children }: { children: ReactNode }) {
  if (!await loadAdminWebSession()) notFound();
  return children;
}
