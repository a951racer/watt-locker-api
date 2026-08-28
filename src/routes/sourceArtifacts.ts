import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { ISourceArtifactRepository } from '../repositories/sourceArtifactRepository';
import { IWorkoutRepository } from '../repositories/workoutRepository';
import { IUploadService } from '../services/uploadService';
import { FileStorageAdapter, StorageReference } from '../storage/googleDriveAdapter';
import { ValidationError, NotFoundError } from '../utils/errors';
import { successResponse } from '../utils/response';

/**
 * Creates the source artifacts router with injected dependencies.
 * All endpoints require JWT authentication (applied via authMiddleware).
 */
export function createSourceArtifactsRouter(
  sourceArtifactRepository: ISourceArtifactRepository,
  workoutRepository: IWorkoutRepository,
  authMiddleware: RequestHandler,
  uploadService?: IUploadService,
  fileStorageAdapter?: FileStorageAdapter,
): Router {
  const router = Router();

  // Apply auth middleware to all source artifact routes
  router.use(authMiddleware);

  /**
   * GET /api/source-artifacts/unassociated
   * Returns all artifacts where activityId = null for the authenticated user.
   */
  router.get('/unassociated', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const artifacts = await sourceArtifactRepository.findUnassociated(userId);
      res.status(200).json(successResponse(artifacts));
    } catch (err) {
      next(err);
    }
  });

  /**
   * PUT /api/source-artifacts/:artifactId/promote
   * Promotes a secondary artifact to primary for its associated Activity.
   * Demotes the current primary to secondary.
   */
  router.put('/:artifactId/promote', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const artifactId = req.params.artifactId as string;

      // Load the artifact
      const artifact = await sourceArtifactRepository.findById(artifactId);
      if (!artifact || artifact.userId !== userId) {
        throw new NotFoundError('Source artifact not found');
      }

      // Must be associated with an Activity
      if (!artifact.activityId) {
        throw new ValidationError('Artifact is not associated with an Activity');
      }

      // Must be secondary to promote
      if (artifact.role === 'primary') {
        throw new ValidationError('Artifact is already the primary source');
      }

      // Demote current primary (if exists)
      const currentPrimary = await sourceArtifactRepository.findPrimaryByActivityId(userId, artifact.activityId);
      if (currentPrimary) {
        await sourceArtifactRepository.update(currentPrimary.id, { role: 'secondary', materialized: false });
      }

      // Promote this artifact to primary and materialize
      if (uploadService && fileStorageAdapter) {
        try {
          const fileBuffer = await fileStorageAdapter.retrieve({
            fileId: artifact.driveFileId,
            fileName: artifact.originalFileName,
            folderPath: '',
          } as StorageReference);

          await uploadService.materializeActivity(
            artifact.activityId,
            userId,
            fileBuffer,
            artifact.originalFileName,
            artifactId,
          );
        } catch (matErr) {
          // Rollback: re-promote old primary, re-demote this one
          if (currentPrimary) {
            await sourceArtifactRepository.update(currentPrimary.id, { role: 'primary', materialized: true });
          }
          throw matErr;
        }
      }

      const promoted = await sourceArtifactRepository.update(artifactId, { role: 'primary', materialized: true });

      res.status(200).json(successResponse(promoted));
    } catch (err) {
      next(err);
    }
  });

  /**
   * PUT /api/source-artifacts/:artifactId/associate
   * Associates an artifact with an Activity.
   * Body: { activityId: string }
   */
  router.put('/:artifactId/associate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const artifactId = req.params.artifactId as string;
      const { activityId } = req.body ?? {};

      if (!activityId || typeof activityId !== 'string') {
        throw new ValidationError('activityId is required', { field: 'activityId' });
      }

      // Load the artifact
      const artifact = await sourceArtifactRepository.findById(artifactId);
      if (!artifact || artifact.userId !== userId) {
        throw new NotFoundError('Source artifact not found');
      }

      // Verify target Activity exists and belongs to user
      const targetActivity = await workoutRepository.findById(activityId);
      if (!targetActivity || targetActivity.userId !== userId) {
        throw new NotFoundError('Activity not found');
      }

      // If artifact was previously primary on another Activity, clear that Activity's materialization
      if (artifact.activityId && artifact.role === 'primary' && artifact.activityId !== activityId) {
        if (uploadService) {
          await uploadService.clearActivityMaterialization(artifact.activityId, userId);
        }
      }

      // Determine role: if target has no primary, this becomes primary; otherwise secondary
      const existingPrimary = await sourceArtifactRepository.findPrimaryByActivityId(userId, activityId);
      const role = existingPrimary ? 'secondary' : 'primary';

      // If becoming primary, materialize
      if (role === 'primary' && uploadService && fileStorageAdapter) {
        const fileBuffer = await fileStorageAdapter.retrieve({
          fileId: artifact.driveFileId,
          fileName: artifact.originalFileName,
          folderPath: '',
        } as StorageReference);

        await uploadService.materializeActivity(
          activityId,
          userId,
          fileBuffer,
          artifact.originalFileName,
          artifactId,
        );
      }

      const updated = await sourceArtifactRepository.update(artifactId, {
        activityId,
        role,
        materialized: role === 'primary',
      });

      res.status(200).json(successResponse(updated));
    } catch (err) {
      next(err);
    }
  });

  /**
   * PUT /api/source-artifacts/:artifactId/disassociate
   * Removes the association between an artifact and its Activity.
   * Sets activityId = null and role = 'secondary'.
   */
  router.put('/:artifactId/disassociate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const artifactId = req.params.artifactId as string;

      // Load the artifact
      const artifact = await sourceArtifactRepository.findById(artifactId);
      if (!artifact || artifact.userId !== userId) {
        throw new NotFoundError('Source artifact not found');
      }

      // If this artifact was primary, clear materialization from the Activity
      if (artifact.role === 'primary' && artifact.activityId && uploadService) {
        await uploadService.clearActivityMaterialization(artifact.activityId, userId);
      }

      const updated = await sourceArtifactRepository.update(artifactId, {
        activityId: null,
        role: 'secondary',
        materialized: false,
      });

      res.status(200).json(successResponse(updated));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
