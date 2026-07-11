import assert from "node:assert/strict";
import test from "node:test";
import { createSecretKey } from "node:crypto";
import { SignJWT } from "jose";

import { verifyAdminWebSessionToken } from "../lib/api/admin-web-session";
import { serverOperationsConfig } from "../lib/api/operations";

const secret = "synthetic-admin-web-session-secret-at-least-32-characters";
const actorId = "11111111-1111-4111-8111-111111111111";

async function token(claims: Record<string, unknown>) {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuer("healthos-admin-web").setIssuedAt().setExpirationTime("5m")
    .sign(createSecretKey(Buffer.from(secret, "utf8")));
}

async function tokenWithTimes(claims: Record<string, unknown>, issuedAt?: number, expiration?: number) {
  let signer = new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuer("healthos-admin-web");
  if (issuedAt !== undefined) signer = signer.setIssuedAt(issuedAt);
  if (expiration !== undefined) signer = signer.setExpirationTime(expiration);
  return signer.sign(createSecretKey(Buffer.from(secret, "utf8")));
}

test("accepts only a request-bound administrator session with MFA", async () => {
  const valid = await token({ type: "admin_web_session", actor_id: actorId, mfa: true, api_access_token: "request-bound-api-token" });
  await assert.doesNotReject(async () => {
    assert.deepEqual(await verifyAdminWebSessionToken(valid, secret), {
      actorId, accessToken: "request-bound-api-token", mfa: true,
    });
  });
  const noMfa = await token({ type: "admin_web_session", actor_id: actorId, mfa: false, api_access_token: "request-bound-api-token" });
  assert.equal(await verifyAdminWebSessionToken(noMfa, secret), null);
  const userToken = await token({ type: "access", sub: actorId, mfa: true, api_access_token: "request-bound-api-token" });
  assert.equal(await verifyAdminWebSessionToken(userToken, secret), null);
});

test("rejects missing, excessive, and future administrator session lifetimes", async () => {
  const claims = { type: "admin_web_session", actor_id: actorId, mfa: true, api_access_token: "request-bound-api-token" };
  const now = Math.floor(Date.now() / 1000);
  assert.equal(await verifyAdminWebSessionToken(await tokenWithTimes(claims, now), secret), null);
  assert.equal(await verifyAdminWebSessionToken(await tokenWithTimes(claims, now, now + 60 * 60), secret), null);
  assert.equal(await verifyAdminWebSessionToken(await tokenWithTimes(claims, now + 5 * 60, now + 10 * 60), secret), null);
  assert.equal(await verifyAdminWebSessionToken(await tokenWithTimes(claims, now + 60, now + 16 * 60), secret), null);
});

test("never uses a global environment token as visitor authorization", () => {
  process.env.HEALTHOS_ADMIN_ACCESS_TOKEN = "shared-token-must-be-ignored";
  process.env.HEALTHOS_API_BASE_URL = "http://127.0.0.1:3000";
  assert.deepEqual(serverOperationsConfig({ actorId, accessToken: "request-token", mfa: true }), {
    baseUrl: "http://127.0.0.1:3000",
    accessToken: "request-token",
  });
  delete process.env.HEALTHOS_ADMIN_ACCESS_TOKEN;
});
