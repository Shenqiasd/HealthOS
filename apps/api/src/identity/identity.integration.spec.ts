import { createHash, randomUUID } from "node:crypto";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type KeyLike,
} from "jose";

import { DatabaseService } from "../database/prisma.service";
import { AppleTokenVerifier } from "./apple-token-verifier";
import { DeviceService, DeviceTokenCipher } from "./device.service";
import { IdentityService } from "./identity.service";
import { SessionService } from "./session.service";

describe("identity integration", () => {
  const database = new DatabaseService();
  const audience = "com.healthos.synthetic";
  const issuer = "https://appleid.apple.com";
  let privateKey: KeyLike;
  let identity: IdentityService;
  let sessions: SessionService;
  let devices: DeviceService;
  let deviceCipher: DeviceTokenCipher;

  beforeAll(async () => {
    const keys = await generateKeyPair("RS256");
    privateKey = keys.privateKey;
    const publicJwk = await exportJWK(keys.publicKey);
    const verifier = new AppleTokenVerifier({
      audience,
      issuer,
      keySet: createLocalJWKSet({
        keys: [{ ...publicJwk, alg: "RS256", kid: "synthetic-apple-key" }],
      }),
    });
    sessions = new SessionService(database, {
      issuer: "healthos-synthetic",
      signingSecret: "synthetic-signing-secret-at-least-32-bytes",
      accessTtlSeconds: 900,
      refreshTtlSeconds: 86_400,
    });
    identity = new IdentityService(database, verifier, sessions, {
      subjectHashKey: "synthetic-subject-hash-key-at-least-32-bytes",
      nonceTtlSeconds: 300,
    });
    deviceCipher = new DeviceTokenCipher(Buffer.alloc(32, 7));
    devices = new DeviceService(database, deviceCipher);
    await database.$connect();
  });

  afterEach(async () => {
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE
        security_events,
        refresh_sessions,
        apple_auth_nonces,
        devices,
        user_identities,
        users
      RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  async function signAppleToken(subject: string, rawNonce: string) {
    const nonceHash = createHash("sha256").update(rawNonce).digest("hex");
    return new SignJWT({ nonce: nonceHash })
      .setProtectedHeader({ alg: "RS256", kid: "synthetic-apple-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  async function login(subject = "apple-subject-1") {
    const nonce = await identity.issueNonce();
    const correlationId = randomUUID();
    return identity.authenticateWithApple({
      correlationId,
      identityToken: await signAppleToken(subject, nonce.value),
      nonce: nonce.value,
    });
  }

  test("stores only the hashed Apple subject and hashed refresh token", async () => {
    const result = await login();
    const storedIdentity = await database.userIdentity.findFirstOrThrow();
    const storedSession = await database.refreshSession.findFirstOrThrow();

    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(storedIdentity.providerSubjectHash).not.toContain("apple-subject-1");
    expect(storedSession.tokenHash).not.toBe(result.refreshToken);
  });

  test("consumes each nonce once", async () => {
    const nonce = await identity.issueNonce();
    const identityToken = await signAppleToken("apple-subject-replay", nonce.value);
    const request = {
      correlationId: randomUUID(),
      identityToken,
      nonce: nonce.value,
    };

    await identity.authenticateWithApple(request);
    await expect(identity.authenticateWithApple(request)).rejects.toThrow(/nonce|replay/i);
  });

  test("does not issue sessions for a deleted user", async () => {
    const first = await login("apple-subject-deleted");
    await database.user.update({
      where: { id: first.userId },
      data: { status: "deleted", deletedAt: new Date() },
    });
    const nonce = await identity.issueNonce();

    await expect(
      identity.authenticateWithApple({
        correlationId: randomUUID(),
        identityToken: await signAppleToken("apple-subject-deleted", nonce.value),
        nonce: nonce.value,
      }),
    ).rejects.toThrow(/deleted|inactive/i);
  });

  test("rotates refresh tokens and revokes the family on reuse", async () => {
    const first = await login("apple-subject-rotation");
    const rotated = await sessions.rotate(first.refreshToken, randomUUID());

    expect(rotated.refreshToken).not.toBe(first.refreshToken);
    await expect(sessions.rotate(first.refreshToken, randomUUID())).rejects.toThrow(
      /reused|revoked/i,
    );
    const family = await database.refreshSession.findMany();
    expect(family).toHaveLength(2);
    expect(family.every((session) => session.revokedAt !== null)).toBe(true);
    const reuseEvent = await database.securityEvent.findFirstOrThrow({
      where: { eventType: "refresh_token_reuse" },
    });
    expect(JSON.stringify(reuseEvent.metadata)).not.toContain(first.refreshToken);
    await expect(sessions.rotate(rotated.refreshToken, randomUUID())).rejects.toThrow(
      /revoked/i,
    );
  });

  test("allows only one winner when the same refresh token is rotated concurrently", async () => {
    const first = await login("apple-subject-concurrent-rotation");
    const outcomes = await Promise.allSettled([
      sessions.rotate(first.refreshToken, randomUUID()),
      sessions.rotate(first.refreshToken, randomUUID()),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const family = await database.refreshSession.findMany();
    expect(family).toHaveLength(2);
    expect(family.every((session) => session.revokedAt !== null)).toBe(true);
  });

  test("logout revokes the refresh-token family", async () => {
    const first = await login("apple-subject-logout");
    await sessions.revoke(first.refreshToken, randomUUID());

    await expect(sessions.rotate(first.refreshToken, randomUUID())).rejects.toThrow(
      /revoked/i,
    );
  });

  test("accepts the previous access signing key only during rotation", async () => {
    const oldSecret = "synthetic-old-signing-secret-at-least-32-bytes";
    const newSecret = "synthetic-new-signing-secret-at-least-32-bytes";
    const oldSessions = new SessionService(database, {
      issuer: "healthos-rotation-test",
      signingSecret: oldSecret,
      accessTtlSeconds: 900,
      refreshTtlSeconds: 86_400,
    });
    const user = await database.user.create({ data: {} });
    const oldTokens = await oldSessions.issue(user.id);
    const rotatingSessions = new SessionService(database, {
      issuer: "healthos-rotation-test",
      signingSecret: newSecret,
      previousSigningSecret: oldSecret,
      accessTtlSeconds: 900,
      refreshTtlSeconds: 86_400,
    });
    const rotatedSessions = new SessionService(database, {
      issuer: "healthos-rotation-test",
      signingSecret: newSecret,
      accessTtlSeconds: 900,
      refreshTtlSeconds: 86_400,
    });

    await expect(
      rotatingSessions.verifyAccessToken(oldTokens.accessToken),
    ).resolves.toMatchObject({ userId: user.id });
    await expect(
      rotatedSessions.verifyAccessToken(oldTokens.accessToken),
    ).rejects.toThrow(/invalid|signature/i);
  });

  test("device registration is idempotent and encrypts the APNs token", async () => {
    const loginResult = await login("apple-subject-device");
    const principal = await sessions.verifyAccessToken(loginResult.accessToken);
    const apnsToken = "synthetic-apns-token";
    await devices.register(principal.userId, {
      apnsToken,
      appVersion: "1.0.0",
      deviceId: "synthetic-device",
    });
    await devices.register(principal.userId, {
      apnsToken,
      appVersion: "1.0.1",
      deviceId: "synthetic-device",
    });

    const stored = await database.device.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.apnsTokenEncrypted).not.toContain(apnsToken);
    expect(deviceCipher.decrypt(stored[0]?.apnsTokenEncrypted ?? "")).toBe(apnsToken);
    expect(stored[0]?.apnsTokenFingerprint).toBeTruthy();
    expect(stored[0]?.appVersion).toBe("1.0.1");
  });
});
