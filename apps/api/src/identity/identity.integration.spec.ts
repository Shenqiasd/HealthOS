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
    expect(stored[0]?.apnsTokenEpoch).toBe(1);
    expect(stored[0]?.appVersion).toBe("1.0.1");
  });

  test("atomically transfers one APNs token to the newly authenticated account", async () => {
    const first = await login("apple-subject-device-owner-first");
    const second = await login("apple-subject-device-owner-second");
    const apnsToken = "synthetic-shared-apns-token";
    const fingerprint = deviceCipher.fingerprint(apnsToken);

    await devices.register(first.userId, {
      apnsToken,
      appVersion: "1.0.0",
      deviceId: "synthetic-first-account-device",
    });
    await devices.register(second.userId, {
      apnsToken,
      appVersion: "1.0.0",
      deviceId: "synthetic-second-account-device",
    });

    const firstDevice = await database.device.findUniqueOrThrow({
      where: {
        userId_deviceId: {
          userId: first.userId,
          deviceId: "synthetic-first-account-device",
        },
      },
    });
    const secondDevice = await database.device.findUniqueOrThrow({
      where: {
        userId_deviceId: {
          userId: second.userId,
          deviceId: "synthetic-second-account-device",
        },
      },
    });
    expect(firstDevice.apnsTokenEncrypted).toBeNull();
    expect(firstDevice.apnsTokenFingerprint).toBeNull();
    expect(secondDevice.apnsTokenFingerprint).toBe(fingerprint);
    expect(secondDevice.apnsTokenEpoch).toBe(1);
    expect(await database.device.count({ where: { apnsTokenFingerprint: fingerprint } })).toBe(1);
  });

  test("serializes concurrent cross-account claims to one current APNs owner", async () => {
    const first = await login("apple-subject-concurrent-device-first");
    const second = await login("apple-subject-concurrent-device-second");
    const apnsToken = "synthetic-concurrent-shared-token";
    const fingerprint = deviceCipher.fingerprint(apnsToken);

    await Promise.all([
      devices.register(first.userId, {
        apnsToken,
        appVersion: "1.0.0",
        deviceId: "synthetic-concurrent-first",
      }),
      devices.register(second.userId, {
        apnsToken,
        appVersion: "1.0.0",
        deviceId: "synthetic-concurrent-second",
      }),
    ]);

    const stored = await database.device.findMany({ orderBy: { deviceId: "asc" } });
    expect(stored).toHaveLength(2);
    expect(stored.filter((device) => device.apnsTokenFingerprint === fingerprint)).toHaveLength(1);
    expect(stored.filter((device) => device.apnsTokenFingerprint === null)).toHaveLength(1);
  });

  test("serializes concurrent two-device APNs token swaps without deadlock or lost ownership", async () => {
    const first = await login("apple-subject-token-swap-first");
    const second = await login("apple-subject-token-swap-second");
    const firstToken = "synthetic-swap-token-first";
    const secondToken = "synthetic-swap-token-second";
    const firstFingerprint = deviceCipher.fingerprint(firstToken);
    const secondFingerprint = deviceCipher.fingerprint(secondToken);

    await devices.register(first.userId, {
      apnsToken: firstToken,
      appVersion: "1.0.0",
      deviceId: "synthetic-swap-device-first",
    });
    await devices.register(second.userId, {
      apnsToken: secondToken,
      appVersion: "1.0.0",
      deviceId: "synthetic-swap-device-second",
    });

    const outcomes = await Promise.allSettled([
      devices.register(first.userId, {
        apnsToken: secondToken,
        appVersion: "1.0.1",
        deviceId: "synthetic-swap-device-first",
      }),
      devices.register(second.userId, {
        apnsToken: firstToken,
        appVersion: "1.0.1",
        deviceId: "synthetic-swap-device-second",
      }),
    ]);

    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    const stored = await database.device.findMany({ orderBy: { deviceId: "asc" } });
    expect(stored).toHaveLength(2);
    expect(stored.find((device) => device.deviceId === "synthetic-swap-device-first"))
      .toMatchObject({ apnsTokenFingerprint: secondFingerprint, apnsTokenEpoch: 2 });
    expect(stored.find((device) => device.deviceId === "synthetic-swap-device-second"))
      .toMatchObject({ apnsTokenFingerprint: firstFingerprint, apnsTokenEpoch: 2 });
  });
});
