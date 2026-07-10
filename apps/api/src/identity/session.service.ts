import { createSecretKey, randomUUID } from "node:crypto";
import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { SignJWT, jwtVerify } from "jose";

import type { DatabaseService } from "../database/prisma.service";
import { randomOpaqueToken, sha256Hex } from "./crypto";

export interface SessionConfig {
  enabled?: boolean;
  issuer: string;
  signingSecret: string;
  previousSigningSecret?: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AccessPrincipal {
  userId: string;
  sessionId: string;
}

type RotationOutcome =
  | { kind: "ok"; tokens: SessionTokens }
  | { kind: "rejected"; reason: "invalid" | "revoked" | "reused" | "inactive" };

export class SessionService {
  private readonly key: ReturnType<typeof createSecretKey>;
  private readonly previousKey: ReturnType<typeof createSecretKey> | undefined;
  private readonly enabled: boolean;

  constructor(
    private readonly database: DatabaseService,
    private readonly config: SessionConfig,
  ) {
    if (config.signingSecret.length < 32) {
      throw new Error("Session signing secret must contain at least 32 characters");
    }
    if (config.previousSigningSecret && config.previousSigningSecret.length < 32) {
      throw new Error("Previous session signing secret must contain at least 32 characters");
    }
    this.key = createSecretKey(Buffer.from(config.signingSecret, "utf8"));
    this.previousKey = config.previousSigningSecret
      ? createSecretKey(Buffer.from(config.previousSigningSecret, "utf8"))
      : undefined;
    this.enabled = config.enabled ?? true;
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new ServiceUnavailableException("Identity is not configured");
  }

  private async accessToken(userId: string, sessionId: string): Promise<string> {
    return new SignJWT({ sid: sessionId, type: "access" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(this.config.issuer)
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(`${this.config.accessTtlSeconds}s`)
      .sign(this.key);
  }

  async issue(userId: string): Promise<SessionTokens> {
    this.assertEnabled();
    const refreshToken = randomOpaqueToken();
    const session = await this.database.refreshSession.create({
      data: {
        userId,
        familyId: randomUUID(),
        tokenHash: sha256Hex(refreshToken),
        expiresAt: new Date(Date.now() + this.config.refreshTtlSeconds * 1_000),
      },
    });
    return {
      accessToken: await this.accessToken(userId, session.id),
      refreshToken,
    };
  }

  async rotate(refreshToken: string, correlationId: string): Promise<SessionTokens> {
    this.assertEnabled();
    const tokenHash = sha256Hex(refreshToken);
    const outcome = await this.database.$transaction<RotationOutcome>(async (tx) => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "refresh_sessions"
        WHERE "token_hash" = ${tokenHash}
        FOR UPDATE
      `;
      const session = await tx.refreshSession.findUnique({
        where: { tokenHash },
        include: { user: true },
      });
      if (!session) return { kind: "rejected", reason: "invalid" };

      if (session.rotatedAt) {
        await tx.refreshSession.updateMany({
          where: { familyId: session.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await tx.securityEvent.create({
          data: {
            userId: session.userId,
            eventType: "refresh_token_reuse",
            severity: "high",
            correlationId,
            metadata: { family_id: session.familyId },
          },
        });
        return { kind: "rejected", reason: "reused" };
      }
      if (session.revokedAt || session.expiresAt <= new Date()) {
        return { kind: "rejected", reason: "revoked" };
      }
      if (session.user.status !== "active") {
        await tx.refreshSession.updateMany({
          where: { familyId: session.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return { kind: "rejected", reason: "inactive" };
      }

      const replacementToken = randomOpaqueToken();
      const replacement = await tx.refreshSession.create({
        data: {
          userId: session.userId,
          familyId: session.familyId,
          tokenHash: sha256Hex(replacementToken),
          expiresAt: new Date(Date.now() + this.config.refreshTtlSeconds * 1_000),
        },
      });
      await tx.refreshSession.update({
        where: { id: session.id },
        data: { rotatedAt: new Date(), replacedById: replacement.id },
      });
      return {
        kind: "ok",
        tokens: {
          accessToken: await this.accessToken(session.userId, replacement.id),
          refreshToken: replacementToken,
        },
      };
    });

    if (outcome.kind === "ok") return outcome.tokens;
    const message = {
      inactive: "User is inactive",
      invalid: "Invalid refresh token",
      reused: "Refresh token was reused; session family revoked",
      revoked: "Refresh token is revoked or expired",
    }[outcome.reason];
    throw new UnauthorizedException(message);
  }

  async revoke(refreshToken: string, correlationId: string): Promise<void> {
    this.assertEnabled();
    const session = await this.database.refreshSession.findUnique({
      where: { tokenHash: sha256Hex(refreshToken) },
    });
    if (!session) return;
    await this.database.$transaction([
      this.database.refreshSession.updateMany({
        where: { familyId: session.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.database.securityEvent.create({
        data: {
          userId: session.userId,
          eventType: "session_logout",
          severity: "info",
          correlationId,
          metadata: { family_id: session.familyId },
        },
      }),
    ]);
  }

  async verifyAccessToken(accessToken: string): Promise<AccessPrincipal> {
    this.assertEnabled();
    try {
      const payload = await this.verifyAccessTokenSignature(accessToken);
      if (
        payload.type !== "access" ||
        typeof payload.sub !== "string" ||
        typeof payload.sid !== "string"
      ) {
        throw new UnauthorizedException("Invalid access token claims");
      }
      const session = await this.database.refreshSession.findUnique({
        where: { id: payload.sid },
        include: { user: true },
      });
      if (
        !session ||
        session.revokedAt ||
        session.rotatedAt ||
        session.userId !== payload.sub ||
        session.user.status !== "active"
      ) {
        throw new UnauthorizedException("Session is no longer active");
      }
      return { userId: payload.sub, sessionId: payload.sid };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException("Invalid or expired access token");
    }
  }

  private async verifyAccessTokenSignature(accessToken: string) {
    const keys = this.previousKey ? [this.key, this.previousKey] : [this.key];
    for (const key of keys) {
      try {
        const { payload } = await jwtVerify(accessToken, key, {
          algorithms: ["HS256"],
          issuer: this.config.issuer,
        });
        return payload;
      } catch {
        // Try the previous key only during the bounded rotation window.
      }
    }
    throw new UnauthorizedException("Invalid access token signature");
  }
}
