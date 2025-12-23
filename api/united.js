

// Manchester United team ID in football-data.org
const UNITED_TEAM_ID = 66;
const UNITED_COMPETITION = 'PL'; // Premier League

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Vercel Edge Cache: Cache for 1 min (60s) to keep United status very fresh
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=86400');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const apiKey = process.env.FOOTBALL_DATA_API_KEY;

    if (!apiKey) {
        return res.status(500).json({ error: 'Missing FOOTBALL_DATA_API_KEY' });
    }

    try {
        // Fetch United's recent matches
        const today = new Date().toISOString().split('T')[0];
        const response = await fetch(
            `https://api.football-data.org/v4/teams/${UNITED_TEAM_ID}/matches?status=FINISHED&dateFrom=2024-10-05&dateTo=${today}`,
            {
                headers: { 'X-Auth-Token': apiKey }
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            return res.status(response.status).json({
                error: 'football-data.org API error',
                details: errorText
            });
        }

        const data = await response.json();
        const matches = data.matches || [];

        // Sort by date (most recent first)
        matches.sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate));

        // Build form string (most recent first, then reverse for chronological display)
        const results = [];
        let currentStreak = 0;

        for (const match of matches) {
            const homeTeam = match.homeTeam.id;
            const homeGoals = match.score?.fullTime?.home ?? 0;
            const awayGoals = match.score?.fullTime?.away ?? 0;

            let result;
            if (homeTeam === UNITED_TEAM_ID) {
                // United played at home
                if (homeGoals > awayGoals) result = 'W';
                else if (homeGoals < awayGoals) result = 'L';
                else result = 'D';
            } else {
                // United played away
                if (awayGoals > homeGoals) result = 'W';
                else if (awayGoals < homeGoals) result = 'L';
                else result = 'D';
            }

            results.push({
                result,
                date: match.utcDate,
                opponent: homeTeam === UNITED_TEAM_ID ? match.awayTeam.name : match.homeTeam.name,
                score: `${homeGoals}-${awayGoals}`,
                home: homeTeam === UNITED_TEAM_ID
            });
        }

        // Calculate current win streak (from most recent)
        for (const r of results) {
            if (r.result === 'W') {
                currentStreak++;
            } else {
                break; // Streak broken
            }
        }

        // Check if they've achieved 5 in a row
        const hasWon5 = currentStreak >= 5;

        // Form string (last 5 games, most recent first)
        const formString = results.slice(0, 5).map(r => r.result).join('');

        return res.status(200).json({
            hasWon5,
            currentStreak,
            form: formString,
            recentMatches: results.slice(0, 5),
            lastUpdated: new Date().toISOString()
        });

    } catch (error) {
        console.error('United API error:', error);
        return res.status(500).json({
            error: 'Failed to fetch United data',
            details: error.message
        });
    }
}
