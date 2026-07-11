import type { FastifyRequest } from "fastify";

export const ADMIN_ROLES = ["reviewer", "operator", "admin", "medical_approver"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export interface AdminPrincipal {
  actorId: string;
  displayLabel: string;
  roles: AdminRole[];
  subjectUserIds: string[];
}

export interface AdminAuthenticatedRequest extends FastifyRequest {
  healthosAdminPrincipal?: AdminPrincipal;
}

export function hasAdminRole(principal: AdminPrincipal, roles: readonly AdminRole[]): boolean {
  return principal.roles.some((role) => roles.includes(role));
}

export function canAccessSubject(principal: AdminPrincipal, userId: string | null): boolean {
  if (hasAdminRole(principal, ["operator", "admin"])) return true;
  return userId !== null && principal.subjectUserIds.includes(userId);
}
