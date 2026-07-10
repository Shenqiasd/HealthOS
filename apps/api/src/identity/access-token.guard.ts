import {
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import {
  SessionService,
  type AccessPrincipal,
} from "./session.service";

export interface AuthenticatedRequest extends FastifyRequest {
  healthosPrincipal?: AccessPrincipal;
}

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Bearer access token is required");
    }
    request.healthosPrincipal = await this.sessions.verifyAccessToken(
      authorization.slice("Bearer ".length),
    );
    return true;
  }
}
