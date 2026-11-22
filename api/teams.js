import { createClient } from '@supabase/supabase-js';
import {
  handlePreflightAndMethod,
  setNoStore,
  setPublicCache,
} from './_lib/http.js';
import { fetchLatestScansByLeague } from './_lib/supabase.js';

const PAGE_SIZE = 1000;

export function createHandler(deps = {}) {
  const {
    getSupabase = (url, key) => createClient(url, key),
    env = process.env,
  } = deps;

  return async function handler(req, res) {
    if (handlePreflightAndMethod(req, res)) {
      return;
    }

    const supabaseUrl = env.SUPABASE_URL;
    const supabaseKey = env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      setNoStore(res);
      return res.status(500).json({ error: 'Missing Supabase configuration' });
    }

    const supabase = getSupabase(supabaseUrl, supabaseKey);

    try {
      // Paginate winners to avoid Supabase's implicit 1000-row cap
      const winners = [];
      let offset = 0;

      while (true) {
        const { data: page, error: winnersError } = await supabase
          .from('teams')
          .select('*')
          .eq('has_5_wins', true)
          .order('streak_achieved_date', { ascending: true, nullsFirst: false })
          .order('team_id', { ascending: true })
          .order('league_id', { ascending: true })
          .range(offset, offset + PAGE_SIZE - 1);

        if (winnersError) throw winnersError;
        if (!page || page.length === 0) break;

        winners.push(...page);
        if (page.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }

      // Get total teams scanned (for stats)
      const { count: totalScanned, error: countError } = await supabase
        .from('teams')
        .select('*', { count: 'exact', head: true });

      if (countError) throw countError;

      // Get latest scan per known league (immune to scan_log row count growth)
      const recentScans = await fetchLatestScansByLeague(supabase);

      setPublicCache(res, { sMaxAge: 60, staleWhileRevalidate: 300 });
      return res.status(200).json({
        success: true,
        winnersCount: winners.length,
        totalScanned: totalScanned ?? 0,
        leaguesScanned: recentScans.length,
        teams: winners,
        recentScans,
      });
    } catch (error) {
      console.error('Fetch teams error:', error);
      setNoStore(res);
      return res.status(500).json({
        error: 'Failed to fetch teams',
        details: error.message,
      });
    }
  };
}

export default createHandler();
