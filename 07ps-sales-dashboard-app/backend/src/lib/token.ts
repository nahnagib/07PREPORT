import crypto from 'crypto';
import jwt from 'jsonwebtoken';

/**
 * Deliberately minimal JWT payload -- identity only. Role/status/permissions are NEVER baked
 * into the token; every request re-loads them from the DB (see middleware/auth.ts). This is what
 * makes a 1-year access token safely revocable without refresh tokens: an admin action (lock,
 * reset password, revoke sessions) changes DB state that's checked on every request, rather than
 * requiring the token itself to change shape or a blacklist to grow per-request.
 */
export interface AccessTokenPayload {
  sub: string;
  jti: string;
}

const ACCESS_TOKEN_TTL = '365d';

export function issueAccessToken(userId: number): { token: string; jti: string; payload: jwt.JwtPayload } {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ sub: String(userId), jti }, process.env.JWT_SECRET as string, {
    expiresIn: ACCESS_TOKEN_TTL,
  });
  const payload = jwt.decode(token) as jwt.JwtPayload;
  return { token, jti, payload };
}

export interface VerifiedAccessToken {
  userId: number;
  jti: string;
  issuedAt: Date;
  expiresAt: Date;
}

export class InvalidTokenError extends Error {}

export function verifyAccessToken(token: string): VerifiedAccessToken {
  let decoded: jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET as string) as jwt.JwtPayload;
  } catch {
    throw new InvalidTokenError('Invalid or expired session');
  }
  const sub = decoded.sub;
  const jti = decoded.jti as string | undefined;
  if (!sub || !jti || typeof decoded.iat !== 'number' || typeof decoded.exp !== 'number') {
    throw new InvalidTokenError('Malformed token');
  }
  const userId = Number(sub);
  if (Number.isNaN(userId)) {
    throw new InvalidTokenError('Malformed token');
  }
  return {
    userId,
    jti,
    issuedAt: new Date(decoded.iat * 1000),
    expiresAt: new Date(decoded.exp * 1000),
  };
}
