import { createClient } from '@supabase/supabase-js';

// Challenge start date
const START_DATE = '2024-10-05';

// football-data.org competition codes (free tier)
// See: https://www.football-data.org/documentation/api
const COMPETITIONS = [
    { code: 'PL', name: 'Premier League', country: 'England' },
    { code: 'PD', name: 'La Liga', country: 'Spain' },
    { code: 'BL1', name: 'Bundesliga', country: 'Germany' },
    { code: 'SA', name: 'Serie A', country: 'Italy' },
    { code: 'FL1', name: 'Ligue 1', country: 'France' },
    { code: 'DED', name: 'Eredivisie', country: 'Netherlands' },
    { code: 'PPL', name: 'Primeira Liga', country: 'Portugal' },
    { code: 'ELC', name: 'Championship', country: 'England' },
    { code: 'CL', name: 'Champions League', country: 'Europe' },
    { code: 'EC', name: 'Euro Championship', country: 'Europe' },
    { code: 'WC', name: 'World Cup', country: 'World' },
    { code: 'BSA', name: 'Brasileirão', country: 'Brazil' },
];

// Find 5+ consecutive wins in a sequence of results (with dates)
// Returns { achievedStreak, maxConsecutive, achievedDate }
function findFiveWinStreak(results) {
    let consecutiveWins = 0;
    let maxConsecutive = 0;
    let achievedStreak = false;
    let achievedDate = null;
    let streakStartIndex = 0;

    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.result === 'W') {
            if (consecutiveWins === 0) {
                streakStartIndex = i;
            }
            consecutiveWins++;
            if (consecutiveWins >= 5 && !achievedDate) {
                // First time hitting 5 wins - record the date of the 5th win
                achievedStreak = true;
                achievedDate = r.date;
            }
            maxConsecutive = Math.max(maxConsecutive, consecutiveWins);
        } else {
            maxConsecutive = Math.max(maxConsecutive, consecutiveWins);
            consecutiveWins = 0;
        }
    }

    return { achievedStreak, maxConsecutive, achievedDate };
}

// Get today's date in YYYY-MM-DD format
function getTodayDate() {
    return new Date().toISOString().split('T')[0];
}

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Vercel Edge Cache: Cache for 10s, but allow stale for 24h to keep data avail even if cron fails
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=86400');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const apiKey = process.env.FOOTBALL_DATA_API_KEY;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (!apiKey || !supabaseUrl || !supabaseKey) {
        return res.status(500).json({
            error: 'Missing environment variables',
            hint: 'Need: FOOTBALL_DATA_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY'
        });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get latest scan timestamp for each competition
    const { data: scanLogs } = await supabase
        .from('scan_log')
        .select('league_id, scanned_at')
        .order('scanned_at', { ascending: false });

    // Build a map of league_id -> most recent scan time
    const lastScanMap = new Map();
    for (const log of (scanLogs || [])) {
        if (!lastScanMap.has(log.league_id)) {
            lastScanMap.set(log.league_id, new Date(log.scanned_at));
        }
    }

    // Priority Leagues (The "Big 5")
    const PRIORITY_LEAGUES = ['PL', 'PD', 'BL1', 'SA', 'FL1'];

    // Helper to check if a league is in the priority list
    const isPriority = (code) => PRIORITY_LEAGUES.includes(code);

    // Sort competitions by priority:
    // 1. Never scanned (no entry in map) - highest priority
    // 2. Priority Leagues that are "stale" (> 10 mins old) - next highest
    // 3. Oldest scanned - fallback
    const sortedCompetitions = [...COMPETITIONS].sort((a, b) => {
        const aTime = lastScanMap.get(a.code);
        const bTime = lastScanMap.get(b.code);
        const now = new Date();

        // 1. Never scanned = highest priority (return -1 to sort first)
        if (!aTime && bTime) return -1;
        if (aTime && !bTime) return 1;
        if (!aTime && !bTime) return 0;

        // 2. Priority Logic
        const aIsPriority = isPriority(a.code);
        const bIsPriority = isPriority(b.code);

        // Thresholds
        const SUPER_STALE = 60 * 60 * 1000;       // 60 Minutes (Others updated hourly)
        const LIVE_STALE = 15 * 60 * 1000;        // 15 Minutes (Top 5 updated quarterly)

        const aDiff = now - aTime;
        const bDiff = now - bTime;

        const aSuperStale = aDiff > SUPER_STALE;
        const bSuperStale = bDiff > SUPER_STALE;

        // 2a. Super Stale override (prevent starvation of minor leagues)
        if (aSuperStale && !bSuperStale) return -1;
        if (bSuperStale && !aSuperStale) return 1;

        // 2b. Priority Live Updates (only if not super stale)
        const aLiveStale = aDiff > LIVE_STALE;
        const bLiveStale = bDiff > LIVE_STALE;

        if (aIsPriority && aLiveStale && (!bIsPriority || !bLiveStale)) return -1;
        if (bIsPriority && bLiveStale && (!aIsPriority || !aLiveStale)) return 1;

        // 3. Fallback: Oldest first
        return aTime.getTime() - bTime.getTime();
    });

    // Pick the highest priority competition
    let targetComp = sortedCompetitions[0];

    // Calculate remaining unscanned competitions
    const unscannedCount = COMPETITIONS.filter(c => !lastScanMap.has(c.code)).length;

    // Allow override via query param
    if (req.query.competition) {
        const override = req.query.competition.toUpperCase();
        targetComp = COMPETITIONS.find(c => c.code === override) || { code: override, name: 'Custom', country: 'Unknown' };
    }

    try {
        // Fetch all matches for this competition since Oct 5, 2024
        const response = await fetch(
            `https://api.football-data.org/v4/competitions/${targetComp.code}/matches?dateFrom=${START_DATE}&dateTo=${getTodayDate()}&status=FINISHED`,
            {
                headers: {
                    'X-Auth-Token': apiKey
                }
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            return res.status(response.status).json({
                error: 'football-data.org API error',
                status: response.status,
                details: errorText,
                competition: targetComp
            });
        }

        const data = await response.json();
        const matches = data.matches || [];

        if (matches.length === 0) {
            await supabase.from('scan_log').insert({
                sport: 'football',
                league_id: targetComp.code,
                league_name: targetComp.name,
                teams_scanned: 0,
                teams_qualified: 0
            });

            return res.status(200).json({
                message: 'No finished matches found for this competition since Oct 5, 2024',
                competition: targetComp,
                matchesAnalyzed: 0,
                teamsScanned: 0,
                teamsQualified: 0
            });
        }

        // Build results per team from matches
        const teamResults = {}; // teamId -> { info, results: [{date, result}] }

        for (const match of matches) {
            const homeTeam = match.homeTeam;
            const awayTeam = match.awayTeam;
            const homeGoals = match.score?.fullTime?.home ?? 0;
            const awayGoals = match.score?.fullTime?.away ?? 0;
            const matchDate = match.utcDate;

            // Initialize teams if not seen
            if (!teamResults[homeTeam.id]) {
                teamResults[homeTeam.id] = {
                    id: homeTeam.id,
                    name: homeTeam.name,
                    logo: homeTeam.crest,
                    results: []
                };
            }
            if (!teamResults[awayTeam.id]) {
                teamResults[awayTeam.id] = {
                    id: awayTeam.id,
                    name: awayTeam.name,
                    logo: awayTeam.crest,
                    results: []
                };
            }

            // Determine results
            let homeResult, awayResult;
            if (homeGoals > awayGoals) {
                homeResult = 'W';
                awayResult = 'L';
            } else if (homeGoals < awayGoals) {
                homeResult = 'L';
                awayResult = 'W';
            } else {
                homeResult = 'D';
                awayResult = 'D';
            }

            teamResults[homeTeam.id].results.push({ date: matchDate, result: homeResult });
            teamResults[awayTeam.id].results.push({ date: matchDate, result: awayResult });
        }

        // Sort each team's results chronologically and check for 5-win streak
        const teamsToUpsert = [];
        let teamsQualified = 0;

        const competitionInfo = data.competition || {};

        for (const teamId in teamResults) {
            const team = teamResults[teamId];

            // Sort by date chronologically
            team.results.sort((a, b) => new Date(a.date) - new Date(b.date));

            // Check for 5-win streak (pass full results with dates)
            const { achievedStreak, maxConsecutive, achievedDate } = findFiveWinStreak(team.results);

            if (achievedStreak) teamsQualified++;

            teamsToUpsert.push({
                team_id: parseInt(teamId),
                sport: 'football',
                name: team.name,
                logo: team.logo,
                country_name: competitionInfo.area?.name || targetComp.country,
                country_flag: competitionInfo.area?.flag || null,
                league_id: targetComp.code,
                league_name: competitionInfo.name || targetComp.name,
                form: team.results.map(r => r.result).join(''),
                has_5_wins: achievedStreak,
                max_streak: maxConsecutive,
                streak_achieved_date: achievedDate ? achievedDate.split('T')[0] : null,
                last_checked: new Date().toISOString()
            });
        }

        // Upsert all teams
        if (teamsToUpsert.length > 0) {
            const { error } = await supabase
                .from('teams')
                .upsert(teamsToUpsert, {
                    onConflict: 'team_id,league_id,sport',
                    ignoreDuplicates: false
                });

            if (error) {
                console.error('Supabase upsert error:', error);
            }
        }

        // Log the scan
        await supabase.from('scan_log').insert({
            sport: 'football',
            league_id: targetComp.code,
            league_name: competitionInfo.name || targetComp.name,
            teams_scanned: Object.keys(teamResults).length,
            teams_qualified: teamsQualified
        });

        return res.status(200).json({
            success: true,
            competition: {
                code: targetComp.code,
                name: competitionInfo.name || targetComp.name,
                country: competitionInfo.area?.name || targetComp.country
            },
            matchesAnalyzed: matches.length,
            teamsScanned: Object.keys(teamResults).length,
            teamsQualified: teamsQualified,
            remainingCompetitions: unscannedCount > 0 ? unscannedCount - 1 : 0,
            totalCompetitions: COMPETITIONS.length,
            nextCompetition: sortedCompetitions[1] || null,
            teams: teamsToUpsert.filter(t => t.has_5_wins)
        });

    } catch (error) {
        console.error('Scan error:', error);
        return res.status(500).json({ error: 'Scan failed', details: error.message });
    }
}
