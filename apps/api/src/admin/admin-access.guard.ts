import { ForbiddenException, HttpException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";

import { DatabaseService } from "../database/prisma.service";
import { AdminIdentityVerifier } from "./admin-identity.verifier";
import type { AdminAuthenticatedRequest, AdminRole } from "./admin-principal";
import { ADMIN_ROLES } from "./admin-principal";

@Injectable()
export class AdminAccessGuard implements CanActivate {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AdminIdentityVerifier) private readonly verifier: AdminIdentityVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminAuthenticatedRequest>();
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Administrator bearer token is required");
    }
    let identity;
    try {
      identity = await this.verifier.verify(authorization.slice("Bearer ".length));
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new UnauthorizedException("Invalid administrator token");
    }
    if (!identity.mfa) throw new ForbiddenException("Administrator MFA is required");
    if (!/^[a-f0-9]{64}$/.test(identity.lookupHash)) {
      throw new UnauthorizedException("Invalid administrator identity");
    }
    const actor = await this.database.adminActor.findUnique({
      where: { lookupHash: identity.lookupHash },
      include: { roles: true, subjectScopes: true },
    });
    if (!actor || actor.status !== "active") {
      throw new ForbiddenException("Administrator access is disabled");
    }
    const roles = actor.roles.map(({ role }) => role).filter(
      (role): role is AdminRole => (ADMIN_ROLES as readonly string[]).includes(role),
    );
    if (roles.length === 0) throw new ForbiddenException("Administrator has no active role");
    request.healthosAdminPrincipal = {
      actorId: actor.id,
      displayLabel: actor.displayLabel,
      roles,
      subjectUserIds: actor.subjectScopes.map(({ userId }) => userId),
    };
    return true;
  }
}
