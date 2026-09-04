/**
 * PLAN-058: MongoDB repository for user-owned Block Templates.
 *
 * Dedicated `blockTemplates` collection. One document per Block Template with
 * its ordered `steps` array embedded (no separate step collection, no nesting).
 * Mirrors MongoStepTemplateRepository conventions.
 */
import { Collection, Db, ObjectId, Filter } from 'mongodb';
import {
  BlockTemplate,
  CreateBlockTemplateInput,
  UpdateBlockTemplateInput,
} from '../models/blockTemplate';
import { PlanSegment } from '../models/workout';

/** Stored Block Template document shape in MongoDB. */
export interface BlockTemplateDocument {
  _id: ObjectId;
  userId: string;
  name: string;
  repeatCount: number;
  steps: PlanSegment[];
  createdAt: Date;
  updatedAt: Date;
}

/** Repository interface for Block Template persistence. */
export interface IBlockTemplateRepository {
  createIndexes(): Promise<void>;
  create(userId: string, input: CreateBlockTemplateInput): Promise<BlockTemplate>;
  findById(id: string): Promise<BlockTemplate | null>;
  listByUser(userId: string): Promise<BlockTemplate[]>;
  update(id: string, updates: UpdateBlockTemplateInput): Promise<BlockTemplate | null>;
  delete(id: string): Promise<boolean>;
}

/** MongoDB implementation of the Block Template repository. */
export class MongoBlockTemplateRepository implements IBlockTemplateRepository {
  private collection: Collection<BlockTemplateDocument>;

  constructor(db: Db) {
    this.collection = db.collection<BlockTemplateDocument>('blockTemplates');
  }

  /** Ensure required indexes exist. Idempotent; safe to call on startup. */
  async createIndexes(): Promise<void> {
    await this.collection.createIndex({ userId: 1, updatedAt: -1 });
  }

  async create(userId: string, input: CreateBlockTemplateInput): Promise<BlockTemplate> {
    const now = new Date();
    const doc: Omit<BlockTemplateDocument, '_id'> = {
      userId,
      name: input.name,
      repeatCount: input.repeatCount,
      steps: input.steps,
      createdAt: now,
      updatedAt: now,
    };
    const result = await this.collection.insertOne(doc as BlockTemplateDocument);
    return this.toRecord({ ...doc, _id: result.insertedId } as BlockTemplateDocument);
  }

  async findById(id: string): Promise<BlockTemplate | null> {
    if (!ObjectId.isValid(id)) return null;
    const doc = await this.collection.findOne({ _id: new ObjectId(id) } as Filter<BlockTemplateDocument>);
    return doc ? this.toRecord(doc) : null;
  }

  async listByUser(userId: string): Promise<BlockTemplate[]> {
    const docs = await this.collection
      .find({ userId })
      .sort({ updatedAt: -1 })
      .toArray();
    return docs.map((d) => this.toRecord(d));
  }

  async update(id: string, updates: UpdateBlockTemplateInput): Promise<BlockTemplate | null> {
    if (!ObjectId.isValid(id)) return null;
    const $set: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.name !== undefined) $set.name = updates.name;
    if (updates.repeatCount !== undefined) $set.repeatCount = updates.repeatCount;
    if (updates.steps !== undefined) $set.steps = updates.steps;

    const result = await this.collection.findOneAndUpdate(
      { _id: new ObjectId(id) } as Filter<BlockTemplateDocument>,
      { $set },
      { returnDocument: 'after' },
    );
    return result ? this.toRecord(result) : null;
  }

  async delete(id: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false;
    const result = await this.collection.deleteOne({ _id: new ObjectId(id) } as Filter<BlockTemplateDocument>);
    return result.deletedCount === 1;
  }

  private toRecord(doc: BlockTemplateDocument): BlockTemplate {
    return {
      id: doc._id.toHexString(),
      userId: doc.userId,
      name: doc.name,
      repeatCount: doc.repeatCount,
      steps: doc.steps,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}
