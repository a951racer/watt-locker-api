import { ParsedWorkout, WorkoutFileFormat } from '../models/workout';
import { ValidationError } from '../utils/errors';

/**
 * Interface for format-specific workout file parsers.
 */
export interface WorkoutParser {
  /** Parse raw file buffer into structured workout data */
  parse(buffer: Buffer): Promise<ParsedWorkout>;

  /** Check if this parser supports the given file extension or MIME type */
  supports(fileType: string): boolean;
}

/**
 * Interface for formatting parsed workouts back into file representations.
 */
export interface WorkoutPrettyPrinter {
  /** Format a parsed workout back into file representation */
  print(workout: ParsedWorkout): Promise<Buffer>;

  /** The output format this printer produces */
  outputFormat: WorkoutFileFormat;
}

/**
 * Factory for obtaining the correct parser or printer for a given file type/format.
 */
export interface ParserFactory {
  /** Get appropriate parser for the given file type (extension or MIME type) */
  getParser(fileType: string): WorkoutParser;

  /** Get pretty printer for the given format */
  getPrinter(format: WorkoutFileFormat): WorkoutPrettyPrinter;
}

/** Mapping of file extensions and MIME types to WorkoutFileFormat */
const FILE_TYPE_MAP: Record<string, WorkoutFileFormat> = {
  // Extensions
  '.fit': 'fit',
  fit: 'fit',
  '.tcx': 'tcx',
  tcx: 'tcx',
  '.gpx': 'gpx',
  gpx: 'gpx',
  // MIME types
  'application/vnd.ant.fit': 'fit',
  'application/fit': 'fit',
  'application/vnd.garmin.tcx+xml': 'tcx',
  'application/tcx+xml': 'tcx',
  'application/gpx+xml': 'gpx',
};

const SUPPORTED_FORMATS: WorkoutFileFormat[] = ['fit', 'tcx', 'gpx'];

/**
 * Default implementation of ParserFactory.
 * Parsers and printers are registered by format and resolved by file extension or MIME type.
 */
export class DefaultParserFactory implements ParserFactory {
  private parsers: Map<WorkoutFileFormat, WorkoutParser> = new Map();
  private printers: Map<WorkoutFileFormat, WorkoutPrettyPrinter> = new Map();

  /**
   * Register a parser for a specific workout file format.
   */
  registerParser(format: WorkoutFileFormat, parser: WorkoutParser): void {
    this.parsers.set(format, parser);
  }

  /**
   * Register a pretty printer for a specific workout file format.
   */
  registerPrinter(format: WorkoutFileFormat, printer: WorkoutPrettyPrinter): void {
    this.printers.set(format, printer);
  }

  /**
   * Get the appropriate parser for the given file type.
   * Accepts file extensions (with or without dot) and MIME types.
   *
   * @throws ValidationError if the file type is not supported
   */
  getParser(fileType: string): WorkoutParser {
    const normalizedType = fileType.trim().toLowerCase();
    const format = FILE_TYPE_MAP[normalizedType];

    if (!format) {
      throw new ValidationError(
        `Unsupported file format: "${fileType}". Supported formats: ${SUPPORTED_FORMATS.join(', ')}`,
        {
          field: 'fileType',
          details: { supportedFormats: SUPPORTED_FORMATS },
        },
      );
    }

    const parser = this.parsers.get(format);
    if (!parser) {
      throw new ValidationError(
        `No parser registered for format: "${format}". Supported formats: ${SUPPORTED_FORMATS.join(', ')}`,
        {
          field: 'fileType',
          details: { supportedFormats: SUPPORTED_FORMATS },
        },
      );
    }

    return parser;
  }

  /**
   * Get the pretty printer for the given output format.
   *
   * @throws ValidationError if no printer is registered for the format
   */
  getPrinter(format: WorkoutFileFormat): WorkoutPrettyPrinter {
    const printer = this.printers.get(format);
    if (!printer) {
      throw new ValidationError(
        `No printer registered for format: "${format}". Supported formats: ${SUPPORTED_FORMATS.join(', ')}`,
        {
          field: 'format',
          details: { supportedFormats: SUPPORTED_FORMATS },
        },
      );
    }

    return printer;
  }

  /**
   * Returns the list of supported file formats.
   */
  getSupportedFormats(): WorkoutFileFormat[] {
    return [...SUPPORTED_FORMATS];
  }

  /**
   * Resolve a file type string (extension or MIME type) to a WorkoutFileFormat.
   * Returns undefined if the type is not recognized.
   */
  resolveFormat(fileType: string): WorkoutFileFormat | undefined {
    const normalizedType = fileType.trim().toLowerCase();
    return FILE_TYPE_MAP[normalizedType];
  }
}
