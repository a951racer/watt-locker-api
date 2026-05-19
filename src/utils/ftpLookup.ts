/**
 * FTP lookup utility for resolving the correct FTP value for a given workout date.
 * Priority: user FTP history → device FTP from file → default 200W.
 */

export interface FtpHistoryEntry {
  effectiveDate: Date;
  ftpWatts: number;
}

/**
 * Look up the FTP value to use for a given workout date.
 *
 * Priority:
 * 1. User's FTP history — find the most recent entry with effectiveDate <= workoutDate
 * 2. Device FTP from the workout file
 * 3. Default 200W
 */
export function lookupFtp(
  workoutDate: Date,
  ftpHistory?: FtpHistoryEntry[],
  deviceFtp?: number,
): number {
  // Priority 1: User's FTP history
  if (ftpHistory && ftpHistory.length > 0) {
    // Sort descending by effectiveDate to find the most recent entry <= workoutDate
    const sorted = [...ftpHistory].sort(
      (a, b) => new Date(b.effectiveDate).getTime() - new Date(a.effectiveDate).getTime(),
    );

    const entry = sorted.find(
      (e) => new Date(e.effectiveDate).getTime() <= workoutDate.getTime(),
    );

    if (entry) {
      return entry.ftpWatts;
    }
  }

  // Priority 2: Device FTP from file
  if (deviceFtp && deviceFtp > 0) {
    return deviceFtp;
  }

  // Priority 3: Default 200W
  return 200;
}
