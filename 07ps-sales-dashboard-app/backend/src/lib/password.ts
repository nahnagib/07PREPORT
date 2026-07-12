import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const SALT_ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Minimum enterprise password policy: 8+ chars, at least one letter and one number.
 * Applied to admin-set/imported temp passwords, self-service change, and resets alike, so no
 * path can create a credential weaker than what a user would be forced to pick themselves.
 */
export function validatePasswordPolicy(plain: string): string | null {
  if (typeof plain !== 'string' || plain.length < 8) {
    return 'Password must be at least 8 characters long.';
  }
  if (!/[A-Za-z]/.test(plain) || !/[0-9]/.test(plain)) {
    return 'Password must contain at least one letter and one number.';
  }
  return null;
}

const TEMP_PASSWORD_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';

/** Generates a random password that always satisfies validatePasswordPolicy. */
export function generateTempPassword(length = 12): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += TEMP_PASSWORD_ALPHABET[bytes[i] % TEMP_PASSWORD_ALPHABET.length];
  }
  // Guarantee at least one digit even if randomness didn't happen to include one.
  return `${out.slice(0, -1)}${Math.floor(Math.random() * 10)}`;
}

/** Random opaque token for password-reset links; only its SHA-256 hash is ever stored. */
export function generateResetToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, tokenHash: hashResetToken(token) };
}

export function hashResetToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
