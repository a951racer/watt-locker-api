import { Collection, Db, ObjectId } from 'mongodb';

/** Source artifact role */
export type ArtifactRole = 'primary' | 'secondary';

/** Source artifact origin */
export type ArtifactSource = 'manual' | 'strava' | 'garmin' | 'trainingpeaks';

/** Source artifact file format */
export type ArtifactFormat = 'fit' | 'tcx' | 'gpx';

/** Stored source artifact document shape in MongoDB */
export interface SourceArtifactDocument {
  _id: ObjectId;
  userId: string;

  // Identity & provenance
  source: ArtifactSource;
  format: ArtifactFormat;
  originalFileName: string;
  sourceActivityId?: string;
  importedAt: Date;

  // Storage — at least one of driveFileId or fileContent must provide durable binary access
  driveFileId: string;
  driveWebViewLink?: string;
  fileContent?: Buffer; // MongoDB-backed fallback when Drive is unavailable

  // Parsed identification data (for matching, not full materialization)
  startTime?: Date;
  durationSeconds?: number;
  activityType?: string;

  // Association
  activityId: string | null;
  role: ArtifactRole;

  // State
  materialized: boolean;

  createdAt: Date;
  updatedAt: Date;
}

/** Domain representation of a source artifact */
export interface SourceArtifactRecord {
  id: string;
  userId: string;
  source: ArtifactSource;
  format: ArtifactFormat;
  originalFileName: string;
  sourceActivityId?: string;
  importedAt: Date;
  driveFileId: string;
  driveWebViewLink?: string;
  fileContent?: Buffer;
  startTime?: Date;
  durationSeconds?: number;
  activityType?: string;
  activityId: string | null;
  role: ArtifactRole;
  materialized: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields that can be updated on a source artifact */
export interface SourceArtifactUpdate {
  activityId?: string | null;
  role?: ArtifactRole;
  materialized?: boolean;
}

/** Source artifact repository interface */
export interface ISourceArtifactRepository {
  createIndexes(): Promise<void>;
  create(artifact: Omit<SourceArtifactRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<SourceArtifactRecord>;
  findById(id: string): Promise<SourceArtifactRecord | null>;
  findByActivityId(userId: string, activityId: string): Promise<SourceArtifactRecord[]>;
  findPrimaryByActivityId(userId: string, activityId: string): Promise<SourceArtifactRecord | null>;
  findUnassociated(userId: string): Promise<SourceArtifactRecord[]>;
  findDuplicateCandidate(userId: string, startTime: Date, durationSeconds: number): Promise<SourceArtifactRecord | null>;
  update(id: string, updates: SourceArtifactUpdate): Promise<SourceArtifactRecord>;
  disassociateByActivityId(activityId: string): Promise<number>;
}

/** MongoDB implementation of the source artifact repository */
export class MongoSourceArtifactRepository implements ISourceArtifactRepository {
  private artifacts: Collection<Omit<SourceArtifactDocument, '_id'>>;

  constructor(db: Db) {
    this.artifacts = db.collection('sourceArtifacts');
  }

  async createIndexes(): Promise<void> {
    // Index 1: User + Activity lookup
    await this.artifacts.createIndex({ userId: 1, activityId: 1 });
    // Index 2: Dedup/matching by temporal characteristics
    await this.artifacts.createIndex({ userId: 1, startTime: 1, durationSeconds: 1 });
    // Index 3: Partial unique — at most one primary per Activity
    await this.artifacts.createIndex(
      { activityId: 1, role: 1 },
      {
        unique: true,
        partialFilterExpression: { role: 'primary', activityId: { $type: 'string' } },
      },
    );
  }

  async create(artifact: Omit<SourceArtifactRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<SourceArtifactRecord> {
    const now = new Date();
    const doc: Record<string, unknown> = {
      userId: artifact.userId,
      source: artifact.source,
      format: artifact.format,
      originalFileName: artifact.originalFileName,
      importedAt: artifact.importedAt,
      driveFileId: artifact.driveFileId,
      activityId: artifact.activityId,
      role: artifact.role,
      materialized: artifact.materialized,
      createdAt: now,
      updatedAt: now,
    };

    // Optional fields
    if (artifact.sourceActivityId !== undefined) doc.sourceActivityId = artifact.sourceActivityId;
    if (artifact.driveWebViewLink !== undefined) doc.driveWebViewLink = artifact.driveWebViewLink;
    if (artifact.startTime !== undefined) doc.startTime = artifact.startTime;
    if (artifact.durationSeconds !== undefined) doc.durationSeconds = artifact.durationSeconds;
    if (artifact.activityType !== undefined) doc.activityType = artifact.activityType;
    if (artifact.fileContent !== undefined) doc.fileContent = artifact.fileContent;

    const result = await this.artifacts.insertOne(doc as Omit<SourceArtifactDocument, '_id'>);

    return {
      ...artifact,
      id: result.insertedId.toHexString(),
      createdAt: now,
      updatedAt: now,
    };
  }

  async findById(id: string): Promise<SourceArtifactRecord | null> {
    if (!ObjectId.isValid(id)) return null;

    const doc = await this.artifacts.findOne({ _id: new ObjectId(id) });
    if (!doc) return null;

    return this.toRecord(doc as unknown as SourceArtifactDocument);
  }

  async findByActivityId(userId: string, activityId: string): Promise<SourceArtifactRecord[]> {
    const docs = await this.artifacts.find({ userId, activityId }).toArray();
    return docs.map(doc => this.toRecord(doc as unknown as SourceArtifactDocument));
  }

  async findDuplicateCandidate(userId: string, startTime: Date, durationSeconds: number): Promise<SourceArtifactRecord | null> {
    const doc = await this.artifacts.findOne({ userId, startTime, durationSeconds });
    if (!doc) return null;
    return this.toRecord(doc as unknown as SourceArtifactDocument);
  }

  async update(id: string, updates: SourceArtifactUpdate): Promise<SourceArtifactRecord> {
    if (!ObjectId.isValid(id)) {
      throw new Error(`Source artifact not found: ${id}`);
    }

    const $set: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.activityId !== undefined) $set.activityId = updates.activityId;
    if (updates.role !== undefined) $set.role = updates.role;
    if (updates.materialized !== undefined) $set.materialized = updates.materialized;

    const result = await this.artifacts.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set },
      { returnDocument: 'after' },
    );

    if (!result) {
      throw new Error(`Source artifact not found: ${id}`);
    }

    return this.toRecord(result as unknown as SourceArtifactDocument);
  }

  async findPrimaryByActivityId(userId: string, activityId: string): Promise<SourceArtifactRecord | null> {
    const doc = await this.artifacts.findOne({ userId, activityId, role: 'primary' });
    if (!doc) return null;
    return this.toRecord(doc as unknown as SourceArtifactDocument);
  }

  async findUnassociated(userId: string): Promise<SourceArtifactRecord[]> {
    const docs = await this.artifacts.find({ userId, activityId: null }).toArray();
    return docs.map(doc => this.toRecord(doc as unknown as SourceArtifactDocument));
  }

  async disassociateByActivityId(activityId: string): Promise<number> {
    const result = await this.artifacts.updateMany(
      { activityId },
      { $set: { activityId: null, role: 'secondary' as ArtifactRole, updatedAt: new Date() } },
    );
    return result.modifiedCount;
  }

  private toRecord(doc: SourceArtifactDocument): SourceArtifactRecord {
    return {
      id: doc._id.toHexString(),
      userId: doc.userId,
      source: doc.source,
      format: doc.format,
      originalFileName: doc.originalFileName,
      sourceActivityId: doc.sourceActivityId,
      importedAt: doc.importedAt,
      driveFileId: doc.driveFileId,
      driveWebViewLink: doc.driveWebViewLink,
      fileContent: doc.fileContent,
      startTime: doc.startTime,
      durationSeconds: doc.durationSeconds,
      activityType: doc.activityType,
      activityId: doc.activityId,
      role: doc.role,
      materialized: doc.materialized,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}
