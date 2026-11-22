import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from './http.js';

export const START_DATE = '2024-10-05';
export const MAX_WINDOW_DAYS = 700; // football-data.org enforces a strict 750-day max period
export const HISTORICAL_BUFFER_DAYS = 2;
export const UNITED_TEAM_ID = 66;

export const SUPER_STALE_MS = 8 * 60 * 60 * 1000;
export const LIVE_STALE_MS = 4 * 60 * 60 * 1000;
export const PRIORITY_COOLDOWN_MS = 15 * 60 * 1000;
export const STANDARD_COOLDOWN_MS = 60 * 60 * 1000;

// football-data.org competition codes (free tier)
export const COMPETITIONS = Object.freeze([
  Object.freeze({ code: 'PL', name: 'Premier League', country: 'England', priority: true }),
  Object.freeze({ code: 'PD', name: 'La Liga', country: 'Spain', priority: true }),
  Object.freeze({ code: 'BL1', name: 'Bundesliga', country: 'Germany', priority: true }),
  Object.freeze({ code: 'SA', name: 'Serie A', country: 'Italy', priority: true }),
  Object.freeze({ code: 'FL1', name: 'Ligue 1', country: 'France', priority: true }),
  Object.freeze({ code: 'DED', name: 'Eredivisie', country: 'Netherlands', priority: false }),
  Object.freeze({ code: 'PPL', name: 'Primeira Liga', country: 'Portugal', priority: false }),
  Object.freeze({ code: 'ELC', name: 'Championship', country: 'England', priority: false }),
  Object.freeze({ code: 'CL', name: 'Champions League', country: 'Europe', priority: false }),
  Object.freeze({ code: 'EC', name: 'Euro Championship', country: 'Europe', priority: false }),
  Object.freeze({ code: 'WC', name: 'World Cup', country: 'World', priority: false }),
  Object.freeze({ code: 'BSA', name: 'Brasileirão', country: 'Brazil', priority: false }),
]);

export const COMPETITION_BY_CODE = new Map(COMPETITIONS.map((c) => [c.code, c]));

export function isPriorityCompetition(code) {
  return Boolean(COMPETITION_BY_CODE.get(code)?.priority);
}

export function getTodayDate(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().split('T')[0];
}

export function buildDateWindows(
  startDateStr,
  endDateStr,
  maxDays = MAX_WINDOW_DAYS,
  historicalBufferDays = HISTORICAL_BUFFER_DAYS
) {
  const windows = [];
  const start = new Date(`${startDateStr}T00:00:00Z`);
  const end = new Date(`${endDateStr}T00:00:00Z`);
  const dayMs = 24 * 60 * 60 * 1000;

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return windows;
  }

  let cursor = start;
  while (cursor <= end) {
    const maxEnd = new Date(cursor.getTime() + (maxDays - 1) * dayMs);
    const windowEnd = maxEnd < end ? maxEnd : end;
    const from = cursor.toISOString().split('T')[0];
    const to = windowEnd.toISOString().split('T')[0];
    const isHistorical = end.getTime() - windowEnd.getTime() >= historicalBufferDays * dayMs;

    windows.push({ from, to, isHistorical });
    cursor = new Date(windowEnd.getTime() + dayMs);
  }

  return windows;
}

export function getMatchResult(match, teamId) {
  const homeId = match?.homeTeam?.id;
  const awayId = match?.awayTeam?.id;
  const isHome = homeId === teamId;
  const isAway = awayId === teamId;

  if (!isHome && !isAway) {
    return null;
  }

  const winner = match?.score?.winner;
  if (winner === 'HOME_TEAM') {
    return isHome ? 'W' : 'L';
  }
  if (winner === 'AWAY_TEAM') {
    return isAway ? 'W' : 'L';
  }
  if (winner === 'DRAW') {
    return 'D';
  }

  const homeGoals = match?.score?.fullTime?.home;
  const awayGoals = match?.score?.fullTime?.away;
  if (
    typeof homeGoals === 'number' &&
    Number.isFinite(homeGoals) &&
    typeof awayGoals === 'number' &&
    Number.isFinite(awayGoals)
  ) {
    if (homeGoals === awayGoals) return 'D';
    if (isHome) return homeGoals > awayGoals ? 'W' : 'L';
    return awayGoals > homeGoals ? 'W' : 'L';
  }

  return null;
}

export function formatMatchScore(match) {
  const homeGoals = match?.score?.fullTime?.home;
  const awayGoals = match?.score?.fullTime?.away;
  if (
    typeof homeGoals === 'number' &&
    Number.isFinite(homeGoals) &&
    typeof awayGoals === 'number' &&
    Number.isFinite(awayGoals)
  ) {
    return `${homeGoals}-${awayGoals}`;
  }
  return null;
}

export function findFiveWinStreak(results) {
  let consecutiveWins = 0;
  let maxConsecutive = 0;
  let achievedStreak = false;
  let achievedDate = null;

  for (const r of results) {
    if (r.result === 'W') {
      consecutiveWins++;
      if (consecutiveWins >= 5 && !achievedStreak) {
        achievedStreak = true;
        achievedDate = r.date ?? null;
      }
      if (consecutiveWins > maxConsecutive) {
        maxConsecutive = consecutiveWins;
      }
    } else {
      consecutiveWins = 0;
    }
  }

  return { achievedStreak, maxConsecutive, achievedDate };
}

function normalizeDateOnly(value) {
  return typeof value === 'string' && value.length >= 10 ? value.slice(0, 10) : null;
}

export function mergeTeamRecord(existing, incoming) {
  if (!existing) {
    return { ...incoming };
  }

  const existingDate = normalizeDateOnly(existing.streak_achieved_date);
  const incomingDate = normalizeDateOnly(incoming.streak_achieved_date);
  let earliestDate = null;
  if (existingDate && incomingDate) {
    earliestDate = existingDate <= incomingDate ? existingDate : incomingDate;
  } else {
    earliestDate = existingDate || incomingDate || null;
  }

  const merged = {
    ...incoming,
    logo: incoming.logo || existing.logo || null,
    has_5_wins: Boolean(existing.has_5_wins || incoming.has_5_wins),
    max_streak: Math.max(existing.max_streak ?? 0, incoming.max_streak ?? 0),
    streak_achieved_date: earliestDate,
  };

  const firstDetected = existing.first_detected || incoming.first_detected;
  if (firstDetected) {
    merged.first_detected = firstDetected;
  }

  return merged;
}

export function selectCompetition(competitions, lastScanMap, nowMs = Date.now()) {
  const sortedCompetitions = [...competitions].sort((a, b) => {
    const aTime = lastScanMap.get(a.code);
    const bTime = lastScanMap.get(b.code);

    if (!aTime && bTime) return -1;
    if (aTime && !bTime) return 1;
    if (!aTime && !bTime) return 0;

    const aDiff = nowMs - aTime.getTime();
    const bDiff = nowMs - bTime.getTime();

    const aSuperStale = aDiff > SUPER_STALE_MS;
    const bSuperStale = bDiff > SUPER_STALE_MS;
    if (aSuperStale && !bSuperStale) return -1;
    if (bSuperStale && !aSuperStale) return 1;

    const aIsPriority = isPriorityCompetition(a.code);
    const bIsPriority = isPriorityCompetition(b.code);
    const aLiveStale = aDiff > LIVE_STALE_MS;
    const bLiveStale = bDiff > LIVE_STALE_MS;

    if (aIsPriority && aLiveStale && (!bIsPriority || !bLiveStale)) return -1;
    if (bIsPriority && bLiveStale && (!aIsPriority || !aLiveStale)) return 1;

    return aTime.getTime() - bTime.getTime();
  });

  const getCooldownMs = (code) =>
    isPriorityCompetition(code) ? PRIORITY_COOLDOWN_MS : STANDARD_COOLDOWN_MS;

  const eligible = sortedCompetitions.filter((comp) => {
    const lastScan = lastScanMap.get(comp.code);
    if (!lastScan) return true;
    return nowMs - lastScan.getTime() >= getCooldownMs(comp.code);
  });

  let nextScanSeconds = 0;
  if (eligible.length === 0) {
    let minRemainingMs = Infinity;
    for (const comp of competitions) {
      const lastScan = lastScanMap.get(comp.code);
      if (!lastScan) {
        minRemainingMs = 0;
        break;
      }
      const remaining = getCooldownMs(comp.code) - (nowMs - lastScan.getTime());
      if (remaining < minRemainingMs) {
        minRemainingMs = remaining;
      }
    }
    nextScanSeconds = Math.max(1, Math.ceil(minRemainingMs / 1000));
  }

  return { sortedCompetitions, eligible, nextScanSeconds };
}

export function countUncachedWindows(compCode, today, cache) {
  const windows = buildDateWindows(START_DATE, today);
  let needed = 0;
  for (const win of windows) {
    const cacheKey = `${compCode}:${win.from}:${win.to}`;
    if (!(win.isHistorical && cache?.has(cacheKey))) {
      needed++;
    }
  }
  return needed;
}

export async function fetchCompetitionMatches(
  compCode,
  apiKey,
  today,
  {
    cache = null,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    deadlineMs = null,
    now = () => Date.now(),
  } = {}
) {
  const windows = buildDateWindows(START_DATE, today);
  const matchMap = new Map();
  let competitionInfo = {};
  let requestsMade = 0;

  for (const win of windows) {
    const cacheKey = `${compCode}:${win.from}:${win.to}`;
    if (win.isHistorical && cache?.has(cacheKey)) {
      const cached = cache.get(cacheKey);
      if (cached.competition) competitionInfo = cached.competition;
      for (const m of cached.matches) {
        matchMap.set(m.id, m);
      }
      continue;
    }

    let windowTimeoutMs = timeoutMs;
    if (typeof deadlineMs === 'number' && Number.isFinite(deadlineMs)) {
      const remainingMs = deadlineMs - now();
      if (remainingMs <= 0) {
        return {
          ok: false,
          status: 503,
          errorText: 'Request deadline exceeded',
          requestsMade,
        };
      }
      windowTimeoutMs = Math.min(timeoutMs, remainingMs);
    }

    requestsMade++;
    try {
      const response = await fetchWithTimeout(
        `https://api.football-data.org/v4/competitions/${compCode}/matches?dateFrom=${win.from}&dateTo=${win.to}&status=FINISHED`,
        {
          headers: {
            'X-Auth-Token': apiKey,
          },
        },
        windowTimeoutMs,
        fetchImpl
      );

      if (!response.ok) {
        const errorText = typeof response.text === 'function' ? await response.text() : '';
        return {
          ok: false,
          status: response.status,
          errorText,
          requestsMade,
        };
      }

      const data = await response.json();
      if (
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        (data.matches !== undefined && !Array.isArray(data.matches))
      ) {
        return {
          ok: false,
          status: 502,
          errorText: 'Invalid JSON payload from football-data.org',
          requestsMade,
        };
      }

      const windowMatches = data.matches || [];
      for (const m of windowMatches) {
        if (!m || typeof m !== 'object' || Array.isArray(m) || m.id === undefined || m.id === null) {
          return {
            ok: false,
            status: 502,
            errorText: 'Invalid match entry in football-data.org payload',
            requestsMade,
          };
        }
      }

      if (data.competition && typeof data.competition === 'object' && !Array.isArray(data.competition)) {
        competitionInfo = data.competition;
      }

      for (const m of windowMatches) {
        matchMap.set(m.id, m);
      }

      if (win.isHistorical && cache) {
        cache.set(cacheKey, {
          competition: competitionInfo,
          matches: windowMatches,
        });
      }
    } catch (error) {
      return {
        ok: false,
        status: 503,
        errorText: error instanceof Error ? error.message : String(error),
        requestsMade,
      };
    }
  }

  return {
    ok: true,
    competition: competitionInfo,
    matches: Array.from(matchMap.values()),
    requestsMade,
  };
}
