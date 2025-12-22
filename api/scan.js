import { createClient } from '@supabase/supabase-js';

// League IDs to scan (top leagues worldwide)
const LEAGUE_IDS = [39, 140, 78, 135, 61, 88, 94, 144, 203, 113, 71, 253, 307];

// League names for display
const LEAGUE_NAMES = {
    39: 'Premier League',
    140: 'La Liga',
    78: 'Bundesliga',
    135: 'Serie A',
    61: 'Ligue 1',
    88: 'Eredivisie',
    94: 'Primeira Liga',
    144: 'Belgian Pro League',
    203: 'Turkish Süper Lig',
    113: 'Greek Super League',
    71: 'Brasileirão',
    253: 'MLS',
    307: 'Saudi Pro League'
};

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

    // Pick a random league or use query param
    const leagueId = req.query.league
        ? parseInt(req.query.league)
        : LEAGUE_IDS[Math.floor(Math.random() * LEAGUE_IDS.length)];

    try {
        // Fetch standings from API-Football
        const response = await fetch(
            `https://v3.football.api-sports.io/standings?league=${leagueId}&season=2024`,
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
                leagueId
            });
        }

        if (!data.response || data.response.length === 0) {
            return res.status(200).json({
                message: 'No standings data for this league/season',
                leagueId,
                leagueName: LEAGUE_NAMES[leagueId] || 'Unknown',
                teamsFound: 0
            });
        }

        const standings = data.response[0]?.league?.standings?.[0] || [];
        const qualifyingTeams = [];

        for (const team of standings) {
            const form = team.form || '';

            // Check if form contains 5 consecutive wins
            if (form.includes('WWWWW')) {
                const teamData = {
                    team_id: team.team.id,
                    name: team.team.name,
                    logo: team.team.logo,
                    country_name: data.response[0]?.league?.country || 'Unknown',
                    country_flag: data.response[0]?.league?.flag || null,
                    league_id: leagueId,
                    league_name: data.response[0]?.league?.name || LEAGUE_NAMES[leagueId] || 'Unknown',
                    form: form,
                    last_checked: new Date().toISOString()
                };

                // Upsert to Supabase
                const { error } = await supabase
                    .from('teams')
                    .upsert(teamData, {
                        onConflict: 'team_id',
                        ignoreDuplicates: false
                    });

                if (error) {
                    console.error('Supabase upsert error:', error);
                } else {
                    qualifyingTeams.push(teamData);
                }
            }
        }

        return res.status(200).json({
            success: true,
            leagueId,
            leagueName: data.response[0]?.league?.name || LEAGUE_NAMES[leagueId],
            teamsScanned: standings.length,
            teamsFound: qualifyingTeams.length,
            teams: qualifyingTeams
        });

    } catch (error) {
        console.error('Scan error:', error);
        return res.status(500).json({ error: 'Scan failed', details: error.message });
    }
}
