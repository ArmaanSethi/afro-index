import { createClient } from '@supabase/supabase-js';

// Challenge start date
const START_DATE = '2024-10-05';

// PRIORITY LEAGUES - scan these first for best ROI on API credits
const PRIORITY_LEAGUES = [
    { id: 39, name: 'Premier League', country: 'England' },
    { id: 140, name: 'La Liga', country: 'Spain' },
    { id: 78, name: 'Bundesliga', country: 'Germany' },
    { id: 135, name: 'Serie A', country: 'Italy' },
    { id: 61, name: 'Ligue 1', country: 'France' },
    { id: 307, name: 'Saudi Pro League', country: 'Saudi Arabia' },
    { id: 253, name: 'MLS', country: 'USA' },
    { id: 71, name: 'Brasileirão', country: 'Brazil' },
];

// ALL LEAGUES
const ALL_LEAGUES = [
    ...PRIORITY_LEAGUES,
    { id: 88, name: 'Eredivisie', country: 'Netherlands' },
    { id: 94, name: 'Primeira Liga', country: 'Portugal' },
    { id: 144, name: 'Belgian Pro League', country: 'Belgium' },
    { id: 203, name: 'Turkish Süper Lig', country: 'Turkey' },
    { id: 113, name: 'Greek Super League', country: 'Greece' },
];

// Find 5+ consecutive wins in a sequence of results
function findFiveWinStreak(results) {
    // results is array of 'W', 'D', 'L' in chronological order
    let consecutiveWins = 0;
    let maxConsecutive = 0;
    let achievedStreak = false;

    for (const result of results) {
        if (result === 'W') {
            consecutiveWins++;
            if (consecutiveWins >= 5) {
                achievedStreak = true;
                maxConsecutive = Math.max(maxConsecutive, consecutiveWins);
            }
        } else {
            maxConsecutive = Math.max(maxConsecutive, consecutiveWins);
            consecutiveWins = 0;
        }
    }

    return { achievedStreak, maxConsecutive };
}

// Get today's date in YYYY-MM-DD format
function getTodayDate() {
    return new Date().toISOString().split('T')[0];
}

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const apiKey = process.env.API_FOOTBALL_KEY;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (!apiKey || !supabaseUrl || !supabaseKey) {
        return res.status(500).json({ error: 'Missing environment variables' });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Check which priority leagues haven't been scanned yet
    const { data: scanLogs } = await supabase
        .from('scan_log')
        .select('league_id');

    const scannedLeagueIds = new Set((scanLogs || []).map(l => l.league_id));

    // Find unscanned priority leagues first
    let targetLeague = null;
    const mode = req.query.mode || 'priority';

    if (mode === 'priority') {
        targetLeague = PRIORITY_LEAGUES.find(l => !scannedLeagueIds.has(l.id));
    }

    // If no unscanned priority leagues, pick randomly from all
    if (!targetLeague) {
        const unscannedLeagues = ALL_LEAGUES.filter(l => !scannedLeagueIds.has(l.id));
        const pool = unscannedLeagues.length > 0 ? unscannedLeagues : ALL_LEAGUES;
        targetLeague = pool[Math.floor(Math.random() * pool.length)];
    }

    // Allow override via query param
    if (req.query.league) {
        const overrideId = parseInt(req.query.league);
        targetLeague = ALL_LEAGUES.find(l => l.id === overrideId) || { id: overrideId, name: 'Custom', country: 'Unknown' };
    }

    try {
        // Fetch ALL fixtures for this league since Oct 5, 2024
        const response = await fetch(
            `https://v3.football.api-sports.io/fixtures?league=${targetLeague.id}&season=2024&from=${START_DATE}&to=${getTodayDate()}`,
            {
                headers: {
                    'x-apisports-key': apiKey
                }
            }
        );

        const data = await response.json();

        if (data.errors && Object.keys(data.errors).length > 0) {
            return res.status(400).json({
                error: 'API-Football error',
                details: data.errors,
                league: targetLeague
            });
        }

        const fixtures = data.response || [];

        if (fixtures.length === 0) {
            await supabase.from('scan_log').insert({
                league_id: targetLeague.id,
                league_name: targetLeague.name,
                teams_scanned: 0,
                teams_qualified: 0
            });

            return res.status(200).json({
                message: 'No fixtures found for this league since Oct 5, 2024',
                league: targetLeague,
                fixturesAnalyzed: 0,
                teamsScanned: 0,
                teamsQualified: 0
            });
        }

        // Build results per team from fixtures
        // Only count finished matches (status.short === 'FT')
        const teamResults = {}; // teamId -> { info, results: ['W', 'L', 'D', ...] }

        for (const fixture of fixtures) {
            if (fixture.fixture.status.short !== 'FT') continue; // Only finished matches

            const homeTeam = fixture.teams.home;
            const awayTeam = fixture.teams.away;
            const homeGoals = fixture.goals.home;
            const awayGoals = fixture.goals.away;
            const matchDate = fixture.fixture.date;

            // Initialize teams if not seen
            if (!teamResults[homeTeam.id]) {
                teamResults[homeTeam.id] = {
                    id: homeTeam.id,
                    name: homeTeam.name,
                    logo: homeTeam.logo,
                    results: []
                };
            }
            if (!teamResults[awayTeam.id]) {
                teamResults[awayTeam.id] = {
                    id: awayTeam.id,
                    name: awayTeam.name,
                    logo: awayTeam.logo,
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

            // Add with date for sorting
            teamResults[homeTeam.id].results.push({ date: matchDate, result: homeResult });
            teamResults[awayTeam.id].results.push({ date: matchDate, result: awayResult });
        }

        // Sort each team's results chronologically and check for 5-win streak
        const teamsToUpsert = [];
        let teamsQualified = 0;

        // Get league info from first fixture
        const leagueInfo = fixtures[0]?.league || {};
        const leagueName = leagueInfo.name || targetLeague.name;
        const countryName = leagueInfo.country || targetLeague.country;
        const countryFlag = leagueInfo.flag || null;

        for (const teamId in teamResults) {
            const team = teamResults[teamId];

            // Sort by date chronologically
            team.results.sort((a, b) => new Date(a.date) - new Date(b.date));
            const resultSequence = team.results.map(r => r.result);

            // Check for 5-win streak
            const { achievedStreak, maxConsecutive } = findFiveWinStreak(resultSequence);

            if (achievedStreak) teamsQualified++;

            teamsToUpsert.push({
                team_id: parseInt(teamId),
                sport: 'football',
                name: team.name,
                logo: team.logo,
                country_name: countryName,
                country_flag: countryFlag,
                league_id: targetLeague.id,
                league_name: leagueName,
                form: resultSequence.join(''),
                has_5_wins: achievedStreak,
                max_streak: maxConsecutive,
                last_checked: new Date().toISOString()
            });
        }

        // Upsert all teams
        if (teamsToUpsert.length > 0) {
            const { error } = await supabase
                .from('teams')
                .upsert(teamsToUpsert, {
                    onConflict: 'team_id,sport',
                    ignoreDuplicates: false
                });

            if (error) {
                console.error('Supabase upsert error:', error);
            }
        }

        // Log the scan
        await supabase.from('scan_log').insert({
            sport: 'football',
            league_id: targetLeague.id,
            league_name: leagueName,
            teams_scanned: Object.keys(teamResults).length,
            teams_qualified: teamsQualified
        });

        // Get priority queue status
        const remainingPriority = PRIORITY_LEAGUES.filter(l => !scannedLeagueIds.has(l.id) && l.id !== targetLeague.id);

        return res.status(200).json({
            success: true,
            league: {
                id: targetLeague.id,
                name: leagueName,
                country: countryName
            },
            fixturesAnalyzed: fixtures.filter(f => f.fixture.status.short === 'FT').length,
            teamsScanned: Object.keys(teamResults).length,
            teamsQualified: teamsQualified,
            priorityRemaining: remainingPriority.length,
            nextPriority: remainingPriority[0] || null,
            teams: teamsToUpsert.filter(t => t.has_5_wins)
        });

    } catch (error) {
        console.error('Scan error:', error);
        return res.status(500).json({ error: 'Scan failed', details: error.message });
    }
}
