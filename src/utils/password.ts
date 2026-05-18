import bcrypt from 'bcrypt';
import { config } from '../config/env';

/**
 * Hash a plaintext password using bcrypt with configurable salt rounds.
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, config.bcrypt.saltRounds);
}

/**
 * Compare a plaintext password against a bcrypt hash.
 */
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
