import { createHash } from "node:crypto";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type KeyLike,
} from "jose";

import { AppleTokenVerifier } from "./apple-token-verifier";

describe("AppleTokenVerifier", () => {
  const audience = "com.healthos.synthetic";
  const issuer = "https://appleid.apple.com";
  let privateKey: KeyLike;
  let verifier: AppleTokenVerifier;

  beforeAll(async () => {
    const keys = await generateKeyPair("RS256");
    privateKey = keys.privateKey;
    const publicJwk = await exportJWK(keys.publicKey);
    verifier = new AppleTokenVerifier({
      audience,
      issuer,
      keySet: createLocalJWKSet({
        keys: [{ ...publicJwk, alg: "RS256", kid: "synthetic-apple-key" }],
      }),
    });
  });

  async function token({
    tokenAudience = audience,
    expiresIn = "5m",
    nonce = "synthetic-nonce",
  }: {
    tokenAudience?: string;
    expiresIn?: string | number;
    nonce?: string;
  } = {}) {
    return new SignJWT({ nonce, email: "synthetic@example.invalid" })
      .setProtectedHeader({ alg: "RS256", kid: "synthetic-apple-key" })
      .setIssuer(issuer)
      .setAudience(tokenAudience)
      .setSubject("synthetic-apple-subject")
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(privateKey);
  }

  test("accepts a correctly signed token with the expected nonce hash", async () => {
    const nonce = "nonce-for-valid-token";
    const nonceHash = createHash("sha256").update(nonce).digest("hex");
    const claims = await verifier.verify(await token({ nonce: nonceHash }), nonceHash);

    expect(claims.subject).toBe("synthetic-apple-subject");
    expect(claims.email).toBe("synthetic@example.invalid");
  });

  test("rejects the wrong audience", async () => {
    await expect(
      verifier.verify(await token({ tokenAudience: "wrong.audience" }), "synthetic-nonce"),
    ).rejects.toThrow(/audience|token/i);
  });

  test("rejects an expired token", async () => {
    await expect(
      verifier.verify(await token({ expiresIn: Math.floor(Date.now() / 1000) - 60 }), "synthetic-nonce"),
    ).rejects.toThrow(/expired|token/i);
  });

  test("rejects a nonce mismatch", async () => {
    await expect(
      verifier.verify(await token({ nonce: "different" }), "expected"),
    ).rejects.toThrow(/nonce/i);
  });
});
