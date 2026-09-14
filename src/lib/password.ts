import bcrypt from 'bcrypt';

/**
 * The only module that imports `bcrypt`. The cost factor is defined once, here
 * (BE-3.1, SEC-9). Verification is always `bcrypt.compare` — never a string
 * comparison.
 */
const COST_FACTOR = 12;

/**
 * A hash of a value no one knows, generated once at module load.
 *
 * Login against an unknown email compares the supplied password against this so
 * that the unknown-email path costs the same ~200ms as the wrong-password path
 * (BE-3.3, SEC-3). Without it, response timing distinguishes "no such account"
 * from "wrong password" even though the response bodies are identical.
 */
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing-equalisation', COST_FACTOR);

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST_FACTOR);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** Burns the same time as a real verification, then discards the result. */
export async function verifyDummyPassword(plain: string): Promise<void> {
  await bcrypt.compare(plain, DUMMY_HASH);
}
