import { config } from './env';

describe('config', () => {
  it('should have default values', () => {
    expect(config.port).toBe(3000);
    expect(config.nodeEnv).toBe('test');
    expect(config.mongo.uri).toBeDefined();
    expect(config.jwt.secret).toBeDefined();
    expect(config.bcrypt.saltRounds).toBe(12);
  });
});
