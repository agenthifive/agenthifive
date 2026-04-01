interface TimeWindow {
  dayOfWeek: number;
  startHour: number;
  endHour: number;
  timezone: string;
}

/**
 * Checks if the current time falls within any of the given time windows.
 * If no time windows are configured (empty array), access is always allowed.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export function checkTimeWindows(
  timeWindows: TimeWindow[],
  now?: Date,
): { allowed: true } | { allowed: false; reason: string } {
  if (timeWindows.length === 0) {
    return { allowed: true };
  }

  const currentTime = now ?? new Date();

  for (const tw of timeWindows) {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tw.timezone,
      weekday: "short",
      hour: "numeric",
      hour12: false,
    });

    const parts = formatter.formatToParts(currentTime);
    const weekdayPart = parts.find((p) => p.type === "weekday");
    const hourPart = parts.find((p) => p.type === "hour");

    if (!weekdayPart || !hourPart) continue;

    const dayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };

    const currentDay = dayMap[weekdayPart.value];
    let currentHour = parseInt(hourPart.value, 10);
    // Intl hour12:false returns 24 for midnight in some locales
    if (currentHour === 24) currentHour = 0;

    if (currentDay !== tw.dayOfWeek) continue;

    // Support overnight windows (e.g., startHour=22, endHour=6)
    if (tw.startHour <= tw.endHour) {
      // Normal window: e.g., 9-17
      if (currentHour >= tw.startHour && currentHour < tw.endHour) {
        return { allowed: true };
      }
    } else {
      // Overnight window: e.g., 22-6 (22,23,0,1,2,3,4,5)
      if (currentHour >= tw.startHour || currentHour < tw.endHour) {
        return { allowed: true };
      }
    }
  }

  // No matching window found
  const tzSet = [...new Set(timeWindows.map((tw) => tw.timezone))];
  const tzLabel = tzSet.length === 1 ? tzSet[0] : "configured timezones";
  return {
    allowed: false,
    reason: `Execution blocked: current time is outside allowed time windows (${tzLabel})`,
  };
}
