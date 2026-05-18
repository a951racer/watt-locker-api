/**
 * Utility for deriving Google Drive folder paths from workout dates.
 * Generates paths in the format: {basePath}/YYYY/MM
 */

/**
 * Derive the Google Drive folder path for a workout based on its date.
 * Uses UTC date components to avoid timezone-dependent folder assignment.
 *
 * @param workoutDate - The date of the workout
 * @param basePath - The user's configured driveStoragePath (e.g., "WattLocker")
 * @returns The full folder path in the format `{basePath}/YYYY/MM`
 */
export function deriveDriveFolderPath(workoutDate: Date, basePath: string): string {
  const year = workoutDate.getUTCFullYear().toString();
  const month = (workoutDate.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${basePath}/${year}/${month}`;
}
