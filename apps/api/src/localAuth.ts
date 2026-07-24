import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

export const AUTH_COOKIE_NAME = "unraid_session";
export const AUTH_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

const PASSWORD_SALT = "unraid-control:password:v1";
const SESSION_SALT = "unraid-control:session:v1";

function digest(value: string, salt: string) {
  return scryptSync(value, salt, 32);
}

function safeEqual(left: Buffer, right: Buffer) {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createLocalAuth(password: string) {
  if (password.length < 12) {
    throw new Error("LOCAL_AUTH_PASSWORD must contain at least 12 characters");
  }

  const passwordDigest = digest(password, PASSWORD_SALT);
  const sessionKey = digest(password, SESSION_SALT);

  const sign = (payload: string) =>
    createHmac("sha256", sessionKey).update(payload).digest();

  return {
    verifyPassword(candidate: string) {
      return safeEqual(digest(candidate, PASSWORD_SALT), passwordDigest);
    },
    createSession(now = Date.now(), ttlMs: number = AUTH_SESSION_TTL_MS) {
      const payload = `v1.${(now + ttlMs).toString(36)}.${randomBytes(18).toString("base64url")}`;
      return `${payload}.${sign(payload).toString("base64url")}`;
    },
    verifySession(token: string | undefined, now = Date.now()) {
      if (!token) return false;
      const parts = token.split(".");
      if (parts.length !== 4 || parts[0] !== "v1") return false;
      const payload = parts.slice(0, 3).join(".");
      const expiresAt = Number.parseInt(parts[1]!, 36);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
      try {
        return safeEqual(Buffer.from(parts[3]!, "base64url"), sign(payload));
      } catch {
        return false;
      }
    },
  };
}

export type LocalAuth = ReturnType<typeof createLocalAuth>;
