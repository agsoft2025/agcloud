import argon2 from "argon2";
import bcrypt from "bcrypt";

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
};

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/**
 * Verify a password against a stored hash.
 * Handles both argon2id hashes and legacy bcrypt hashes.
 * Returns { valid, needsRehash } - if needsRehash is true, re-hash with argon2id and persist.
 */
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<{ valid: boolean; needsRehash: boolean }> {
  if (storedHash.startsWith("$2b$") || storedHash.startsWith("$2a$")) {
    const valid = await bcrypt.compare(password, storedHash);
    return { valid, needsRehash: valid };
  }

  try {
    const valid = await argon2.verify(storedHash, password, ARGON2_OPTIONS);
    const needsRehash = valid && argon2.needsRehash(storedHash, ARGON2_OPTIONS);
    return { valid, needsRehash };
  } catch {
    return { valid: false, needsRehash: false };
  }
}
