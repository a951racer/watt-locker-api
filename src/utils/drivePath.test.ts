import { deriveDriveFolderPath } from './drivePath';

describe('deriveDriveFolderPath', () => {
  it('generates correct path for a standard date', () => {
    const date = new Date('2024-06-15T10:30:00Z');
    const result = deriveDriveFolderPath(date, 'WattLocker');

    expect(result).toBe('WattLocker/2024/06');
  });

  it('zero-pads single-digit months', () => {
    const date = new Date('2024-01-05T08:00:00Z');
    const result = deriveDriveFolderPath(date, 'WattLocker');

    expect(result).toBe('WattLocker/2024/01');
  });

  it('handles December correctly', () => {
    const date = new Date('2023-12-31T23:59:59Z');
    const result = deriveDriveFolderPath(date, 'WattLocker');

    expect(result).toBe('WattLocker/2023/12');
  });

  it('handles different base paths', () => {
    const date = new Date('2024-03-10T12:00:00Z');
    const result = deriveDriveFolderPath(date, 'MyWorkouts/Cycling');

    expect(result).toBe('MyWorkouts/Cycling/2024/03');
  });

  it('handles a simple base path', () => {
    const date = new Date('2025-11-01T00:00:00Z');
    const result = deriveDriveFolderPath(date, 'Rides');

    expect(result).toBe('Rides/2025/11');
  });

  it('uses UTC to avoid timezone-dependent folder assignment', () => {
    // 2024-01-01 00:30 UTC — in UTC-5 this would still be Dec 31
    const date = new Date('2024-01-01T00:30:00Z');
    const result = deriveDriveFolderPath(date, 'WattLocker');

    expect(result).toBe('WattLocker/2024/01');
  });

  it('handles year boundaries correctly', () => {
    const date = new Date('2025-01-01T00:00:00Z');
    const result = deriveDriveFolderPath(date, 'WattLocker');

    expect(result).toBe('WattLocker/2025/01');
  });

  it('handles leap year February', () => {
    const date = new Date('2024-02-29T14:00:00Z');
    const result = deriveDriveFolderPath(date, 'WattLocker');

    expect(result).toBe('WattLocker/2024/02');
  });
});
