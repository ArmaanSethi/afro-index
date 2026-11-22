import { createClient } from '@supabase/supabase-js';
import {
  COMPETITIONS,
  countUncachedWindows,
  fetchCompetitionMatches,
  findFiveWinStreak,
  getMatchResult,
  getTodayDate,
  mergeTeamRecord,
} from './_lib/football.js';
import {
  handlePreflightAndMethod,
  isAuthorizedCron,
  setNoStore,
} from './_lib/http.js';
import {
  fetchExistingTeamsByLeague,
  fetchLatestScansByLeague,
} from './_lib/supabase.js';

export const MAX_UPSTREAM_REQUESTS_PER_RUN = 8;
export const MAX_RUN_MS = 6500;
export const HARD_DEADLINE_MS = 9000;
export const DEFAULT_FETCH_TIMEOUT_MS = 3500;

async function scanCompetition(
  comp,
  apiKey,
  supabase,
  { today, nowMs, cache, fetchImpl, timeoutMs, deadlineMs, now }
) {
  let requestsMade = 0;
  try {
    const fetchResult = await fetchCompetitionMatches(comp.code, apiKey, today, {
      cache,
      fetchImpl,
      timeoutMs,
      deadlineMs,
      now,
    });

    requestsMade = fetchResult.requestsMade || 0;

    if (!fetchResult.ok) {
      return {
        code: comp.code,
        error: `HTTP ${fetchResult.status}`,
        status: fetchResult.status,
        teamsScanned: 0,
        teamsQualified: 0,
        requestsMade,
      };
    }

    const matches = fetchResult.matches;

    if (matches.length === 0) {
      const { error: logError } = await supabase.from('scan_log').insert({
        sport: 'football',
        league_id: comp.code,
        league_name: comp.name,
        teams_scanned: 0,
        teams_qualified: 0,
      });

      if (logError) {
        return {
          code: comp.code,
          error: `DB scan_log failed: ${logError.message}`,
          teamsScanned: 0,
          teamsQualified: 0,
          requestsMade,
        };
      }

      return { code: comp.code, teamsScanned: 0, teamsQualified: 0, requestsMade };
    }

    // Build results per team from resolvable matches
    const teamResults = {};
    for (const match of matches) {
      const homeTeam = match.homeTeam;
      const awayTeam = match.awayTeam;
      if (!homeTeam?.id || !awayTeam?.id) continue;

      const homeResult = getMatchResult(match, homeTeam.id);
      const awayResult = getMatchResult(match, awayTeam.id);
      if (!homeResult || !awayResult) continue;

      const matchDate = match.utcDate;

      if (!teamResults[homeTeam.id]) {
        teamResults[homeTeam.id] = {
          id: homeTeam.id,
          name: homeTeam.name,
          logo: homeTeam.crest,
          results: [],
        };
      }
      if (!teamResults[awayTeam.id]) {
        teamResults[awayTeam.id] = {
          id: awayTeam.id,
          name: awayTeam.name,
          logo: awayTeam.crest,
          results: [],
        };
      }

      teamResults[homeTeam.id].results.push({ date: matchDate, result: homeResult });
      teamResults[awayTeam.id].results.push({ date: matchDate, result: awayResult });
    }

    // Read existing rows for non-destructive merge
    let existingMap;
    try {
      existingMap = await fetchExistingTeamsByLeague(supabase, comp.code);
    } catch (existingError) {
      return {
        code: comp.code,
        error: `DB read failed: ${existingError.message}`,
        teamsScanned: 0,
        teamsQualified: 0,
        requestsMade,
      };
    }

    const teamsToUpsert = [];
    const competitionInfo = fetchResult.competition || {};
    const checkedAt = new Date(nowMs).toISOString();

    for (const teamId of Object.keys(teamResults)) {
      const team = teamResults[teamId];
      team.results.sort((a, b) => new Date(a.date) - new Date(b.date));

      const { achievedStreak, maxConsecutive, achievedDate } = findFiveWinStreak(team.results);
      const parsedTeamId = parseInt(teamId, 10);

      const incoming = {
        team_id: parsedTeamId,
        sport: 'football',
        name: team.name,
        logo: team.logo ?? null,
        country_name: competitionInfo.area?.name || comp.country,
        country_flag: competitionInfo.area?.flag || null,
        league_id: comp.code,
        league_name: competitionInfo.name || comp.name,
        form: team.results.map((r) => r.result).join(''),
        has_5_wins: achievedStreak,
        max_streak: maxConsecutive,
        streak_achieved_date: typeof achievedDate === 'string' ? achievedDate.split('T')[0] : null,
        first_detected: checkedAt,
        last_checked: checkedAt,
      };

      teamsToUpsert.push(mergeTeamRecord(existingMap.get(parsedTeamId), incoming));
    }

    const teamsScanned = Object.keys(teamResults).length;
    const teamsQualified = teamsToUpsert.filter((t) => t.has_5_wins).length;

    // Upsert teams; abort before scan_log insert on error
    if (teamsToUpsert.length > 0) {
      const { error: upsertError } = await supabase
        .from('teams')
        .upsert(teamsToUpsert, {
          onConflict: 'team_id,league_id,sport',
          ignoreDuplicates: false,
          defaultToNull: false,
        });

      if (upsertError) {
        return {
          code: comp.code,
          error: `DB upsert failed: ${upsertError.message}`,
          teamsScanned: 0,
          teamsQualified: 0,
          requestsMade,
        };
      }
    }

    const { error: logError } = await supabase.from('scan_log').insert({
      sport: 'football',
      league_id: comp.code,
      league_name: competitionInfo.name || comp.name,
      teams_scanned: teamsScanned,
      teams_qualified: teamsQualified,
    });

    if (logError) {
      return {
        code: comp.code,
        error: `DB scan_log failed: ${logError.message}`,
        teamsScanned,
        teamsQualified,
        requestsMade,
      };
    }

    return { code: comp.code, teamsScanned, teamsQualified, requestsMade };
  } catch (error) {
    return {
      code: comp.code,
      error: error instanceof Error ? error.message : String(error),
      teamsScanned: 0,
      teamsQualified: 0,
      requestsMade: Number.isFinite(error?.requestsMade) ? error.requestsMade : requestsMade,
    };
  }
}

export function createHandler(deps = {}) {
  const {
    getSupabase = (url, key) => createClient(url, key),
    fetchImpl = (...args) => globalThis.fetch(...args),
    now = () => Date.now(),
    env = process.env,
    cache = new Map(),
  } = deps;

  return async function handler(req, res) {
    setNoStore(res);

    if (handlePreflightAndMethod(req, res, { allowAuthorization: true })) {
      return;
    }

    if (env.CRON_SECRET && !isAuthorizedCron(req, env.CRON_SECRET)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const apiKey = env.FOOTBALL_DATA_API_KEY;
    const supabaseUrl = env.SUPABASE_URL;
    const supabaseKey = env.SUPABASE_SERVICE_KEY;

    if (!apiKey || !supabaseUrl || !supabaseKey) {
      return res.status(500).json({ error: 'Missing environment variables' });
    }

    const supabase = getSupabase(supabaseUrl, supabaseKey);
    const startTime = now();
    const today = getTodayDate(startTime);

    try {
      // Order competitions stalest-first using per-league latest scan_log lookup
      const latestScans = await fetchLatestScansByLeague(supabase);
      const lastScanMap = new Map(
        latestScans.map((log) => [log.league_id, new Date(log.scanned_at).getTime()])
      );

      const sortedCompetitions = [...COMPETITIONS].sort((a, b) => {
        const aTime = lastScanMap.get(a.code) ?? 0;
        const bTime = lastScanMap.get(b.code) ?? 0;
        return aTime - bTime;
      });

      const results = [];
      let upstreamRequestsMade = 0;

      for (let i = 0; i < sortedCompetitions.length; i++) {
        const comp = sortedCompetitions[i];
        const elapsedSoFar = now() - startTime;

        if (elapsedSoFar >= MAX_RUN_MS) {
          results.push({ code: comp.code, skipped: true, reason: 'timeout' });
          continue;
        }

        const neededRequests = countUncachedWindows(comp.code, today, cache);
        if (upstreamRequestsMade + neededRequests > MAX_UPSTREAM_REQUESTS_PER_RUN) {
          results.push({ code: comp.code, skipped: true, reason: 'request_budget' });
          continue;
        }

        const timeoutMs = DEFAULT_FETCH_TIMEOUT_MS;
        const deadlineMs = startTime + HARD_DEADLINE_MS;

        const result = await scanCompetition(comp, apiKey, supabase, {
          today,
          nowMs: now(),
          cache,
          fetchImpl,
          timeoutMs,
          deadlineMs,
          now,
        });

        upstreamRequestsMade += result.requestsMade || 0;
        results.push(result);

        if (result.status === 429) {
          for (let j = i + 1; j < sortedCompetitions.length; j++) {
            results.push({
              code: sortedCompetitions[j].code,
              skipped: true,
              reason: 'rate_limit',
            });
          }
          break;
        }
      }

      const elapsed = now() - startTime;
      const scanned = results.filter((r) => !r.skipped && !r.error).length;
      const errors = results.filter((r) => Boolean(r.error));
      const hitRateLimit = errors.some((r) => r.status === 429);
      const totalQualified = results.reduce((sum, r) => sum + (r.teamsQualified || 0), 0);

      let statusCode = 200;
      let success = true;
      if (scanned === 0) {
        success = false;
        statusCode = hitRateLimit ? 429 : 503;
      }

      return res.status(statusCode).json({
        success,
        message: `Scanned ${scanned}/${COMPETITIONS.length} leagues in ${elapsed}ms`,
        elapsedMs: elapsed,
        upstreamRequests: upstreamRequestsMade,
        leaguesScanned: scanned,
        totalTeamsQualified: totalQualified,
        results,
      });
    } catch (error) {
      console.error('Scan-all error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to read scan history',
        details: error.message,
      });
    }
  };
}

export default createHandler();
