import {
  START_DATE,
  UNITED_TEAM_ID,
  buildDateWindows,
  formatMatchScore,
  getMatchResult,
  getTodayDate,
} from './_lib/football.js';
import {
  fetchWithTimeout,
  handlePreflightAndMethod,
  setNoStore,
  setPublicCache,
} from './_lib/http.js';

async function fetchUnitedMatches(
  apiKey,
  today,
  { cache, fetchImpl, timeoutMs = 6000, deadlineMs = null, now = () => Date.now() }
) {
  const windows = buildDateWindows(START_DATE, today);
  const matchMap = new Map();

  for (const win of windows) {
    const cacheKey = `${UNITED_TEAM_ID}:${win.from}:${win.to}`;
    if (win.isHistorical && cache.has(cacheKey)) {
      for (const m of cache.get(cacheKey)) {
        matchMap.set(m.id, m);
      }
      continue;
    }

    let windowTimeoutMs = timeoutMs;
    if (typeof deadlineMs === 'number' && Number.isFinite(deadlineMs)) {
      const remainingMs = deadlineMs - now();
      if (remainingMs <= 0) {
        const timeoutError = new Error('Request deadline exceeded');
        timeoutError.name = 'AbortError';
        throw timeoutError;
      }
      windowTimeoutMs = Math.min(timeoutMs, remainingMs);
    }

    const response = await fetchWithTimeout(
      `https://api.football-data.org/v4/teams/${UNITED_TEAM_ID}/matches?status=FINISHED&dateFrom=${win.from}&dateTo=${win.to}`,
      {
        headers: { 'X-Auth-Token': apiKey },
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
      };
    }

    const windowMatches = data.matches || [];
    for (const m of windowMatches) {
      if (!m || typeof m !== 'object' || Array.isArray(m) || m.id === undefined || m.id === null) {
        return {
          ok: false,
          status: 502,
          errorText: 'Invalid match entry in football-data.org payload',
        };
      }
    }

    for (const m of windowMatches) {
      matchMap.set(m.id, m);
    }

    if (win.isHistorical && cache) {
      cache.set(cacheKey, windowMatches);
    }
  }

  return {
    ok: true,
    matches: Array.from(matchMap.values()),
  };
}

export function createHandler(deps = {}) {
  const {
    fetchImpl = (...args) => globalThis.fetch(...args),
    now = () => Date.now(),
    env = process.env,
    cache = new Map(),
  } = deps;

  return async function handler(req, res) {
    if (handlePreflightAndMethod(req, res)) {
      return;
    }

    const apiKey = env.FOOTBALL_DATA_API_KEY;

    if (!apiKey) {
      setNoStore(res);
      return res.status(500).json({ error: 'Missing FOOTBALL_DATA_API_KEY' });
    }

    try {
      const nowMs = now();
      const today = getTodayDate(nowMs);
      const fetchResult = await fetchUnitedMatches(apiKey, today, {
        cache,
        fetchImpl,
        deadlineMs: nowMs + 8500,
        now,
      });

      if (!fetchResult.ok) {
        setNoStore(res);
        return res.status(fetchResult.status).json({
          error: 'football-data.org API error',
          details: fetchResult.errorText,
        });
      }

      const matches = fetchResult.matches;

      // Sort by date (most recent first)
      matches.sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate));

      // Build results (most recent first), skipping matches without a resolvable outcome
      const results = [];

      for (const match of matches) {
        const result = getMatchResult(match, UNITED_TEAM_ID);
        if (!result) continue;

        const isHome = match.homeTeam?.id === UNITED_TEAM_ID;
        const opponentTeam = isHome ? match.awayTeam : match.homeTeam;

        results.push({
          result,
          date: match.utcDate,
          opponent: opponentTeam?.name ?? 'Unknown',
          opponentId: opponentTeam?.id ?? null,
          opponentTla: opponentTeam?.tla ?? null,
          opponentCrest: opponentTeam?.crest ?? null,
          score: formatMatchScore(match),
          home: isHome,
        });
      }

      // Calculate current win streak (from most recent)
      let currentStreak = 0;
      for (const r of results) {
        if (r.result === 'W') {
          currentStreak++;
        } else {
          break;
        }
      }

      // Calculate best (longest) win streak chronologically since Frank's vow
      const chronological = [...results].reverse();
      let bestStreak = 0;
      let tempStreak = 0;
      let bestStreakEndIndex = -1;
      let achievementDate = null;

      for (let i = 0; i < chronological.length; i++) {
        if (chronological[i].result === 'W') {
          tempStreak++;
          if (tempStreak >= 5 && !achievementDate) {
            achievementDate = chronological[i].date;
          }
          if (tempStreak > bestStreak) {
            bestStreak = tempStreak;
            bestStreakEndIndex = i;
          }
        } else {
          tempStreak = 0;
        }
      }

      let bestStreakDetails = null;
      if (bestStreak > 0 && bestStreakEndIndex !== -1) {
        const startIndex = bestStreakEndIndex - bestStreak + 1;
        const streakMatches = chronological.slice(startIndex, bestStreakEndIndex + 1);

        bestStreakDetails = {
          length: bestStreak,
          startDate: streakMatches[0]?.date,
          endDate: streakMatches[streakMatches.length - 1]?.date,
          matches: streakMatches.map((m) => ({
            opponent: m.opponent,
            opponentId: m.opponentId,
            opponentTla: m.opponentTla,
            opponentCrest: m.opponentCrest,
            score: m.score,
            date: m.date,
            home: m.home,
          })),
        };
      }

      const hasWon5 = bestStreak >= 5 || currentStreak >= 5;
      const formString = results.slice(0, 5).map((r) => r.result).join('');

      setPublicCache(res, { sMaxAge: 60, staleWhileRevalidate: 300 });
      return res.status(200).json({
        scope: 'all_competitions',
        hasWon5,
        achievementDate,
        currentStreak,
        bestStreak,
        bestStreakDetails,
        form: formString,
        recentMatches: results.slice(0, 5),
        lastUpdated: new Date(nowMs).toISOString(),
      });
    } catch (error) {
      console.error('United API error:', error);
      setNoStore(res);
      return res.status(500).json({
        error: 'Failed to fetch United data',
        details: error.message,
      });
    }
  };
}

export default createHandler();
