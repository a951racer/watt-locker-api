import { DefaultParserFactory, WorkoutParser, WorkoutPrettyPrinter } from './parserFactory';
import { ParsedWorkout, WorkoutFileFormat } from '../models/workout';
import { ValidationError } from '../utils/errors';

/**
 * Creates a mock WorkoutParser that supports the given file types.
 */
function createMockParser(supportedTypes: string[]): WorkoutParser {
  return {
    parse: jest.fn().mockResolvedValue({} as ParsedWorkout),
    supports: (fileType: string) => supportedTypes.includes(fileType.toLowerCase()),
  };
}

/**
 * Creates a mock WorkoutPrettyPrinter for the given format.
 */
function createMockPrinter(format: WorkoutFileFormat): WorkoutPrettyPrinter {
  return {
    print: jest.fn().mockResolvedValue(Buffer.from('mock output')),
    outputFormat: format,
  };
}

describe('DefaultParserFactory', () => {
  let factory: DefaultParserFactory;
  let fitParser: WorkoutParser;
  let tcxParser: WorkoutParser;
  let gpxParser: WorkoutParser;
  let fitPrinter: WorkoutPrettyPrinter;
  let tcxPrinter: WorkoutPrettyPrinter;
  let gpxPrinter: WorkoutPrettyPrinter;

  beforeEach(() => {
    factory = new DefaultParserFactory();
    fitParser = createMockParser(['fit', '.fit']);
    tcxParser = createMockParser(['tcx', '.tcx']);
    gpxParser = createMockParser(['gpx', '.gpx']);
    fitPrinter = createMockPrinter('fit');
    tcxPrinter = createMockPrinter('tcx');
    gpxPrinter = createMockPrinter('gpx');

    factory.registerParser('fit', fitParser);
    factory.registerParser('tcx', tcxParser);
    factory.registerParser('gpx', gpxParser);
    factory.registerPrinter('fit', fitPrinter);
    factory.registerPrinter('tcx', tcxPrinter);
    factory.registerPrinter('gpx', gpxPrinter);
  });

  describe('getParser', () => {
    it('should return the FIT parser for ".fit" extension', () => {
      const parser = factory.getParser('.fit');
      expect(parser).toBe(fitParser);
    });

    it('should return the FIT parser for "fit" extension without dot', () => {
      const parser = factory.getParser('fit');
      expect(parser).toBe(fitParser);
    });

    it('should return the TCX parser for ".tcx" extension', () => {
      const parser = factory.getParser('.tcx');
      expect(parser).toBe(tcxParser);
    });

    it('should return the TCX parser for "tcx" extension without dot', () => {
      const parser = factory.getParser('tcx');
      expect(parser).toBe(tcxParser);
    });

    it('should return the GPX parser for ".gpx" extension', () => {
      const parser = factory.getParser('.gpx');
      expect(parser).toBe(gpxParser);
    });

    it('should return the GPX parser for "gpx" extension without dot', () => {
      const parser = factory.getParser('gpx');
      expect(parser).toBe(gpxParser);
    });

    it('should return the FIT parser for FIT MIME type', () => {
      const parser = factory.getParser('application/vnd.ant.fit');
      expect(parser).toBe(fitParser);
    });

    it('should return the FIT parser for alternative FIT MIME type', () => {
      const parser = factory.getParser('application/fit');
      expect(parser).toBe(fitParser);
    });

    it('should return the TCX parser for TCX MIME type', () => {
      const parser = factory.getParser('application/vnd.garmin.tcx+xml');
      expect(parser).toBe(tcxParser);
    });

    it('should return the TCX parser for alternative TCX MIME type', () => {
      const parser = factory.getParser('application/tcx+xml');
      expect(parser).toBe(tcxParser);
    });

    it('should return the GPX parser for GPX MIME type', () => {
      const parser = factory.getParser('application/gpx+xml');
      expect(parser).toBe(gpxParser);
    });

    it('should be case-insensitive', () => {
      expect(factory.getParser('.FIT')).toBe(fitParser);
      expect(factory.getParser('TCX')).toBe(tcxParser);
      expect(factory.getParser('.Gpx')).toBe(gpxParser);
    });

    it('should trim whitespace from file type', () => {
      expect(factory.getParser('  .fit  ')).toBe(fitParser);
      expect(factory.getParser(' tcx ')).toBe(tcxParser);
    });

    it('should throw ValidationError for unsupported format', () => {
      expect(() => factory.getParser('.csv')).toThrow(ValidationError);
    });

    it('should include supported formats in error message for unsupported format', () => {
      try {
        factory.getParser('.csv');
        fail('Expected ValidationError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        const validationError = error as ValidationError;
        expect(validationError.message).toContain('Unsupported file format');
        expect(validationError.message).toContain('.csv');
        expect(validationError.message).toContain('fit');
        expect(validationError.message).toContain('tcx');
        expect(validationError.message).toContain('gpx');
      }
    });

    it('should include supported formats in error details', () => {
      try {
        factory.getParser('.xlsx');
        fail('Expected ValidationError to be thrown');
      } catch (error) {
        const validationError = error as ValidationError;
        expect(validationError.details).toEqual({
          supportedFormats: ['fit', 'tcx', 'gpx'],
        });
      }
    });

    it('should throw ValidationError when format is recognized but no parser registered', () => {
      const emptyFactory = new DefaultParserFactory();
      expect(() => emptyFactory.getParser('.fit')).toThrow(ValidationError);
    });

    it('should throw ValidationError for empty string', () => {
      expect(() => factory.getParser('')).toThrow(ValidationError);
    });

    it('should throw ValidationError for random MIME type', () => {
      expect(() => factory.getParser('application/json')).toThrow(ValidationError);
    });
  });

  describe('getPrinter', () => {
    it('should return the FIT printer', () => {
      const printer = factory.getPrinter('fit');
      expect(printer).toBe(fitPrinter);
    });

    it('should return the TCX printer', () => {
      const printer = factory.getPrinter('tcx');
      expect(printer).toBe(tcxPrinter);
    });

    it('should return the GPX printer', () => {
      const printer = factory.getPrinter('gpx');
      expect(printer).toBe(gpxPrinter);
    });

    it('should throw ValidationError when no printer is registered for format', () => {
      const emptyFactory = new DefaultParserFactory();
      expect(() => emptyFactory.getPrinter('fit')).toThrow(ValidationError);
    });

    it('should include supported formats in printer error details', () => {
      const emptyFactory = new DefaultParserFactory();
      try {
        emptyFactory.getPrinter('fit');
        fail('Expected ValidationError to be thrown');
      } catch (error) {
        const validationError = error as ValidationError;
        expect(validationError.message).toContain('No printer registered');
        expect(validationError.details).toEqual({
          supportedFormats: ['fit', 'tcx', 'gpx'],
        });
      }
    });
  });

  describe('registerParser', () => {
    it('should allow overriding a registered parser', () => {
      const newFitParser = createMockParser(['fit']);
      factory.registerParser('fit', newFitParser);
      expect(factory.getParser('fit')).toBe(newFitParser);
    });
  });

  describe('registerPrinter', () => {
    it('should allow overriding a registered printer', () => {
      const newFitPrinter = createMockPrinter('fit');
      factory.registerPrinter('fit', newFitPrinter);
      expect(factory.getPrinter('fit')).toBe(newFitPrinter);
    });
  });

  describe('getSupportedFormats', () => {
    it('should return all supported formats', () => {
      const formats = factory.getSupportedFormats();
      expect(formats).toEqual(['fit', 'tcx', 'gpx']);
    });

    it('should return a copy (not the internal array)', () => {
      const formats = factory.getSupportedFormats();
      formats.push('fit' as WorkoutFileFormat);
      expect(factory.getSupportedFormats()).toEqual(['fit', 'tcx', 'gpx']);
    });
  });

  describe('resolveFormat', () => {
    it('should resolve .fit to fit format', () => {
      expect(factory.resolveFormat('.fit')).toBe('fit');
    });

    it('should resolve MIME types', () => {
      expect(factory.resolveFormat('application/vnd.ant.fit')).toBe('fit');
      expect(factory.resolveFormat('application/gpx+xml')).toBe('gpx');
    });

    it('should return undefined for unknown types', () => {
      expect(factory.resolveFormat('.csv')).toBeUndefined();
      expect(factory.resolveFormat('application/json')).toBeUndefined();
    });

    it('should be case-insensitive', () => {
      expect(factory.resolveFormat('.FIT')).toBe('fit');
      expect(factory.resolveFormat('APPLICATION/GPX+XML')).toBe('gpx');
    });
  });
});
