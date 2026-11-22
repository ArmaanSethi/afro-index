import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT,
  createMockSupabaseServer,
  installMockFetch,
  invokeHandler,
  makeStreakMatches,
  withEnv,
  importFresh,
} from './helpers.mjs';

const MAN_UTD = {
  id: 66,
  name: 'Manchester United FC',
  shortName: 'Man United',
  tla: 'MUN',
  crest: 'https://crests.football-data.org/66.png',
};

const ARSENAL = {
  id: 57,
  name: 'Arsenal FC',
  shortName: 'Arsenal',
  tla: 'ARS',
  crest: 'https://crests.football-data.org/57.png',
};

const LIVERPOOL = {
  id: 64,
  name: 'Liverpool FC',
  shortName: 'Liverpool',
  tla: 'LIV',
  crest: 'https://crests.football-data.org/64.png',
};

describe('Tier 1 — API, DB Schema & Config Happy Paths (F1–F6, F15)', () => {
  let mockSupa;

  before(async () => {
    mockSupa = await createMockSupabaseServer();
  });

  after(async () => {
    await mockSupa.close();
  });

  beforeEach(() => {
    mockSupa.reset();
  });

  it('F1: supabase-setup.sql is executable SQL with streak_achieved_date, NOT NULL unique keys, and service_role-only write RLS', () => {
    const sqlPath = path.join(REPO_ROOT, 'supabase-setup.sql');
    assert.ok(fs.existsSync(sqlPath), 'supabase-setup.sql must exist');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    // Pure executable SQL (no markdown fences or markdown headings)
    assert.doesNotMatch(sql, /```/, 'supabase-setup.sql must not contain markdown code fences');
    assert.doesNotMatch(sql, /^#\s+/m, 'supabase-setup.sql must not contain markdown headings');

    // teams table columns & NOT NULL unique key
    assert.match(sql, /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?teams\b/i);
    assert.match(sql, /streak_achieved_date\s+DATE/i, 'teams must define streak_achieved_date DATE');
    assert.match(sql, /team_id\s+(?:INT|INTEGER)\s+NOT\s+NULL/i, 'team_id must be NOT NULL');
    assert.match(sql, /league_id\s+TEXT\s+NOT\s+NULL/i, 'league_id must be NOT NULL');
    assert.match(sql, /sport\s+TEXT\s+NOT\s+NULL/i, 'sport must be NOT NULL');
    assert.match(sql, /UNIQUE\s*\(\s*team_id\s*,\s*league_id\s*,\s*sport\s*\)/i, 'teams must have UNIQUE(team_id, league_id, sport)');

    // scan_log table
    assert.match(sql, /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?scan_log\b/i);
    assert.match(sql, /teams_scanned/i);
    assert.match(sql, /teams_qualified/i);
    assert.match(sql, /scanned_at/i);

    // RLS enabled on both tables
    assert.match(sql, /ALTER\s+TABLE\s+(?:public\.)?teams\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    assert.match(sql, /ALTER\s+TABLE\s+(?:public\.)?scan_log\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);

    // Extract every CREATE POLICY statement and verify INSERT/UPDATE restrict TO service_role
    const policies = sql.match(/CREATE\s+POLICY[\s\S]*?;/gi) || [];
    assert.ok(policies.length >= 4, `Expected at least 4 RLS policies, found ${policies.length}`);

    const writePolicies = policies.filter((p) => /\bFOR\s+(?:INSERT|UPDATE|ALL)\b/i.test(p));
    assert.ok(writePolicies.length >= 2, 'Expected INSERT/UPDATE policies for teams and scan_log');
    for (const policy of writePolicies) {
      assert.match(
        policy,
        /\bTO\s+service_role\b/i,
        `Write RLS policy must be restricted TO service_role:\n${policy}`,
      );
    }

    const selectPolicies = policies.filter((p) => /\bFOR\s+SELECT\b/i.test(p));
    assert.ok(selectPolicies.length >= 2, 'Expected public SELECT policies for teams and scan_log');
  });

  it('F2/F3: GET /api/teams returns sorted winners, counts, latest recentScans, CORS, and 200 Cache-Control', async () => {
    mockSupa.db.teams.push(
      {
        id: '1',
        team_id: 57,
        sport: 'football',
        name: 'Arsenal FC',
        logo: 'https://crests.football-data.org/57.png',
        country_name: 'England',
        country_flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
        league_id: 'PL',
        league_name: 'Premier League',
        form: 'WWWWW',
        has_5_wins: true,
        max_streak: 6,
        streak_achieved_date: '2025-02-10',
        first_detected: '2025-02-10T18:00:00Z',
        last_checked: '2025-03-01T12:00:00Z',
      },
      {
        id: '2',
        team_id: 64,
        sport: 'football',
        name: 'Liverpool FC',
        logo: 'https://crests.football-data.org/64.png',
        country_name: 'England',
        country_flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
        league_id: 'PL',
        league_name: 'Premier League',
        form: 'WWWWW',
        has_5_wins: true,
        max_streak: 7,
        streak_achieved_date: '2024-11-20',
        first_detected: '2024-11-20T18:00:00Z',
        last_checked: '2025-03-01T12:00:00Z',
      },
      {
        id: '3',
        team_id: 65,
        sport: 'football',
        name: 'Chelsea FC',
        logo: 'https://crests.football-data.org/61.png',
        country_name: 'England',
        country_flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
        league_id: 'PL',
        league_name: 'Premier League',
        form: 'WLDWL',
        has_5_wins: false,
        max_streak: 3,
        streak_achieved_date: null,
        first_detected: '2024-11-20T18:00:00Z',
        last_checked: '2025-03-01T12:00:00Z',
      },
    );

    mockSupa.db.scan_log.push(
      { id: 's1', sport: 'football', league_id: 'PL', league_name: 'Premier League', teams_scanned: 20, teams_qualified: 2, scanned_at: '2025-03-01T10:00:00Z' },
      { id: 's2', sport: 'football', league_id: 'PL', league_name: 'Premier League', teams_scanned: 20, teams_qualified: 2, scanned_at: '2025-03-01T12:00:00Z' },
      { id: 's3', sport: 'football', league_id: 'PD', league_name: 'La Liga', teams_scanned: 20, teams_qualified: 1, scanned_at: '2025-03-01T11:00:00Z' },
    );

    await withEnv(
      { SUPABASE_URL: mockSupa.url, SUPABASE_SERVICE_KEY: 'test-service-key' },
      async () => {
        const handler = await importFresh('api/teams.js');
        const res = await invokeHandler(handler, { method: 'GET' });

        assert.equal(res.status, 200);
        assert.equal(res.headers['access-control-allow-origin'], '*');
        assert.match(String(res.headers['cache-control'] || ''), /s-maxage=60/);

        assert.equal(res.body.success, true);
        assert.equal(res.body.winnersCount, 2);
        assert.equal(res.body.totalScanned, 3);
        assert.equal(res.body.leaguesScanned, 2);
        assert.equal(res.body.teams.length, 2);
        assert.equal(res.body.teams[0].team_id, 64, 'Earlier streak_achieved_date should come first');
        assert.equal(res.body.teams[1].team_id, 57);
        assert.equal(res.body.recentScans.length, 2, 'recentScans should have 1 latest entry per league');
        const plScan = res.body.recentScans.find((s) => s.league_id === 'PL');
        assert.equal(plScan.scanned_at, '2025-03-01T12:00:00Z');
      },
    );
  });

  it('F4: GET /api/united returns all-competitions streak data for both <5 and >=5 win runs', async () => {
    // Subtest A: 3-win best streak, 2-win current streak
    const matchesSub5 = makeStreakMatches({
      team: MAN_UTD,
      startDate: '2025-01-01',
      stepDays: 4,
      results: ['W', 'W', 'W', 'L', 'W', 'W'],
      idStart: 2000,
    });

    const mockFetch1 = installMockFetch((call) => {
      assert.equal(call.pathname, '/v4/teams/66/matches');
      assert.equal(call.searchParams.get('competitions'), null, 'Must query all competitions without competitions=PL filter');
      const from = call.searchParams.get('dateFrom');
      const to = call.searchParams.get('dateTo');
      const inRange = matchesSub5.filter((m) => {
        const d = m.utcDate.slice(0, 10);
        return (!from || d >= from) && (!to || d <= to);
      });
      return { status: 200, body: { matches: inRange } };
    });

    try {
      await withEnv({ FOOTBALL_DATA_API_KEY: 'test-fd-key' }, async () => {
        const handler = await importFresh('api/united.js');
        const res = await invokeHandler(handler, { method: 'GET' });

        assert.equal(res.status, 200);
        assert.equal(res.headers['access-control-allow-origin'], '*');
        assert.match(String(res.headers['cache-control'] || ''), /s-maxage=60/);

        assert.equal(res.body.scope, 'all_competitions');
        assert.equal(res.body.hasWon5, false);
        assert.equal(res.body.achievementDate, null);
        assert.equal(res.body.currentStreak, 2);
        assert.equal(res.body.bestStreak, 3);
        assert.equal(res.body.bestStreakDetails.length, 3);
        assert.equal(res.body.form.length, 5);
        assert.ok(Array.isArray(res.body.recentMatches) && res.body.recentMatches.length <= 5);
        assert.ok(!Number.isNaN(Date.parse(res.body.lastUpdated)), 'lastUpdated must be a valid ISO timestamp');
      });
    } finally {
      mockFetch1.restore();
    }

    // Subtest B: 5-win achievement
    const matchesWin5 = makeStreakMatches({
      team: MAN_UTD,
      startDate: '2025-02-01',
      stepDays: 3,
      results: ['W', 'W', 'W', 'W', 'W'],
      idStart: 3000,
    });
    const expected5thDate = matchesWin5[4].utcDate;

    const mockFetch2 = installMockFetch((call) => {
      const from = call.searchParams.get('dateFrom');
      const to = call.searchParams.get('dateTo');
      const inRange = matchesWin5.filter((m) => {
        const d = m.utcDate.slice(0, 10);
        return (!from || d >= from) && (!to || d <= to);
      });
      return { status: 200, body: { matches: inRange } };
    });

    try {
      await withEnv({ FOOTBALL_DATA_API_KEY: 'test-fd-key' }, async () => {
        const handler = await importFresh('api/united.js');
        const res = await invokeHandler(handler, { method: 'GET' });

        assert.equal(res.status, 200);
        assert.equal(res.body.hasWon5, true);
        assert.ok(res.body.achievementDate, 'achievementDate must be populated on 5-win streak');
        assert.equal(
          String(res.body.achievementDate).slice(0, 10),
          expected5thDate.slice(0, 10),
          'achievementDate must match the 5th win date',
        );
        assert.equal(res.body.bestStreak, 5);
      });
    } finally {
      mockFetch2.restore();
    }
  });

  it('F5: GET /api/scan auto-scans highest-priority league and supports authorized ?competition= override', async () => {
    const plMatches = makeStreakMatches({
      team: ARSENAL,
      startDate: '2025-01-01',
      stepDays: 4,
      results: ['W', 'W', 'W', 'W', 'W'],
      idStart: 4000,
    });
    const pdMatches = makeStreakMatches({
      team: LIVERPOOL,
      startDate: '2025-01-01',
      stepDays: 4,
      results: ['W', 'W', 'L', 'W', 'W'],
      idStart: 5000,
      competition: { id: 2014, name: 'La Liga', code: 'PD' },
    });

    const mockFetch = installMockFetch((call) => {
      const from = call.searchParams.get('dateFrom');
      const to = call.searchParams.get('dateTo');
      const source = call.pathname.includes('/competitions/PL/')
        ? plMatches
        : call.pathname.includes('/competitions/PD/')
          ? pdMatches
          : [];
      const inRange = source.filter((m) => {
        const d = m.utcDate.slice(0, 10);
        return (!from || d >= from) && (!to || d <= to);
      });
      return { status: 200, body: { matches: inRange } };
    });

    try {
      await withEnv(
        {
          SUPABASE_URL: mockSupa.url,
          SUPABASE_SERVICE_KEY: 'test-service-key',
          FOOTBALL_DATA_API_KEY: 'test-fd-key',
          CRON_SECRET: 'super-secret-cron',
        },
        async () => {
          const handler = await importFresh('api/scan.js');

          // 1. Public auto-scan on empty scan_log -> selects PL
          const autoRes = await invokeHandler(handler, { method: 'GET' });
          assert.equal(autoRes.status, 200);
          assert.equal(autoRes.body.success, true);
          assert.ok(mockSupa.db.teams.length > 0, 'Auto-scan must upsert teams into DB');
          assert.ok(mockSupa.db.scan_log.some((s) => s.league_id === 'PL'), 'Auto-scan must log PL scan');
          const arsenalRow = mockSupa.db.teams.find((t) => t.team_id === 57 && t.league_id === 'PL');
          assert.ok(arsenalRow, 'Arsenal must be persisted');
          assert.equal(arsenalRow.has_5_wins, true);
          assert.match(String(autoRes.headers['cache-control'] || ''), /no-store/i);

          // 2. Authorized manual override ?competition=PD
          const overrideRes = await invokeHandler(handler, {
            method: 'GET',
            query: { competition: 'PD' },
            headers: { authorization: 'Bearer super-secret-cron' },
          });
          assert.equal(overrideRes.status, 200);
          assert.equal(overrideRes.body.success, true);
          assert.ok(mockSupa.db.scan_log.some((s) => s.league_id === 'PD'), 'Manual override must log PD scan');
          assert.match(String(overrideRes.headers['cache-control'] || ''), /no-store/i);
        },
      );
    } finally {
      mockFetch.restore();
    }
  });

  it('F6: GET /api/scan-all scans eligible competitions when authorized with CRON_SECRET and returns no-store', async () => {
    const plMatches = makeStreakMatches({
      team: ARSENAL,
      startDate: '2025-01-01',
      stepDays: 4,
      results: ['W', 'W', 'W', 'W', 'W'],
      idStart: 6000,
    });

    const mockFetch = installMockFetch((call) => {
      const from = call.searchParams.get('dateFrom');
      const to = call.searchParams.get('dateTo');
      const inRange = call.pathname.includes('/competitions/PL/')
        ? plMatches.filter((m) => {
            const d = m.utcDate.slice(0, 10);
            return (!from || d >= from) && (!to || d <= to);
          })
        : [];
      return { status: 200, body: { matches: inRange } };
    });

    try {
      await withEnv(
        {
          SUPABASE_URL: mockSupa.url,
          SUPABASE_SERVICE_KEY: 'test-service-key',
          FOOTBALL_DATA_API_KEY: 'test-fd-key',
          CRON_SECRET: 'cron-secret-123',
        },
        async () => {
          const handler = await importFresh('api/scan-all.js');
          const res = await invokeHandler(handler, {
            method: 'GET',
            headers: { authorization: 'Bearer cron-secret-123' },
          });

          assert.equal(res.status, 200);
          assert.equal(res.body.success, true);
          assert.ok(res.body.leaguesScanned > 0, 'scan-all must scan at least one league');
          assert.ok(mockSupa.db.scan_log.length > 0, 'scan-all must write scan_log entries');
          assert.match(String(res.headers['cache-control'] || ''), /no-store/i);
        },
      );
    } finally {
      mockFetch.restore();
    }
  });

  it('F15: vercel.json defines immutable font caching & security headers, .gitignore exists, and redundant assets are removed', () => {
    const vercelPath = path.join(REPO_ROOT, 'vercel.json');
    assert.ok(fs.existsSync(vercelPath), 'vercel.json must exist');
    const vercel = JSON.parse(fs.readFileSync(vercelPath, 'utf8'));

    assert.ok(Array.isArray(vercel.headers) && vercel.headers.length > 0, 'vercel.json must define headers array');

    const fontRule = vercel.headers.find((h) => String(h.source || '').includes('/fonts/'));
    assert.ok(fontRule, 'vercel.json must have a /fonts/ caching header rule');
    const fontCache = (fontRule.headers || []).find((h) => h.key.toLowerCase() === 'cache-control');
    assert.ok(fontCache, 'Font header rule must include Cache-Control');
    assert.match(fontCache.value, /max-age=31536000/);
    assert.match(fontCache.value, /immutable/);

    const globalRule = vercel.headers.find((h) => h.source === '/(.*)' || h.source === '/:path*');
    assert.ok(globalRule, 'vercel.json must define a global security headers rule');
    const secMap = new Map((globalRule.headers || []).map((h) => [h.key.toLowerCase(), h.value]));
    assert.equal(secMap.get('x-content-type-options'), 'nosniff');
    assert.ok(secMap.has('x-frame-options'), 'Missing X-Frame-Options security header');
    assert.ok(secMap.has('referrer-policy'), 'Missing Referrer-Policy security header');

    // .gitignore hygiene
    const gitignorePath = path.join(REPO_ROOT, '.gitignore');
    assert.ok(fs.existsSync(gitignorePath), '.gitignore must exist');
    const gitignore = fs.readFileSync(gitignorePath, 'utf8');
    assert.match(gitignore, /node_modules/);
    assert.match(gitignore, /\.DS_Store/);
    assert.match(gitignore, /\.env/);
    assert.match(gitignore, /\.vercel/);

    // Redundant Inter font copies & root og_image.jpeg removed (T1-SEO-12 & T1-SEO-13)
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'public/og_image.jpeg')), 'public/og_image.jpeg must exist');
    assert.ok(!fs.existsSync(path.join(REPO_ROOT, 'og_image.jpeg')), 'Duplicate root og_image.jpeg must be removed');
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'public/fonts/inter-400.woff2')), 'public/fonts/inter-400.woff2 must exist');
    assert.ok(!fs.existsSync(path.join(REPO_ROOT, 'public/fonts/inter-600.woff2')), 'Redundant inter-600.woff2 must be removed');
    assert.ok(!fs.existsSync(path.join(REPO_ROOT, 'public/fonts/inter-700.woff2')), 'Redundant inter-700.woff2 must be removed');
    assert.ok(!fs.existsSync(path.join(REPO_ROOT, 'public/fonts/inter-900.woff2')), 'Redundant inter-900.woff2 must be removed');

    // Single Inter @font-face variable range in src/input.css and public/output.css
    const inputCss = fs.readFileSync(path.join(REPO_ROOT, 'src/input.css'), 'utf8');
    const outputCss = fs.readFileSync(path.join(REPO_ROOT, 'public/output.css'), 'utf8');
    const interFacesInput = inputCss.match(/@font-face\s*\{[^}]*font-family:\s*['"]?Inter['"]?[^}]*\}/gi) || [];
    assert.equal(interFacesInput.length, 1, `Expected 1 Inter @font-face in src/input.css, found ${interFacesInput.length}`);
    assert.match(interFacesInput[0], /font-weight:\s*100\s+900/i);
    assert.match(outputCss, /font-weight:\s*100\s+900/i);
  });
});
