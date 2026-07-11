import { createSecretKey } from "node:crypto";
import { cookies } from "next/headers";
import { jwtVerify } from "jose";

export const ADMIN_SESSION_COOKIE = "healthos_admin_session";
const ADMIN_SESSION_MAX_LIFETIME_SECONDS = 15 * 60;
const ADMIN_SESSION_CLOCK_SKEW_SECONDS = 60;

export interface AdminWebSession {
  actorId: string;
  accessToken: string;
  mfa: true;
}

export async function verifyAdminWebSessionToken(token: string, secret: string): Promise<AdminWebSession | null> {
  if (secret.length < 32) return null;
  try {
    const { payload } = await jwtVerify(token, createSecretKey(Buffer.from(secret, "utf8")), {
      algorithms: ["HS256"],
      issuer: "healthos-admin-web",
    });
    const now = Math.floor(Date.now() / 1000);
    if (
      payload.type !== "admin_web_session" || payload.mfa !== true
      || typeof payload.actor_id !== "string" || !/^[0-9a-f-]{36}$/.test(payload.actor_id)
      || typeof payload.api_access_token !== "string" || payload.api_access_token.length < 16
      || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)
      || payload.exp! <= payload.iat!
      || payload.exp! - payload.iat! > ADMIN_SESSION_MAX_LIFETIME_SECONDS
      || payload.exp! > now + ADMIN_SESSION_MAX_LIFETIME_SECONDS
      || payload.iat! > now + ADMIN_SESSION_CLOCK_SKEW_SECONDS
    ) return null;
    return { actorId: payload.actor_id, accessToken: payload.api_access_token, mfa: true };
  } catch {
    return null;
  }
}

export async function loadAdminWebSession(): Promise<AdminWebSession | null> {
  const secret = process.env.HEALTHOS_ADMIN_WEB_SESSION_SECRET;
  if (!secret) return null;
  const token = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifyAdminWebSessionToken(token, secret);
}
