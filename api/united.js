

// Manchester United team ID in football-data.org
const UNITED_TEAM_ID = 66;
const UNITED_COMPETITION = 'PL'; // Premier League
const START_DATE = '2024-10-05';
const MAX_WINDOW_DAYS = 700; // football-data.org enforces a strict 750-day max period

// Cache completed historical windows in warm serverless instances
const historicalMatchesCache = new Map();

function buildDateWindows(startDateStr, endDateStr, maxDays = MAX_WINDOW_DAYS) {
    const windows = [];
    const start = new Date(`${startDateStr}T00:00:00Z`);
    const end = new Date(`${endDateStr}T00:00:00Z`);
    const dayMs = 24 * 60 * 60 * 1000;

    let cursor = start;
    while (cursor <= end) {
        const maxEnd = new Date(cursor.getTime() + (maxDays - 1) * dayMs);
        const windowEnd = maxEnd < end ? maxEnd : end;
        const from = cursor.toISOString().split('T')[0];
        const to = windowEnd.toISOString().split('T')[0];
        windows.push({
            from,
            to,
            isHistorical: windowEnd < end
        });
        cursor = new Date(windowEnd.getTime() + dayMs);
    }
    return windows;
}

async function fetchUnitedMatches(apiKey, today) {
    const windows = buildDateWindows(START_DATE, today);
    const matchMap = new Map();

    for (const win of windows) {
        const cacheKey = `${UNITED_TEAM_ID}:${win.from}:${win.to}`;
        if (win.isHistorical && historicalMatchesCache.has(cacheKey)) {
            for (const m of historicalMatchesCache.get(cacheKey)) {
                matchMap.set(m.id, m);
            }
            continue;
        }

        const response = await fetch(
            `https://api.football-data.org/v4/teams/${UNITED_TEAM_ID}/matches?status=FINISHED&dateFrom=${win.from}&dateTo=${win.to}`,
            {
                headers: { 'X-Auth-Token': apiKey }
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            return {
                ok: false,
                status: response.status,
                errorText
            };
        }

        const data = await response.json();
        const windowMatches = data.matches || [];
        if (win.isHistorical) {
            historicalMatchesCache.set(cacheKey, windowMatches);
        }
        for (const m of windowMatches) {
            matchMap.set(m.id, m);
        }
    }

    return {
        ok: true,
        matches: Array.from(matchMap.values())
    };
}

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
        // Fetch United's matches since Oct 5, 2024 in <=700-day chunks
        const today = new Date().toISOString().split('T')[0];
        const fetchResult = await fetchUnitedMatches(apiKey, today);

        if (!fetchResult.ok) {
            return res.status(fetchResult.status).json({
                error: 'football-data.org API error',
                details: fetchResult.errorText
            });
        }

        const matches = fetchResult.matches;

        // Sort by date (most recent first)
        matches.sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate));

        // Build results (most recent first)
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
                opponentId: homeTeam === UNITED_TEAM_ID ? match.awayTeam.id : match.homeTeam.id,
                opponentTla: homeTeam === UNITED_TEAM_ID ? match.awayTeam.tla : match.homeTeam.tla,
                opponentCrest: homeTeam === UNITED_TEAM_ID ? match.awayTeam.crest : match.homeTeam.crest,
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

        // Calculate BEST (longest) win streak chronologically since Frank's vow
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

        // Get details about the best streak (the matches that formed it, in chronological order)
        let bestStreakDetails = null;
        if (bestStreak > 0 && bestStreakEndIndex !== -1) {
            const startIndex = bestStreakEndIndex - bestStreak + 1;
            const streakMatches = chronological.slice(startIndex, bestStreakEndIndex + 1);

            bestStreakDetails = {
                length: bestStreak,
                startDate: streakMatches[0]?.date,
                endDate: streakMatches[streakMatches.length - 1]?.date,
                matches: streakMatches.map(m => ({
                    opponent: m.opponent,
                    opponentId: m.opponentId,
                    opponentTla: m.opponentTla,
                    opponentCrest: m.opponentCrest,
                    score: m.score,
                    date: m.date,
                    home: m.home
                }))
            };
        }

        // Check if they've achieved 5 in a row at any point since the vow
        const hasWon5 = bestStreak >= 5 || currentStreak >= 5;

        // Form string (last 5 games, chronological left-to-right so most recent is on the right, or newest first)
        const formString = results.slice(0, 5).map(r => r.result).join('');

        return res.status(200).json({
            hasWon5,
            achievementDate,
            currentStreak,
            bestStreak,
            bestStreakDetails,
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
