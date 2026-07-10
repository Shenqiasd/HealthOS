import { UnauthorizedException } from "@nestjs/common";
import { jwtVerify, type JWTVerifyGetKey } from "jose";

export interface AppleTokenVerifierOptions {
  audience: string;
  issuer?: string;
  keySet: JWTVerifyGetKey;
}

export interface VerifiedAppleClaims {
  subject: string;
  email?: string;
}

export class AppleTokenVerifier {
  private readonly audience: string;
  private readonly issuer: string;
  private readonly keySet: JWTVerifyGetKey;

  constructor(options: AppleTokenVerifierOptions) {
    this.audience = options.audience;
    this.issuer = options.issuer ?? "https://appleid.apple.com";
    this.keySet = options.keySet;
  }

  async verify(
    identityToken: string,
    expectedNonceHash: string,
  ): Promise<VerifiedAppleClaims> {
    try {
      const { payload } = await jwtVerify(identityToken, this.keySet, {
        algorithms: ["RS256"],
        audience: this.audience,
        issuer: this.issuer,
      });
      if (!payload.sub) throw new UnauthorizedException("Apple token has no subject");
      if (payload.nonce !== expectedNonceHash) {
        throw new UnauthorizedException("Apple token nonce mismatch");
      }
      return {
        subject: payload.sub,
        ...(typeof payload.email === "string" ? { email: payload.email } : {}),
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException("Invalid or expired Apple identity token");
    }
  }
}
