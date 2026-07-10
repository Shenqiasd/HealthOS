import {
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";

import type { DatabaseService } from "../database/prisma.service";
import { hmacSha256Hex, randomOpaqueToken, sha256Hex } from "./crypto";
import type { AppleTokenVerifier } from "./apple-token-verifier";
import type { SessionService, SessionTokens } from "./session.service";

export interface IdentityConfig {
  enabled?: boolean;
  subjectHashKey: string;
  nonceTtlSeconds: number;
}

export interface AppleAuthenticationInput {
  identityToken: string;
  nonce: string;
  correlationId: string;
}

export interface AuthenticationResult extends SessionTokens {
  userId: string;
}

export class IdentityService {
  private readonly enabled: boolean;

  constructor(
    private readonly database: DatabaseService,
    private readonly verifier: AppleTokenVerifier,
    private readonly sessions: SessionService,
    private readonly config: IdentityConfig,
  ) {
    if (config.subjectHashKey.length < 32) {
      throw new Error("Subject hash key must contain at least 32 characters");
    }
    this.enabled = config.enabled ?? true;
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new ServiceUnavailableException("Identity is not configured");
  }

  async issueNonce(): Promise<{ value: string; expiresAt: Date }> {
    this.assertEnabled();
    const value = randomOpaqueToken();
    const expiresAt = new Date(Date.now() + this.config.nonceTtlSeconds * 1_000);
    await this.database.appleAuthNonce.create({
      data: { nonceHash: sha256Hex(value), expiresAt },
    });
    return { value, expiresAt };
  }

  async authenticateWithApple(
    input: AppleAuthenticationInput,
  ): Promise<AuthenticationResult> {
    this.assertEnabled();
    const nonceHash = sha256Hex(input.nonce);
    const claims = await this.verifier.verify(input.identityToken, nonceHash);
    const subjectHash = hmacSha256Hex(
      this.config.subjectHashKey,
      claims.subject,
    );

    const outcome = await this.database.$transaction(async (tx) => {
      const consumed = await tx.appleAuthNonce.updateMany({
        where: {
          nonceHash,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: new Date() },
      });
      if (consumed.count !== 1) return { kind: "nonce_rejected" as const };

      const existing = await tx.userIdentity.findUnique({
        where: {
          provider_providerSubjectHash: {
            provider: "apple",
            providerSubjectHash: subjectHash,
          },
        },
        include: { user: true },
      });
      const user = existing?.user ??
        (await tx.user.create({
          data: {
            identities: {
              create: {
                provider: "apple",
                providerSubjectHash: subjectHash,
                verifiedAt: new Date(),
              },
            },
          },
        }));

      if (user.status !== "active") {
        await tx.securityEvent.create({
          data: {
            userId: user.id,
            eventType: "login_rejected_inactive_user",
            severity: "high",
            correlationId: input.correlationId,
            metadata: { provider: "apple" },
          },
        });
        return { kind: "inactive" as const };
      }
      await tx.securityEvent.create({
        data: {
          userId: user.id,
          eventType: "login_succeeded",
          severity: "info",
          correlationId: input.correlationId,
          metadata: { provider: "apple" },
        },
      });
      return { kind: "ok" as const, userId: user.id };
    });

    if (outcome.kind === "nonce_rejected") {
      throw new UnauthorizedException("Nonce is expired, invalid, or replayed");
    }
    if (outcome.kind === "inactive") {
      throw new UnauthorizedException("User is deleted or inactive");
    }
    const tokens = await this.sessions.issue(outcome.userId);
    return { userId: outcome.userId, ...tokens };
  }
}
