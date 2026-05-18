import { hashPassword, comparePassword } from './password';

describe('password utilities', () => {
  it('should hash a password and produce a bcrypt hash string', async () => {
    const hash = await hashPassword('mySecret123');
    expect(hash).toBeDefined();
    expect(hash).not.toBe('mySecret123');
    // bcrypt hashes start with $2b$ or $2a$
    expect(hash).toMatch(/^\$2[ab]\$/);
  });

  it('should return true when comparing correct password against its hash', async () => {
    const password = 'correctPassword!';
    const hash = await hashPassword(password);
    const result = await comparePassword(password, hash);
    expect(result).toBe(true);
  });

  it('should return false when comparing incorrect password against a hash', async () => {
    const hash = await hashPassword('originalPassword');
    const result = await comparePassword('wrongPassword', hash);
    expect(result).toBe(false);
  });

  it('should produce different hashes for the same password (due to salt)', async () => {
    const password = 'samePassword';
    const hash1 = await hashPassword(password);
    const hash2 = await hashPassword(password);
    expect(hash1).not.toBe(hash2);
  });
});
