/**
 * Compute max average power for given durations using a sliding window.
 * @param powerData - array of power values at 1-second intervals
 * @param durations - array of duration windows in seconds
 * @returns Record<string, number> - key=duration, value=max avg watts
 */
export function computeMaxPowers(
  powerData: number[],
  durations: number[] = [1, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 10800, 14400, 18000],
): Record<string, number> {
  const result: Record<string, number> = {};

  for (const duration of durations) {
    if (powerData.length < duration) continue;

    // Sliding window
    let windowSum = 0;
    for (let i = 0; i < duration; i++) {
      windowSum += powerData[i];
    }
    let maxAvg = windowSum / duration;

    for (let i = duration; i < powerData.length; i++) {
      windowSum += powerData[i] - powerData[i - duration];
      const avg = windowSum / duration;
      if (avg > maxAvg) maxAvg = avg;
    }

    result[String(duration)] = Math.round(maxAvg);
  }

  return result;
}
