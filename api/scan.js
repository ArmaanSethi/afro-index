import { createClient } from '@supabase/supabase-js';

// PRIORITY LEAGUES - scan these first for best ROI on API credits
// Ordered by likelihood of having teams with 5-win streaks (top competitive leagues)
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

// ALL LEAGUES - for random scanning after priorities are done
const ALL_LEAGUES = [
    ...PRIORITY_LEAGUES,
    { id: 88, name: 'Eredivisie', country: 'Netherlands' },
    { id: 94, name: 'Primeira Liga', country: 'Portugal' },
    { id: 144, name: 'Belgian Pro League', country: 'Belgium' },
    { id: 203, name: 'Turkish Süper Lig', country: 'Turkey' },
    { id: 113, name: 'Greek Super League', country: 'Greece' },
];

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
    const mode = req.query.mode || 'priority'; // 'priority' or 'random'

    if (mode === 'priority') {
        targetLeague = PRIORITY_LEAGUES.find(l => !scannedLeagueIds.has(l.id));
    }

    // If no unscanned priority leagues (or random mode), pick randomly from all
    if (!targetLeague) {
        // Filter to unscanned leagues if possible
        const unscannedLeagues = ALL_LEAGUES.filter(l => !scannedLeagueIds.has(l.id));
        const pool = unscannedLeagues.length > 0 ? unscannedLeagues : ALL_LEAGUES;
        targetLeague = pool[Math.floor(Math.random() * pool.length)];
    }

    // Allow override via query param
    if (req.query.league) {
        const overrideId = parseInt(req.query.league);
        targetLeague = ALL_LEAGUES.find(l => l.id === overrideId) || { id: overrideId, name: 'Custom' };
    }

    try {
        // Fetch standings from API-Football
        const response = await fetch(
            `https://v3.football.api-sports.io/standings?league=${targetLeague.id}&season=2024`,
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

        if (!data.response || data.response.length === 0) {
            // Log the scan even if no data
            await supabase.from('scan_log').insert({
                league_id: targetLeague.id,
                league_name: targetLeague.name,
                teams_scanned: 0,
                teams_qualified: 0
            });

            return res.status(200).json({
                message: 'No standings data for this league/season',
                league: targetLeague,
                teamsScanned: 0,
                teamsQualified: 0
            });
        }

        const standings = data.response[0]?.league?.standings?.[0] || [];
        const leagueName = data.response[0]?.league?.name || targetLeague.name;
        const countryName = data.response[0]?.league?.country || targetLeague.country || 'Unknown';
        const countryFlag = data.response[0]?.league?.flag || null;

        let teamsQualified = 0;
        const allTeams = [];

        for (const team of standings) {
            const form = team.form || '';
            const has5Wins = form.includes('WWWWW');

            if (has5Wins) teamsQualified++;

            const teamData = {
                team_id: team.team.id,
                name: team.team.name,
                logo: team.team.logo,
                country_name: countryName,
                country_flag: countryFlag,
                league_id: targetLeague.id,
                league_name: leagueName,
                form: form,
                has_5_wins: has5Wins,
                last_checked: new Date().toISOString()
            };

            allTeams.push(teamData);
        }

        // Upsert ALL teams (not just winners)
        if (allTeams.length > 0) {
            const { error } = await supabase
                .from('teams')
                .upsert(allTeams, {
                    onConflict: 'team_id',
                    ignoreDuplicates: false
                });

            if (error) {
                console.error('Supabase upsert error:', error);
            }
        }

        // Log the scan
        await supabase.from('scan_log').insert({
            league_id: targetLeague.id,
            league_name: leagueName,
            teams_scanned: standings.length,
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
            teamsScanned: standings.length,
            teamsQualified: teamsQualified,
            priorityRemaining: remainingPriority.length,
            nextPriority: remainingPriority[0] || null,
            teams: allTeams.filter(t => t.has_5_wins) // Only return winners in response
        });

    } catch (error) {
        console.error('Scan error:', error);
        return res.status(500).json({ error: 'Scan failed', details: error.message });
    }
}
