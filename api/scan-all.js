import { createClient } from '@supabase/supabase-js';

// Challenge start date
const START_DATE = '2024-10-05';

// football-data.org competition codes (free tier)
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

function findFiveWinStreak(results) {
    let consecutiveWins = 0;
    let maxConsecutive = 0;
    let achievedStreak = false;
    let achievedDate = null;

    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.result === 'W') {
            consecutiveWins++;
            if (consecutiveWins >= 5 && !achievedDate) {
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

function getTodayDate() {
    return new Date().toISOString().split('T')[0];
}

// Scan a single competition and return results
async function scanCompetition(comp, apiKey, supabase) {
    try {
        const response = await fetch(
            `https://api.football-data.org/v4/competitions/${comp.code}/matches?dateFrom=${START_DATE}&dateTo=${getTodayDate()}&status=FINISHED`,
            { headers: { 'X-Auth-Token': apiKey } }
        );

        if (!response.ok) {
            return { code: comp.code, error: `HTTP ${response.status}`, teamsScanned: 0, teamsQualified: 0 };
        }

        const data = await response.json();
        const matches = data.matches || [];

        if (matches.length === 0) {
            await supabase.from('scan_log').insert({
                sport: 'football',
                league_id: comp.code,
                league_name: comp.name,
                teams_scanned: 0,
                teams_qualified: 0
            });
            return { code: comp.code, teamsScanned: 0, teamsQualified: 0 };
        }

        // Build results per team
        const teamResults = {};
        for (const match of matches) {
            const homeTeam = match.homeTeam;
            const awayTeam = match.awayTeam;
            const homeGoals = match.score?.fullTime?.home ?? 0;
            const awayGoals = match.score?.fullTime?.away ?? 0;
            const matchDate = match.utcDate;

            if (!teamResults[homeTeam.id]) {
                teamResults[homeTeam.id] = { id: homeTeam.id, name: homeTeam.name, logo: homeTeam.crest, results: [] };
            }
            if (!teamResults[awayTeam.id]) {
                teamResults[awayTeam.id] = { id: awayTeam.id, name: awayTeam.name, logo: awayTeam.crest, results: [] };
            }

            let homeResult, awayResult;
            if (homeGoals > awayGoals) { homeResult = 'W'; awayResult = 'L'; }
            else if (homeGoals < awayGoals) { homeResult = 'L'; awayResult = 'W'; }
            else { homeResult = 'D'; awayResult = 'D'; }

            teamResults[homeTeam.id].results.push({ date: matchDate, result: homeResult });
            teamResults[awayTeam.id].results.push({ date: matchDate, result: awayResult });
        }

        // Process teams
        const teamsToUpsert = [];
        let teamsQualified = 0;
        const competitionInfo = data.competition || {};

        for (const teamId in teamResults) {
            const team = teamResults[teamId];
            team.results.sort((a, b) => new Date(a.date) - new Date(b.date));
            const { achievedStreak, maxConsecutive, achievedDate } = findFiveWinStreak(team.results);
            if (achievedStreak) teamsQualified++;

            teamsToUpsert.push({
                team_id: parseInt(teamId),
                sport: 'football',
                name: team.name,
                logo: team.logo,
                country_name: competitionInfo.area?.name || comp.country,
                country_flag: competitionInfo.area?.flag || null,
                league_id: comp.code,
                league_name: competitionInfo.name || comp.name,
                form: team.results.map(r => r.result).join(''),
                has_5_wins: achievedStreak,
                max_streak: maxConsecutive,
                streak_achieved_date: achievedDate ? achievedDate.split('T')[0] : null,
                last_checked: new Date().toISOString()
            });
        }

        // Upsert teams
        if (teamsToUpsert.length > 0) {
            await supabase.from('teams').upsert(teamsToUpsert, {
                onConflict: 'team_id,league_id,sport',
                ignoreDuplicates: false
            });
        }

        // Log scan
        await supabase.from('scan_log').insert({
            sport: 'football',
            league_id: comp.code,
            league_name: competitionInfo.name || comp.name,
            teams_scanned: Object.keys(teamResults).length,
            teams_qualified: teamsQualified
        });

        return { code: comp.code, teamsScanned: Object.keys(teamResults).length, teamsQualified };
    } catch (error) {
        return { code: comp.code, error: error.message, teamsScanned: 0, teamsQualified: 0 };
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=86400');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const apiKey = process.env.FOOTBALL_DATA_API_KEY;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (!apiKey || !supabaseUrl || !supabaseKey) {
        return res.status(500).json({ error: 'Missing environment variables' });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const results = [];
    const startTime = Date.now();

    // Scan all competitions sequentially
    for (const comp of COMPETITIONS) {
        // Check if we're running out of time (leave 1s buffer)
        if (Date.now() - startTime > 9000) {
            results.push({ code: comp.code, skipped: true, reason: 'timeout' });
            continue;
        }

        const result = await scanCompetition(comp, apiKey, supabase);
        results.push(result);
    }

    const elapsed = Date.now() - startTime;
    const scanned = results.filter(r => !r.skipped && !r.error).length;
    const totalQualified = results.reduce((sum, r) => sum + (r.teamsQualified || 0), 0);

    return res.status(200).json({
        success: true,
        message: `Scanned ${scanned}/${COMPETITIONS.length} leagues in ${elapsed}ms`,
        elapsedMs: elapsed,
        leaguesScanned: scanned,
        totalTeamsQualified: totalQualified,
        results
    });
}
