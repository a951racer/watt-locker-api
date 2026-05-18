import { Collection, Db, ObjectId } from 'mongodb';
import { UserProfile } from '../models/user';

/** Stored user document shape in MongoDB */
export interface UserDocument {
  _id: ObjectId;
  email: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Result of findByEmail including the password hash for auth verification */
export interface UserWithPassword {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
}

/** User repository interface for database access abstraction */
export interface IUserRepository {
  create(email: string, passwordHash: string): Promise<UserProfile>;
  findByEmail(email: string): Promise<UserWithPassword | null>;
  findById(id: string): Promise<UserProfile | null>;
}

/** MongoDB implementation of the user repository */
export class MongoUserRepository implements IUserRepository {
  private collection: Collection<Omit<UserDocument, '_id'>>;

  constructor(db: Db) {
    this.collection = db.collection('users');
  }

  /** Ensure required indexes exist on the users collection */
  async createIndexes(): Promise<void> {
    await this.collection.createIndex({ email: 1 }, { unique: true });
  }

  async create(email: string, passwordHash: string): Promise<UserProfile> {
    const now = new Date();
    const result = await this.collection.insertOne({
      email,
      passwordHash,
      createdAt: now,
      updatedAt: now,
    });

    return {
      id: result.insertedId.toHexString(),
      email,
      createdAt: now,
    };
  }

  async findByEmail(email: string): Promise<UserWithPassword | null> {
    const doc = await this.collection.findOne({ email });
    if (!doc) return null;

    const id = (doc as unknown as UserDocument)._id;
    return {
      id: id.toHexString(),
      email: doc.email,
      passwordHash: doc.passwordHash,
      createdAt: doc.createdAt,
    };
  }

  async findById(id: string): Promise<UserProfile | null> {
    if (!ObjectId.isValid(id)) return null;

    const doc = await this.collection.findOne({ _id: new ObjectId(id) });
    if (!doc) return null;

    const docId = (doc as unknown as UserDocument)._id;
    return {
      id: docId.toHexString(),
      email: doc.email,
      createdAt: doc.createdAt,
    };
  }
}
