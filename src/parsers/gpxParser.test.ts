import { GpxFileParser } from './gpxParser';
import { ValidationError } from '../utils/errors';

describe('GpxFileParser', () => {
  let parser: GpxFileParser;

  beforeEach(() => {
    parser = new GpxFileParser();
  });

  describe('supports', () => {
    it('should support .gpx extension', () => {
      expect(parser.supports('.gpx')).toBe(true);
    });

    it('should support gpx extension without dot', () => {
      expect(parser.supports('gpx')).toBe(true);
    });

    it('should support GPX MIME type application/gpx+xml', () => {
      expect(parser.supports('application/gpx+xml')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(parser.supports('.GPX')).toBe(true);
      expect(parser.supports('GPX')).toBe(true);
    });

    it('should trim whitespace', () => {
      expect(parser.supports('  .gpx  ')).toBe(true);
    });

    it('should not support other formats', () => {
      expect(parser.supports('.fit')).toBe(false);
      expect(parser.supports('.tcx')).toBe(false);
      expect(parser.supports('.csv')).toBe(false);
    });
  });

  describe('parse', () => {
    const createValidGpxXml = (overrides?: {
      trackName?: string;
      trackType?: string;
      segments?: string;
    }): string => {
      const trackName = overrides?.trackName ?? 'Morning Ride';
      const trackType = overrides?.trackType ?? 'cycling';
      const segments =
        overrides?.segments ??
        `
        <trkseg>
          <trkpt lat="51.5074" lon="-0.1278">
            <ele>100</ele>
            <time>2024-01-15T10:00:00.000Z</time>
            <extensions>
              <gpxtpx:TrackPointExtension>
                <gpxtpx:hr>130</gpxtpx:hr>
                <gpxtpx:cad>90</gpxtpx:cad>
                <gpxtpx:power>200</gpxtpx:power>
                <gpxtpx:speed>8.33</gpxtpx:speed>
              </gpxtpx:TrackPointExtension>
            </extensions>
          </trkpt>
          <trkpt lat="51.508" lon="-0.126">
            <ele>105</ele>
            <time>2024-01-15T10:01:00.000Z</time>
            <extensions>
              <gpxtpx:TrackPointExtension>
                <gpxtpx:hr>135</gpxtpx:hr>
                <gpxtpx:cad>92</gpxtpx:cad>
                <gpxtpx:power>210</gpxtpx:power>
                <gpxtpx:speed>8.5</gpxtpx:speed>
              </gpxtpx:TrackPointExtension>
            </extensions>
          </trkpt>
          <trkpt lat="51.509" lon="-0.124">
            <ele>102</ele>
            <time>2024-01-15T10:02:00.000Z</time>
            <extensions>
              <gpxtpx:TrackPointExtension>
                <gpxtpx:hr>140</gpxtpx:hr>
                <gpxtpx:cad>88</gpxtpx:cad>
                <gpxtpx:power>220</gpxtpx:power>
                <gpxtpx:speed>8.7</gpxtpx:speed>
              </gpxtpx:TrackPointExtension>
            </extensions>
          </trkpt>
        </trkseg>`;

      return `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"
     creator="Garmin Edge 530">
  <trk>
    <name>${trackName}</name>
    <type>${trackType}</type>
    ${segments}
  </trk>
</gpx>`;
    };

    it('should parse a valid GPX file and return a ParsedWorkout', async () => {
      const gpxXml = createValidGpxXml();
      const result = await parser.parse(Buffer.from(gpxXml));

      expect(result.sourceFormat).toBe('gpx');
      expect(result.summary.activityType).toBe('ride');
      expect(result.summary.startTime).toEqual(new Date('2024-01-15T10:00:00.000Z'));
      expect(result.summary.endTime).toEqual(new Date('2024-01-15T10:02:00.000Z'));
      expect(result.summary.durationSeconds).toBe(120);
    });

    it('should extract data points with all available metrics', async () => {
      const gpxXml = createValidGpxXml();
      const result = await parser.parse(Buffer.from(gpxXml));

      expect(result.dataPoints).toHaveLength(3);

      const firstPoint = result.dataPoints[0];
      expect(firstPoint.timestamp).toEqual(new Date('2024-01-15T10:00:00.000Z'));
      expect(firstPoint.latitude).toBe(51.5074);
      expect(firstPoint.longitude).toBe(-0.1278);
      expect(firstPoint.elevationMeters).toBe(100);
      expect(firstPoint.heartRateBpm).toBe(130);
      expect(firstPoint.cadenceRpm).toBe(90);
      expect(firstPoint.powerWatts).toBe(200);
      expect(firstPoint.speedMps).toBe(8.33);
    });

    it('should extract lap summaries from track segments', async () => {
      const gpxXml = createValidGpxXml();
      const result = await parser.parse(Buffer.from(gpxXml));

      expect(result.summary.laps).toHaveLength(1);

      const lap = result.summary.laps![0];
      expect(lap.startTime).toEqual(new Date('2024-01-15T10:00:00.000Z'));
      expect(lap.durationSeconds).toBe(120);
      expect(lap.avgHeartRateBpm).toBe(135); // (130+135+140)/3 = 135
      expect(lap.maxHeartRateBpm).toBe(140);
      expect(lap.avgPowerWatts).toBe(210); // (200+210+220)/3 = 210
    });

    it('should handle trackpoints with partial metrics', async () => {
      const gpxXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Test Ride</name>
    <trkseg>
      <trkpt lat="51.5074" lon="-0.1278">
        <time>2024-01-15T10:00:00.000Z</time>
        <extensions>
          <TrackPointExtension>
            <hr>130</hr>
          </TrackPointExtension>
        </extensions>
      </trkpt>
      <trkpt lat="51.508" lon="-0.126">
        <ele>100</ele>
        <time>2024-01-15T10:01:00.000Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

      const result = await parser.parse(Buffer.from(gpxXml));

      expect(result.dataPoints).toHaveLength(2);
      expect(result.dataPoints[0].heartRateBpm).toBe(130);
      expect(result.dataPoints[0].elevationMeters).toBeUndefined();
      expect(result.dataPoints[1].heartRateBpm).toBeUndefined();
      expect(result.dataPoints[1].elevationMeters).toBe(100);
    });

    it('should compute elevation gain from trackpoints', async () => {
      const gpxXml = createValidGpxXml();
      const result = await parser.parse(Buffer.from(gpxXml));

      // Elevation: 100 -> 105 (+5), 105 -> 102 (0) = 5
      expect(result.summary.elevationGainMeters).toBe(5);
    });

    it('should handle direct extension elements (Garmin-style flat)', async () => {
      const gpxXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Test Ride</name>
    <trkseg>
      <trkpt lat="51.5074" lon="-0.1278">
        <ele>100</ele>
        <time>2024-01-15T10:00:00.000Z</time>
        <extensions>
          <hr>145</hr>
          <power>250</power>
          <cad>95</cad>
          <speed>9.0</speed>
        </extensions>
      </trkpt>
      <trkpt lat="51.508" lon="-0.126">
        <ele>105</ele>
        <time>2024-01-15T10:01:00.000Z</time>
        <extensions>
          <hr>150</hr>
          <power>260</power>
          <cad>97</cad>
          <speed>9.2</speed>
        </extensions>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

      const result = await parser.parse(Buffer.from(gpxXml));

      expect(result.dataPoints[0].heartRateBpm).toBe(145);
      expect(result.dataPoints[0].powerWatts).toBe(250);
      expect(result.dataPoints[0].cadenceRpm).toBe(95);
      expect(result.dataPoints[0].speedMps).toBe(9.0);
    });

    it('should handle namespaced TrackPointExtension without prefix', async () => {
      const gpxXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Test Ride</name>
    <trkseg>
      <trkpt lat="51.5074" lon="-0.1278">
        <ele>100</ele>
        <time>2024-01-15T10:00:00.000Z</time>
        <extensions>
          <TrackPointExtension>
            <hr>130</hr>
            <cad>88</cad>
            <power>200</power>
            <speed>8.0</speed>
          </TrackPointExtension>
        </extensions>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

      const result = await parser.parse(Buffer.from(gpxXml));

      expect(result.dataPoints[0].heartRateBpm).toBe(130);
      expect(result.dataPoints[0].cadenceRpm).toBe(88);
      expect(result.dataPoints[0].powerWatts).toBe(200);
      expect(result.dataPoints[0].speedMps).toBe(8.0);
    });

    it('should map cycling track type to ride activity type', async () => {
      const gpxXml = createValidGpxXml({ trackType: 'cycling' });
      const result = await parser.parse(Buffer.from(gpxXml));
      expect(result.summary.activityType).toBe('ride');
    });

    it('should map biking track type to ride activity type', async () => {
      const gpxXml = createValidGpxXml({ trackType: 'biking' });
      const result = await parser.parse(Buffer.from(gpxXml));
      expect(result.summary.activityType).toBe('ride');
    });

    it('should map running track type to run activity type', async () => {
      const gpxXml = createValidGpxXml({ trackType: 'running' });
      const result = await parser.parse(Buffer.from(gpxXml));
      expect(result.summary.activityType).toBe('run');
    });

    it('should default to ride when no track type is specified', async () => {
      const gpxXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Test Ride</name>
    <trkseg>
      <trkpt lat="51.5074" lon="-0.1278">
        <time>2024-01-15T10:00:00.000Z</time>
      </trkpt>
      <trkpt lat="51.508" lon="-0.126">
        <time>2024-01-15T10:01:00.000Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

      const result = await parser.parse(Buffer.from(gpxXml));
      expect(result.summary.activityType).toBe('ride');
    });

    it('should throw ValidationError for invalid XML', async () => {
      const invalidXml = 'this is not xml at all <<<<>>>';

      await expect(parser.parse(Buffer.from(invalidXml))).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when no gpx root element is present', async () => {
      const noGpx = `<?xml version="1.0" encoding="UTF-8"?>
<something>
  <other>data</other>
</something>`;

      await expect(parser.parse(Buffer.from(noGpx))).rejects.toThrow(ValidationError);
      await expect(parser.parse(Buffer.from(noGpx))).rejects.toThrow(/no gpx root element/);
    });

    it('should throw ValidationError when no track data is present', async () => {
      const noTracks = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1">
</gpx>`;

      await expect(parser.parse(Buffer.from(noTracks))).rejects.toThrow(ValidationError);
      await expect(parser.parse(Buffer.from(noTracks))).rejects.toThrow(/no track data/);
    });

    it('should throw ValidationError when no track points have timestamps', async () => {
      const noTimestamps = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Test</name>
    <trkseg>
      <trkpt lat="51.5074" lon="-0.1278">
        <ele>100</ele>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

      await expect(parser.parse(Buffer.from(noTimestamps))).rejects.toThrow(ValidationError);
      await expect(parser.parse(Buffer.from(noTimestamps))).rejects.toThrow(
        /no track points with timestamps/,
      );
    });

    it('should skip trackpoints without time element', async () => {
      const gpxXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Test Ride</name>
    <trkseg>
      <trkpt lat="51.5074" lon="-0.1278">
        <time>2024-01-15T10:00:00.000Z</time>
      </trkpt>
      <trkpt lat="51.508" lon="-0.126">
        <ele>100</ele>
      </trkpt>
      <trkpt lat="51.509" lon="-0.124">
        <time>2024-01-15T10:02:00.000Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

      const result = await parser.parse(Buffer.from(gpxXml));
      expect(result.dataPoints).toHaveLength(2);
    });

    it('should handle GPS coordinates from lat/lon attributes', async () => {
      const gpxXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Test Ride</name>
    <trkseg>
      <trkpt lat="48.8566" lon="2.3522">
        <time>2024-01-15T10:00:00.000Z</time>
      </trkpt>
      <trkpt lat="-33.8688" lon="151.2093">
        <time>2024-01-15T10:01:00.000Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

      const result = await parser.parse(Buffer.from(gpxXml));

      expect(result.dataPoints[0].latitude).toBe(48.8566);
      expect(result.dataPoints[0].longitude).toBe(2.3522);
      expect(result.dataPoints[1].latitude).toBe(-33.8688);
      expect(result.dataPoints[1].longitude).toBe(151.2093);
    });

    it('should set workoutId and dataSource defaults on data points', async () => {
      const gpxXml = createValidGpxXml();
      const result = await parser.parse(Buffer.from(gpxXml));

      for (const point of result.dataPoints) {
        expect(point.workoutId).toBe('');
        expect(point.dataSource).toBe('manual');
        expect(point.activityType).toBe('');
      }
    });

    it('should handle multiple track segments as separate laps', async () => {
      const gpxXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Test Ride</name>
    <type>cycling</type>
    <trkseg>
      <trkpt lat="51.5074" lon="-0.1278">
        <ele>100</ele>
        <time>2024-01-15T10:00:00.000Z</time>
        <extensions>
          <TrackPointExtension><hr>130</hr></TrackPointExtension>
        </extensions>
      </trkpt>
      <trkpt lat="51.508" lon="-0.126">
        <ele>105</ele>
        <time>2024-01-15T10:01:00.000Z</time>
        <extensions>
          <TrackPointExtension><hr>135</hr></TrackPointExtension>
        </extensions>
      </trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="51.509" lon="-0.124">
        <ele>110</ele>
        <time>2024-01-15T10:05:00.000Z</time>
        <extensions>
          <TrackPointExtension><hr>145</hr></TrackPointExtension>
        </extensions>
      </trkpt>
      <trkpt lat="51.510" lon="-0.122">
        <ele>115</ele>
        <time>2024-01-15T10:06:00.000Z</time>
        <extensions>
          <TrackPointExtension><hr>150</hr></TrackPointExtension>
        </extensions>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

      const result = await parser.parse(Buffer.from(gpxXml));

      expect(result.dataPoints).toHaveLength(4);
      expect(result.summary.laps).toHaveLength(2);

      // First segment lap
      expect(result.summary.laps![0].startTime).toEqual(new Date('2024-01-15T10:00:00.000Z'));
      expect(result.summary.laps![0].durationSeconds).toBe(60);
      expect(result.summary.laps![0].avgHeartRateBpm).toBe(133); // (130+135)/2 = 132.5 -> 133

      // Second segment lap
      expect(result.summary.laps![1].startTime).toEqual(new Date('2024-01-15T10:05:00.000Z'));
      expect(result.summary.laps![1].durationSeconds).toBe(60);
      expect(result.summary.laps![1].avgHeartRateBpm).toBe(148); // (145+150)/2 = 147.5 -> 148
    });

    it('should compute distance using Haversine formula', async () => {
      const gpxXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Test Ride</name>
    <trkseg>
      <trkpt lat="51.5074" lon="-0.1278">
        <time>2024-01-15T10:00:00.000Z</time>
      </trkpt>
      <trkpt lat="51.5080" lon="-0.1270">
        <time>2024-01-15T10:01:00.000Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

      const result = await parser.parse(Buffer.from(gpxXml));

      // Distance should be a positive number (approximately 80-90 meters for this small distance)
      expect(result.summary.distanceMeters).toBeGreaterThan(0);
      expect(result.summary.distanceMeters).toBeLessThan(200);
    });

    it('should handle a single trackpoint', async () => {
      const gpxXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Test Ride</name>
    <trkseg>
      <trkpt lat="51.5074" lon="-0.1278">
        <ele>100</ele>
        <time>2024-01-15T10:00:00.000Z</time>
        <extensions>
          <TrackPointExtension><hr>120</hr></TrackPointExtension>
        </extensions>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

      const result = await parser.parse(Buffer.from(gpxXml));

      expect(result.dataPoints).toHaveLength(1);
      expect(result.summary.durationSeconds).toBe(0);
      expect(result.summary.distanceMeters).toBe(0);
      expect(result.summary.laps).toHaveLength(1);
    });

    it('should handle elevation gain with only increasing elevations', async () => {
      const gpxXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Hill Climb</name>
    <trkseg>
      <trkpt lat="51.5074" lon="-0.1278">
        <ele>100</ele>
        <time>2024-01-15T10:00:00.000Z</time>
      </trkpt>
      <trkpt lat="51.508" lon="-0.126">
        <ele>150</ele>
        <time>2024-01-15T10:01:00.000Z</time>
      </trkpt>
      <trkpt lat="51.509" lon="-0.124">
        <ele>200</ele>
        <time>2024-01-15T10:02:00.000Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

      const result = await parser.parse(Buffer.from(gpxXml));
      expect(result.summary.elevationGainMeters).toBe(100); // 50 + 50
    });

    it('should not count descents in elevation gain', async () => {
      const gpxXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Descent</name>
    <trkseg>
      <trkpt lat="51.5074" lon="-0.1278">
        <ele>200</ele>
        <time>2024-01-15T10:00:00.000Z</time>
      </trkpt>
      <trkpt lat="51.508" lon="-0.126">
        <ele>150</ele>
        <time>2024-01-15T10:01:00.000Z</time>
      </trkpt>
      <trkpt lat="51.509" lon="-0.124">
        <ele>100</ele>
        <time>2024-01-15T10:02:00.000Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

      const result = await parser.parse(Buffer.from(gpxXml));
      expect(result.summary.elevationGainMeters).toBe(0);
    });
  });
});
