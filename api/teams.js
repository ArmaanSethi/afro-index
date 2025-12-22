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
    // Get teams with 5+ wins (for display), sorted by longest streak
    // Filter to only show teams scanned after the constraint fix (9:50 PM Dec 21, 2024)
    const cutoffTime = '2024-12-22T05:50:00Z'; // 9:50 PM PST = 5:50 AM UTC next day

    const { data: winners, error: winnersError } = await supabase
      .from('teams')
      .select('*')
      .eq('has_5_wins', true)
      .gte('last_checked', cutoffTime)
      .order('max_streak', { ascending: false });

    if (winnersError) throw winnersError;

    // Get total teams scanned (for stats)
    const { count: totalScanned } = await supabase
      .from('teams')
      .select('*', { count: 'exact', head: true });

    // Get scan log for league coverage
    const { data: scanLog } = await supabase
      .from('scan_log')
      .select('*')
      .order('scanned_at', { ascending: false })
      .limit(10);

    // Count unique leagues scanned
    const { count: leaguesScanned } = await supabase
      .from('scan_log')
      .select('*', { count: 'exact', head: true });

    return res.status(200).json({
      success: true,
      winnersCount: winners?.length || 0,
      totalScanned: totalScanned || 0,
      leaguesScanned: leaguesScanned || 0,
      teams: winners || [],
      recentScans: scanLog || []
    });

  } catch (error) {
    console.error('Fetch teams error:', error);
    return res.status(500).json({ error: 'Failed to fetch teams', details: error.message });
  }
}
