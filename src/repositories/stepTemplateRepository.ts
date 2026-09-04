/**
 * PLAN-057: MongoDB repository for user-owned Step Templates.
 *
 * Dedicated `stepTemplates` collection — deliberately NOT the `workouts`
 * collection / whole-Activity template flag. Follows the same repository
 * conventions as MongoSettingsRepository / MongoWorkoutRepository.
 */
import { Collection, Db, ObjectId, Filter } from 'mongodb';
import { StepTemplate, CreateStepTemplateInput, UpdateStepTemplateInput } from '../models/stepTemplate';
import { PlanSegment } from '../models/workout';

/** Stored Step Template document shape in MongoDB. */
export interface StepTemplateDocument {
  _id: ObjectId;
  userId: string;
  name: string;
  step: PlanSegment;
  createdAt: Date;
  updatedAt: Date;
}

/** Repository interface for Step Template persistence. */
export interface IStepTemplateRepository {
  createIndexes(): Promise<void>;
  create(userId: string, input: CreateStepTemplateInput): Promise<StepTemplate>;
  findById(id: string): Promise<StepTemplate | null>;
  listByUser(userId: string): Promise<StepTemplate[]>;
  update(id: string, updates: UpdateStepTemplateInput): Promise<StepTemplate | null>;
  delete(id: string): Promise<boolean>;
}

/** MongoDB implementation of the Step Template repository. */
export class MongoStepTemplateRepository implements IStepTemplateRepository {
  private collection: Collection<StepTemplateDocument>;

  constructor(db: Db) {
    this.collection = db.collection<StepTemplateDocument>('stepTemplates');
  }

  /** Ensure required indexes exist. Idempotent; safe to call on startup. */
  async createIndexes(): Promise<void> {
    // Library listing: a user's templates, most-recently-updated first.
    await this.collection.createIndex({ userId: 1, updatedAt: -1 });
  }

  async create(userId: string, input: CreateStepTemplateInput): Promise<StepTemplate> {
    const now = new Date();
    const doc: Omit<StepTemplateDocument, '_id'> = {
      userId,
      name: input.name,
      step: input.step,
      createdAt: now,
      updatedAt: now,
    };
    const result = await this.collection.insertOne(doc as StepTemplateDocument);
    return this.toRecord({ ...doc, _id: result.insertedId } as StepTemplateDocument);
  }

  async findById(id: string): Promise<StepTemplate | null> {
    if (!ObjectId.isValid(id)) return null;
    const doc = await this.collection.findOne({ _id: new ObjectId(id) } as Filter<StepTemplateDocument>);
    return doc ? this.toRecord(doc) : null;
  }

  async listByUser(userId: string): Promise<StepTemplate[]> {
    const docs = await this.collection
      .find({ userId })
      .sort({ updatedAt: -1 })
      .toArray();
    return docs.map((d) => this.toRecord(d));
  }

  async update(id: string, updates: UpdateStepTemplateInput): Promise<StepTemplate | null> {
    if (!ObjectId.isValid(id)) return null;
    const $set: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.name !== undefined) $set.name = updates.name;
    if (updates.step !== undefined) $set.step = updates.step;

    const result = await this.collection.findOneAndUpdate(
      { _id: new ObjectId(id) } as Filter<StepTemplateDocument>,
      { $set },
      { returnDocument: 'after' },
    );
    return result ? this.toRecord(result) : null;
  }

  async delete(id: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false;
    const result = await this.collection.deleteOne({ _id: new ObjectId(id) } as Filter<StepTemplateDocument>);
    return result.deletedCount === 1;
  }

  private toRecord(doc: StepTemplateDocument): StepTemplate {
    return {
      id: doc._id.toHexString(),
      userId: doc.userId,
      name: doc.name,
      step: doc.step,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}
