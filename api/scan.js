import { createClient } from '@supabase/supabase-js';
import {
  COMPETITIONS,
  COMPETITION_BY_CODE,
  fetchCompetitionMatches,
  findFiveWinStreak,
  getMatchResult,
  getTodayDate,
  mergeTeamRecord,
  selectCompetition,
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

export function createHandler(deps = {}) {
  const {
    getSupabase = (url, key) => createClient(url, key),
    fetchImpl = (...args) => globalThis.fetch(...args),
    now = () => Date.now(),
    env = process.env,
    cache = new Map(),
  } = deps;

  return async function handler(req, res) {
    if (handlePreflightAndMethod(req, res, { allowAuthorization: true })) {
      return;
    }

    try {
      // Strictly validate optional ?competition= override before any DB or upstream calls
      const rawCompetition = req.query?.competition;
      let overrideComp = null;

      if (rawCompetition !== undefined) {
        if (typeof rawCompetition !== 'string') {
          setNoStore(res);
          return res.status(400).json({
            error: 'Invalid competition parameter',
            allowedCompetitions: COMPETITIONS.map((c) => c.code),
          });
        }

        const normalizedCode = rawCompetition.trim().toUpperCase();
        overrideComp = COMPETITION_BY_CODE.get(normalizedCode) || null;
        if (!overrideComp) {
          setNoStore(res);
          return res.status(400).json({
            error: `Unknown competition code: ${rawCompetition}`,
            allowedCompetitions: COMPETITIONS.map((c) => c.code),
          });
        }

        if (env.CRON_SECRET && !isAuthorizedCron(req, env.CRON_SECRET)) {
          setNoStore(res);
          return res.status(401).json({ error: 'Unauthorized' });
        }
      }

      const apiKey = env.FOOTBALL_DATA_API_KEY;
      const supabaseUrl = env.SUPABASE_URL;
      const supabaseKey = env.SUPABASE_SERVICE_KEY;

      if (!apiKey || !supabaseUrl || !supabaseKey) {
        setNoStore(res);
        return res.status(500).json({
          error: 'Missing environment variables',
          hint: 'Need: FOOTBALL_DATA_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY',
        });
      }

      const supabase = getSupabase(supabaseUrl, supabaseKey);
      const nowMs = now();

      // Get latest scan timestamp per known competition (immune to scan_log row count)
      const latestScans = await fetchLatestScansByLeague(supabase);
      const lastScanMap = new Map(
        latestScans.map((log) => [log.league_id, new Date(log.scanned_at)])
      );

      const { sortedCompetitions, eligible, nextScanSeconds } = selectCompetition(
        COMPETITIONS,
        lastScanMap,
        nowMs
      );

      let targetComp;
      let nextCompetition;

      if (!overrideComp) {
        if (eligible.length === 0) {
          setNoStore(res);
          return res.status(200).json({
            skipped: true,
            message: 'Data is fresh enough',
            scanned: false,
            nextScanIn: `${nextScanSeconds}s`,
          });
        }
        targetComp = eligible[0];
        nextCompetition =
          eligible[1] ||
          sortedCompetitions.find((c) => c.code !== targetComp.code) ||
          null;
      } else {
        targetComp = overrideComp;
        nextCompetition =
          eligible.find((c) => c.code !== targetComp.code) ||
          sortedCompetitions.find((c) => c.code !== targetComp.code) ||
          null;
      }

      const unscannedCount = COMPETITIONS.filter((c) => !lastScanMap.has(c.code)).length;
      const wasUnscanned = !lastScanMap.has(targetComp.code);
      const remainingCompetitions = Math.max(0, unscannedCount - (wasUnscanned ? 1 : 0));

      const fetchResult = await fetchCompetitionMatches(
        targetComp.code,
        apiKey,
        getTodayDate(nowMs),
        { cache, fetchImpl, timeoutMs: 7000, deadlineMs: nowMs + 8500, now }
      );

      if (!fetchResult.ok) {
        setNoStore(res);
        return res.status(fetchResult.status).json({
          error: 'football-data.org API error',
          status: fetchResult.status,
          details: fetchResult.errorText,
          competition: targetComp,
        });
      }

      const matches = fetchResult.matches;

      if (matches.length === 0) {
        const { error: logError } = await supabase.from('scan_log').insert({
          sport: 'football',
          league_id: targetComp.code,
          league_name: targetComp.name,
          teams_scanned: 0,
          teams_qualified: 0,
        });

        if (logError) {
          throw new Error(`Failed to insert scan_log: ${logError.message}`);
        }

        setNoStore(res);
        return res.status(200).json({
          message: 'No finished matches found for this competition since Oct 5, 2024',
          competition: targetComp,
          matchesAnalyzed: 0,
          teamsScanned: 0,
          teamsQualified: 0,
        });
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

      // Fetch existing rows for non-destructive merge
      const existingMap = await fetchExistingTeamsByLeague(supabase, targetComp.code);

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
          country_name: competitionInfo.area?.name || targetComp.country,
          country_flag: competitionInfo.area?.flag || null,
          league_id: targetComp.code,
          league_name: competitionInfo.name || targetComp.name,
          form: team.results.map((r) => r.result).join(''),
          has_5_wins: achievedStreak,
          max_streak: maxConsecutive,
          streak_achieved_date: typeof achievedDate === 'string' ? achievedDate.split('T')[0] : null,
          first_detected: checkedAt,
          last_checked: checkedAt,
        };

        const merged = mergeTeamRecord(existingMap.get(parsedTeamId), incoming);
        teamsToUpsert.push(merged);
      }

      const teamsQualified = teamsToUpsert.filter((t) => t.has_5_wins).length;

      // Upsert teams first; abort before writing scan_log on any error
      if (teamsToUpsert.length > 0) {
        const { error: upsertError } = await supabase
          .from('teams')
          .upsert(teamsToUpsert, {
            onConflict: 'team_id,league_id,sport',
            ignoreDuplicates: false,
            defaultToNull: false,
          });

        if (upsertError) {
          throw new Error(`Failed to upsert teams: ${upsertError.message}`);
        }
      }

      const { error: logError } = await supabase.from('scan_log').insert({
        sport: 'football',
        league_id: targetComp.code,
        league_name: competitionInfo.name || targetComp.name,
        teams_scanned: Object.keys(teamResults).length,
        teams_qualified: teamsQualified,
      });

      if (logError) {
        throw new Error(`Failed to insert scan_log: ${logError.message}`);
      }

      setNoStore(res);
      return res.status(200).json({
        success: true,
        competition: {
          code: targetComp.code,
          name: competitionInfo.name || targetComp.name,
          country: competitionInfo.area?.name || targetComp.country,
        },
        matchesAnalyzed: matches.length,
        teamsScanned: Object.keys(teamResults).length,
        teamsQualified,
        remainingCompetitions,
        totalCompetitions: COMPETITIONS.length,
        nextCompetition,
        teams: teamsToUpsert.filter((t) => t.has_5_wins),
      });
    } catch (error) {
      console.error('Scan error:', error);
      setNoStore(res);
      return res.status(500).json({ error: 'Scan failed', details: error.message });
    }
  };
}

export default createHandler();
