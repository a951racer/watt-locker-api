import { TcxFileParser } from './tcxParser';
import { ValidationError } from '../utils/errors';

describe('TcxFileParser', () => {
  let parser: TcxFileParser;

  beforeEach(() => {
    parser = new TcxFileParser();
  });

  describe('supports', () => {
    it('should support .tcx extension', () => {
      expect(parser.supports('.tcx')).toBe(true);
    });

    it('should support tcx extension without dot', () => {
      expect(parser.supports('tcx')).toBe(true);
    });

    it('should support TCX MIME type application/vnd.garmin.tcx+xml', () => {
      expect(parser.supports('application/vnd.garmin.tcx+xml')).toBe(true);
    });

    it('should support TCX MIME type application/tcx+xml', () => {
      expect(parser.supports('application/tcx+xml')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(parser.supports('.TCX')).toBe(true);
      expect(parser.supports('TCX')).toBe(true);
    });

    it('should trim whitespace', () => {
      expect(parser.supports('  .tcx  ')).toBe(true);
    });

    it('should not support other formats', () => {
      expect(parser.supports('.fit')).toBe(false);
      expect(parser.supports('.gpx')).toBe(false);
      expect(parser.supports('.csv')).toBe(false);
    });
  });

  describe('parse', () => {
    const createValidTcxXml = (overrides?: {
      sport?: string;
      laps?: string;
      activityId?: string;
    }): string => {
      const sport = overrides?.sport ?? 'Biking';
      const activityId = overrides?.activityId ?? '2024-01-15T10:00:00.000Z';
      const laps =
        overrides?.laps ??
        `
        <Lap StartTime="2024-01-15T10:00:00.000Z">
          <TotalTimeSeconds>1800</TotalTimeSeconds>
          <DistanceMeters>15000</DistanceMeters>
          <MaximumSpeed>12.5</MaximumSpeed>
          <Calories>450</Calories>
          <AverageHeartRateBpm><Value>140</Value></AverageHeartRateBpm>
          <MaximumHeartRateBpm><Value>165</Value></MaximumHeartRateBpm>
          <Cadence>88</Cadence>
          <Track>
            <Trackpoint>
              <Time>2024-01-15T10:00:00.000Z</Time>
              <Position>
                <LatitudeDegrees>51.5074</LatitudeDegrees>
                <LongitudeDegrees>-0.1278</LongitudeDegrees>
              </Position>
              <AltitudeMeters>100</AltitudeMeters>
              <DistanceMeters>0</DistanceMeters>
              <HeartRateBpm><Value>130</Value></HeartRateBpm>
              <Cadence>90</Cadence>
              <Extensions>
                <TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
                  <Watts>200</Watts>
                  <Speed>8.33</Speed>
                </TPX>
              </Extensions>
            </Trackpoint>
            <Trackpoint>
              <Time>2024-01-15T10:01:00.000Z</Time>
              <Position>
                <LatitudeDegrees>51.508</LatitudeDegrees>
                <LongitudeDegrees>-0.126</LongitudeDegrees>
              </Position>
              <AltitudeMeters>105</AltitudeMeters>
              <DistanceMeters>500</DistanceMeters>
              <HeartRateBpm><Value>135</Value></HeartRateBpm>
              <Cadence>92</Cadence>
              <Extensions>
                <TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
                  <Watts>210</Watts>
                  <Speed>8.5</Speed>
                </TPX>
              </Extensions>
            </Trackpoint>
            <Trackpoint>
              <Time>2024-01-15T10:02:00.000Z</Time>
              <Position>
                <LatitudeDegrees>51.509</LatitudeDegrees>
                <LongitudeDegrees>-0.124</LongitudeDegrees>
              </Position>
              <AltitudeMeters>102</AltitudeMeters>
              <DistanceMeters>1020</DistanceMeters>
              <HeartRateBpm><Value>140</Value></HeartRateBpm>
              <Cadence>88</Cadence>
              <Extensions>
                <TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
                  <Watts>220</Watts>
                  <Speed>8.7</Speed>
                </TPX>
              </Extensions>
            </Trackpoint>
          </Track>
        </Lap>
        <Lap StartTime="2024-01-15T10:30:00.000Z">
          <TotalTimeSeconds>1800</TotalTimeSeconds>
          <DistanceMeters>15000</DistanceMeters>
          <MaximumSpeed>13.0</MaximumSpeed>
          <Calories>480</Calories>
          <AverageHeartRateBpm><Value>145</Value></AverageHeartRateBpm>
          <MaximumHeartRateBpm><Value>170</Value></MaximumHeartRateBpm>
          <Cadence>90</Cadence>
          <Track>
            <Trackpoint>
              <Time>2024-01-15T10:30:00.000Z</Time>
              <Position>
                <LatitudeDegrees>51.510</LatitudeDegrees>
                <LongitudeDegrees>-0.122</LongitudeDegrees>
              </Position>
              <AltitudeMeters>110</AltitudeMeters>
              <DistanceMeters>15000</DistanceMeters>
              <HeartRateBpm><Value>145</Value></HeartRateBpm>
              <Cadence>90</Cadence>
            </Trackpoint>
          </Track>
        </Lap>`;

      return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="${sport}">
      <Id>${activityId}</Id>
      ${laps}
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;
    };

    it('should parse a valid TCX file and return a ParsedWorkout', async () => {
      const tcxXml = createValidTcxXml();
      const result = await parser.parse(Buffer.from(tcxXml));

      expect(result.sourceFormat).toBe('tcx');
      expect(result.summary.activityType).toBe('ride');
      expect(result.summary.startTime).toEqual(new Date('2024-01-15T10:00:00.000Z'));
      expect(result.summary.durationSeconds).toBe(3600); // 1800 + 1800
      expect(result.summary.distanceMeters).toBe(30000); // 15000 + 15000
    });

    it('should extract data points with all available metrics', async () => {
      const tcxXml = createValidTcxXml();
      const result = await parser.parse(Buffer.from(tcxXml));

      // 3 trackpoints in first lap + 1 in second lap = 4
      expect(result.dataPoints).toHaveLength(4);

      const firstPoint = result.dataPoints[0];
      expect(firstPoint.timestamp).toEqual(new Date('2024-01-15T10:00:00.000Z'));
      expect(firstPoint.heartRateBpm).toBe(130);
      expect(firstPoint.cadenceRpm).toBe(90);
      expect(firstPoint.distanceMeters).toBe(0);
      expect(firstPoint.elevationMeters).toBe(100);
      expect(firstPoint.latitude).toBe(51.5074);
      expect(firstPoint.longitude).toBe(-0.1278);
      expect(firstPoint.powerWatts).toBe(200);
      expect(firstPoint.speedMps).toBe(8.33);
    });

    it('should extract lap summaries', async () => {
      const tcxXml = createValidTcxXml();
      const result = await parser.parse(Buffer.from(tcxXml));

      expect(result.summary.laps).toHaveLength(2);

      const firstLap = result.summary.laps![0];
      expect(firstLap.startTime).toEqual(new Date('2024-01-15T10:00:00.000Z'));
      expect(firstLap.durationSeconds).toBe(1800);
      expect(firstLap.distanceMeters).toBe(15000);
      expect(firstLap.avgHeartRateBpm).toBe(140);
      expect(firstLap.maxHeartRateBpm).toBe(165);

      const secondLap = result.summary.laps![1];
      expect(secondLap.startTime).toEqual(new Date('2024-01-15T10:30:00.000Z'));
      expect(secondLap.durationSeconds).toBe(1800);
      expect(secondLap.distanceMeters).toBe(15000);
      expect(secondLap.avgHeartRateBpm).toBe(145);
      expect(secondLap.maxHeartRateBpm).toBe(170);
    });

    it('should handle trackpoints with partial metrics', async () => {
      const tcxXml = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>2024-01-15T10:00:00.000Z</Id>
      <Lap StartTime="2024-01-15T10:00:00.000Z">
        <TotalTimeSeconds>120</TotalTimeSeconds>
        <DistanceMeters>1000</DistanceMeters>
        <Track>
          <Trackpoint>
            <Time>2024-01-15T10:00:00.000Z</Time>
            <HeartRateBpm><Value>130</Value></HeartRateBpm>
          </Trackpoint>
          <Trackpoint>
            <Time>2024-01-15T10:01:00.000Z</Time>
            <AltitudeMeters>100</AltitudeMeters>
          </Trackpoint>
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;

      const result = await parser.parse(Buffer.from(tcxXml));

      expect(result.dataPoints).toHaveLength(2);
      expect(result.dataPoints[0].heartRateBpm).toBe(130);
      expect(result.dataPoints[0].elevationMeters).toBeUndefined();
      expect(result.dataPoints[1].heartRateBpm).toBeUndefined();
      expect(result.dataPoints[1].elevationMeters).toBe(100);
    });

    it('should compute elevation gain from trackpoints', async () => {
      const tcxXml = createValidTcxXml();
      const result = await parser.parse(Buffer.from(tcxXml));

      // Elevation: 100 -> 105 (+5), 105 -> 102 (0), 102 -> 110 (+8) = 13
      expect(result.summary.elevationGainMeters).toBe(13);
    });

    it('should map Biking sport to ride activity type', async () => {
      const tcxXml = createValidTcxXml({ sport: 'Biking' });
      const result = await parser.parse(Buffer.from(tcxXml));
      expect(result.summary.activityType).toBe('ride');
    });

    it('should map Running sport to run activity type', async () => {
      const tcxXml = createValidTcxXml({ sport: 'Running' });
      const result = await parser.parse(Buffer.from(tcxXml));
      expect(result.summary.activityType).toBe('run');
    });

    it('should map Other sport to other activity type', async () => {
      const tcxXml = createValidTcxXml({ sport: 'Other' });
      const result = await parser.parse(Buffer.from(tcxXml));
      expect(result.summary.activityType).toBe('other');
    });

    it('should default to ride when no sport is specified', async () => {
      const tcxXml = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity>
      <Id>2024-01-15T10:00:00.000Z</Id>
      <Lap StartTime="2024-01-15T10:00:00.000Z">
        <TotalTimeSeconds>60</TotalTimeSeconds>
        <DistanceMeters>500</DistanceMeters>
        <Track>
          <Trackpoint>
            <Time>2024-01-15T10:00:00.000Z</Time>
          </Trackpoint>
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;

      const result = await parser.parse(Buffer.from(tcxXml));
      expect(result.summary.activityType).toBe('ride');
    });

    it('should throw ValidationError for invalid XML', async () => {
      const invalidXml = 'this is not xml at all <<<<>>>';

      await expect(parser.parse(Buffer.from(invalidXml))).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when no activity data is present', async () => {
      const emptyTcx = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
  </Activities>
</TrainingCenterDatabase>`;

      await expect(parser.parse(Buffer.from(emptyTcx))).rejects.toThrow(ValidationError);
      await expect(parser.parse(Buffer.from(emptyTcx))).rejects.toThrow(/no activity data/);
    });

    it('should throw ValidationError when no laps are present', async () => {
      const noLapsTcx = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>2024-01-15T10:00:00.000Z</Id>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;

      await expect(parser.parse(Buffer.from(noLapsTcx))).rejects.toThrow(ValidationError);
      await expect(parser.parse(Buffer.from(noLapsTcx))).rejects.toThrow(/no lap data/);
    });

    it('should skip trackpoints without Time element', async () => {
      const tcxXml = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>2024-01-15T10:00:00.000Z</Id>
      <Lap StartTime="2024-01-15T10:00:00.000Z">
        <TotalTimeSeconds>120</TotalTimeSeconds>
        <DistanceMeters>1000</DistanceMeters>
        <Track>
          <Trackpoint>
            <Time>2024-01-15T10:00:00.000Z</Time>
            <HeartRateBpm><Value>130</Value></HeartRateBpm>
          </Trackpoint>
          <Trackpoint>
            <HeartRateBpm><Value>135</Value></HeartRateBpm>
          </Trackpoint>
          <Trackpoint>
            <Time>2024-01-15T10:02:00.000Z</Time>
            <HeartRateBpm><Value>140</Value></HeartRateBpm>
          </Trackpoint>
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;

      const result = await parser.parse(Buffer.from(tcxXml));
      expect(result.dataPoints).toHaveLength(2);
    });

    it('should handle GPS coordinates only when both lat and long are present', async () => {
      const tcxXml = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>2024-01-15T10:00:00.000Z</Id>
      <Lap StartTime="2024-01-15T10:00:00.000Z">
        <TotalTimeSeconds>120</TotalTimeSeconds>
        <DistanceMeters>1000</DistanceMeters>
        <Track>
          <Trackpoint>
            <Time>2024-01-15T10:00:00.000Z</Time>
            <Position>
              <LatitudeDegrees>51.5074</LatitudeDegrees>
            </Position>
          </Trackpoint>
          <Trackpoint>
            <Time>2024-01-15T10:01:00.000Z</Time>
            <Position>
              <LatitudeDegrees>51.508</LatitudeDegrees>
              <LongitudeDegrees>-0.126</LongitudeDegrees>
            </Position>
          </Trackpoint>
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;

      const result = await parser.parse(Buffer.from(tcxXml));

      expect(result.dataPoints[0].latitude).toBeUndefined();
      expect(result.dataPoints[0].longitude).toBeUndefined();
      expect(result.dataPoints[1].latitude).toBe(51.508);
      expect(result.dataPoints[1].longitude).toBe(-0.126);
    });

    it('should set workoutId and dataSource defaults on data points', async () => {
      const tcxXml = createValidTcxXml();
      const result = await parser.parse(Buffer.from(tcxXml));

      for (const point of result.dataPoints) {
        expect(point.workoutId).toBe('');
        expect(point.dataSource).toBe('manual');
        expect(point.activityType).toBe('');
      }
    });

    it('should extract power from namespaced TPX extensions', async () => {
      const tcxXml = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>2024-01-15T10:00:00.000Z</Id>
      <Lap StartTime="2024-01-15T10:00:00.000Z">
        <TotalTimeSeconds>60</TotalTimeSeconds>
        <DistanceMeters>500</DistanceMeters>
        <Track>
          <Trackpoint>
            <Time>2024-01-15T10:00:00.000Z</Time>
            <Extensions>
              <ns3:TPX>
                <ns3:Watts>250</ns3:Watts>
                <ns3:Speed>9.2</ns3:Speed>
              </ns3:TPX>
            </Extensions>
          </Trackpoint>
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;

      const result = await parser.parse(Buffer.from(tcxXml));

      expect(result.dataPoints[0].powerWatts).toBe(250);
      expect(result.dataPoints[0].speedMps).toBe(9.2);
    });

    it('should extract average power from lap extensions', async () => {
      const tcxXml = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>2024-01-15T10:00:00.000Z</Id>
      <Lap StartTime="2024-01-15T10:00:00.000Z">
        <TotalTimeSeconds>1800</TotalTimeSeconds>
        <DistanceMeters>15000</DistanceMeters>
        <AverageHeartRateBpm><Value>140</Value></AverageHeartRateBpm>
        <MaximumHeartRateBpm><Value>165</Value></MaximumHeartRateBpm>
        <Extensions>
          <LX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
            <AvgWatts>205</AvgWatts>
          </LX>
        </Extensions>
        <Track>
          <Trackpoint>
            <Time>2024-01-15T10:00:00.000Z</Time>
          </Trackpoint>
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;

      const result = await parser.parse(Buffer.from(tcxXml));

      expect(result.summary.laps![0].avgPowerWatts).toBe(205);
    });

    it('should handle laps without optional heart rate fields', async () => {
      const tcxXml = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>2024-01-15T10:00:00.000Z</Id>
      <Lap StartTime="2024-01-15T10:00:00.000Z">
        <TotalTimeSeconds>1800</TotalTimeSeconds>
        <DistanceMeters>15000</DistanceMeters>
        <Track>
          <Trackpoint>
            <Time>2024-01-15T10:00:00.000Z</Time>
          </Trackpoint>
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;

      const result = await parser.parse(Buffer.from(tcxXml));

      expect(result.summary.laps).toHaveLength(1);
      expect(result.summary.laps![0].avgHeartRateBpm).toBeUndefined();
      expect(result.summary.laps![0].maxHeartRateBpm).toBeUndefined();
      expect(result.summary.laps![0].avgPowerWatts).toBeUndefined();
    });

    it('should compute end time from start time plus total duration', async () => {
      const tcxXml = createValidTcxXml();
      const result = await parser.parse(Buffer.from(tcxXml));

      const expectedEnd = new Date(
        new Date('2024-01-15T10:00:00.000Z').getTime() + 3600 * 1000,
      );
      expect(result.summary.endTime).toEqual(expectedEnd);
    });

    it('should handle a single lap with a single trackpoint', async () => {
      const tcxXml = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>2024-01-15T10:00:00.000Z</Id>
      <Lap StartTime="2024-01-15T10:00:00.000Z">
        <TotalTimeSeconds>60</TotalTimeSeconds>
        <DistanceMeters>500</DistanceMeters>
        <Track>
          <Trackpoint>
            <Time>2024-01-15T10:00:00.000Z</Time>
            <HeartRateBpm><Value>120</Value></HeartRateBpm>
          </Trackpoint>
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;

      const result = await parser.parse(Buffer.from(tcxXml));

      expect(result.dataPoints).toHaveLength(1);
      expect(result.summary.durationSeconds).toBe(60);
      expect(result.summary.distanceMeters).toBe(500);
      expect(result.summary.laps).toHaveLength(1);
    });
  });
});
