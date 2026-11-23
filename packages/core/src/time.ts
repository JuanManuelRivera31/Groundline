const PACIFIC_TIME_ZONE = 'America/Los_Angeles';
const HOUR_MS = 3_600_000;
const DAY_SECONDS = 86_400;

const wallClock = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TIME_ZONE,
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Seconds elapsed since local midnight on the Pacific wall clock. */
function pacificWallSeconds(ms: number): number {
  let seconds = 0;
  for (const part of wallClock.formatToParts(new Date(ms))) {
    if (part.type === 'hour') seconds += Number(part.value) * 3600;
    else if (part.type === 'minute') seconds += Number(part.value) * 60;
    else if (part.type === 'second') seconds += Number(part.value);
  }
  return seconds;
}

/**
 * Epoch ms of the most recent midnight in America/Los_Angeles.
 * Gemini API requests-per-day quotas reset at midnight Pacific time.
 */
export function pacificDayStart(ms: number): number {
  let candidate = ms - (((ms % 1000) + 1000) % 1000) - pacificWallSeconds(ms) * 1000;
  // On DST transition days wall-clock time and elapsed time differ by one hour;
  // nudge the candidate until it lands exactly on local midnight.
  for (let i = 0; i < 3; i++) {
    const wall = pacificWallSeconds(candidate);
    if (wall === 0) return candidate;
    candidate -= (wall >= DAY_SECONDS / 2 ? wall - DAY_SECONDS : wall) * 1000;
  }
  return candidate;
}

/** Epoch ms of the next midnight in America/Los_Angeles (days are 23-25 h long). */
export function nextPacificDayStart(ms: number): number {
  return pacificDayStart(pacificDayStart(ms) + 25 * HOUR_MS);
}
