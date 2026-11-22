import { COMPETITIONS } from './football.js';

export async function fetchLatestScansByLeague(supabase, competitions = COMPETITIONS) {
  const results = await Promise.all(
    competitions.map((comp) =>
      supabase
        .from('scan_log')
        .select('league_id, league_name, teams_scanned, teams_qualified, scanned_at')
        .eq('league_id', comp.code)
        .order('scanned_at', { ascending: false })
        .limit(1)
    )
  );

  const latestScans = [];
  for (const { data, error } of results) {
    if (error) {
      throw error;
    }
    if (data && data.length > 0) {
      latestScans.push(data[0]);
    }
  }

  latestScans.sort(
    (a, b) => new Date(b.scanned_at).getTime() - new Date(a.scanned_at).getTime()
  );

  return latestScans;
}

export async function fetchExistingTeamsByLeague(supabase, leagueId, sport = 'football') {
  const { data, error } = await supabase
    .from('teams')
    .select('team_id, logo, has_5_wins, max_streak, streak_achieved_date, first_detected')
    .eq('league_id', leagueId)
    .eq('sport', sport);

  if (error) {
    throw error;
  }

  return new Map((data || []).map((row) => [row.team_id, row]));
}
