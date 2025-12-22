import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Missing Supabase configuration' });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // Get teams with 5+ wins (for display), sorted by earliest achievement date
    const { data: winners, error: winnersError } = await supabase
      .from('teams')
      .select('*')
      .eq('has_5_wins', true)
      .order('streak_achieved_date', { ascending: true, nullsFirst: false });

    if (winnersError) throw winnersError;

    // Get total teams scanned (for stats)
    const { count: totalScanned } = await supabase
      .from('teams')
      .select('*', { count: 'exact', head: true });

    // Get scan log for league coverage (most recent scan per league)
    const { data: allScans } = await supabase
      .from('scan_log')
      .select('*')
      .order('scanned_at', { ascending: false })
      .limit(100);

    // Keep only most recent scan per league
    const seenLeagues = new Set();
    const scanLog = (allScans || []).filter(scan => {
      if (seenLeagues.has(scan.league_id)) return false;
      seenLeagues.add(scan.league_id);
      return true;
    });

    // Count unique leagues scanned (get unique league_ids)
    const { data: uniqueLeagues } = await supabase
      .from('scan_log')
      .select('league_id')
      .limit(100);

    const uniqueLeagueIds = new Set(uniqueLeagues?.map(l => l.league_id) || []);

    return res.status(200).json({
      success: true,
      winnersCount: winners?.length || 0,
      totalScanned: totalScanned || 0,
      leaguesScanned: uniqueLeagueIds.size,
      teams: winners || [],
      recentScans: scanLog || []
    });

  } catch (error) {
    console.error('Fetch teams error:', error);
    return res.status(500).json({ error: 'Failed to fetch teams', details: error.message });
  }
}
