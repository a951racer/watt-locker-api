/**
 * Archive extraction utility.
 * Supports .zip, .gz, and nested archives (e.g., .zip containing .gpx.gz files).
 * Recursively extracts until only workout files remain.
 */

import AdmZip from 'adm-zip';
import { gunzipSync } from 'zlib';

/** Supported workout file extensions */
const WORKOUT_EXTENSIONS = ['.fit', '.gpx', '.tcx'];

/** Archive extensions we can extract */
const ARCHIVE_EXTENSIONS = ['.zip', '.gz', '.tar.gz', '.tgz'];

export interface ExtractedFile {
  buffer: Buffer;
  fileName: string;
}

/**
 * Check if a filename is a supported workout file.
 */
function isWorkoutFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return WORKOUT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Check if a filename is an archive that can be extracted.
 */
function isArchiveFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Check if a filename is a gzip-compressed file (but not tar.gz).
 */
function isGzipFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.endsWith('.gz') && !lower.endsWith('.tar.gz');
}

/**
 * Check if a filename is a zip archive.
 */
function isZipFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.zip');
}

/**
 * Get the filename without the .gz extension.
 */
function stripGzExtension(fileName: string): string {
  if (fileName.toLowerCase().endsWith('.gz')) {
    return fileName.slice(0, -3);
  }
  return fileName;
}

/**
 * Extract workout files from an archive buffer.
 * Recursively handles nested archives (e.g., .zip containing .gpx.gz files).
 * Returns only files with supported workout extensions.
 */
export function extractArchive(buffer: Buffer, fileName: string): ExtractedFile[] {
  const results: ExtractedFile[] = [];

  if (isZipFile(fileName)) {
    extractZip(buffer, results);
  } else if (isGzipFile(fileName)) {
    extractGzip(buffer, fileName, results);
  } else {
    // Not an archive — return as-is if it's a workout file
    if (isWorkoutFile(fileName)) {
      results.push({ buffer, fileName });
    }
  }

  return results;
}

/**
 * Extract files from a ZIP archive, recursively processing nested archives.
 */
function extractZip(buffer: Buffer, results: ExtractedFile[]): void {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const entryName = entry.entryName;
    // Use just the filename (strip directory path)
    const baseName = entryName.split('/').pop() || entryName;
    const entryBuffer = entry.getData();

    if (isArchiveFile(baseName)) {
      // Recursively extract nested archives
      const nested = extractArchive(entryBuffer, baseName);
      results.push(...nested);
    } else if (isWorkoutFile(baseName)) {
      results.push({ buffer: entryBuffer, fileName: baseName });
    }
    // Skip non-workout, non-archive files
  }
}

/**
 * Decompress a gzip file and process the result.
 */
function extractGzip(buffer: Buffer, fileName: string, results: ExtractedFile[]): void {
  try {
    const decompressed = gunzipSync(buffer);
    const innerName = stripGzExtension(fileName);

    if (isArchiveFile(innerName)) {
      // Nested archive (unlikely but handle it)
      const nested = extractArchive(decompressed, innerName);
      results.push(...nested);
    } else if (isWorkoutFile(innerName)) {
      results.push({ buffer: decompressed, fileName: innerName });
    }
  } catch {
    // Failed to decompress — skip this file
  }
}

/**
 * Check if a file is an archive that should be extracted before processing.
 */
export function shouldExtractArchive(fileName: string): boolean {
  return isArchiveFile(fileName);
}
