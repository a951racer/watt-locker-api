import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db } from 'mongodb';
import { MongoUserRepository } from './userRepository';

describe('MongoUserRepository', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let repo: MongoUserRepository;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    const uri = mongod.getUri();
    client = new MongoClient(uri);
    await client.connect();
    db = client.db('test');
    repo = new MongoUserRepository(db);
    await repo.createIndexes();
  }, 60_000);

  afterAll(async () => {
    await client.close();
    await mongod.stop();
  });

  afterEach(async () => {
    await db.collection('users').deleteMany({});
  });

  describe('create', () => {
    it('should create a user and return a UserProfile', async () => {
      const profile = await repo.create('test@example.com', 'hashedpw123');

      expect(profile.id).toBeDefined();
      expect(profile.email).toBe('test@example.com');
      expect(profile.createdAt).toBeInstanceOf(Date);
    });

    it('should reject duplicate emails due to unique index', async () => {
      await repo.create('dup@example.com', 'hash1');
      await expect(repo.create('dup@example.com', 'hash2')).rejects.toThrow();
    });
  });

  describe('findByEmail', () => {
    it('should return user with password hash when found', async () => {
      await repo.create('find@example.com', 'secretHash');

      const result = await repo.findByEmail('find@example.com');

      expect(result).not.toBeNull();
      expect(result!.email).toBe('find@example.com');
      expect(result!.passwordHash).toBe('secretHash');
      expect(result!.id).toBeDefined();
      expect(result!.createdAt).toBeInstanceOf(Date);
    });

    it('should return null when email not found', async () => {
      const result = await repo.findByEmail('nonexistent@example.com');
      expect(result).toBeNull();
    });
  });

  describe('findById', () => {
    it('should return UserProfile when found by id', async () => {
      const created = await repo.create('byid@example.com', 'hash');

      const result = await repo.findById(created.id);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(created.id);
      expect(result!.email).toBe('byid@example.com');
      expect(result!.createdAt).toBeInstanceOf(Date);
    });

    it('should return null for non-existent id', async () => {
      const result = await repo.findById('507f1f77bcf86cd799439011');
      expect(result).toBeNull();
    });

    it('should return null for invalid ObjectId format', async () => {
      const result = await repo.findById('not-a-valid-id');
      expect(result).toBeNull();
    });
  });
});
