import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
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

describe('Tier 2 — API Boundaries, Security, Edge Cases & Error Paths', () => {
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

  it('Null scores are skipped (not coerced to 0-0 draw) and penalty shootouts use score.winner across united/scan', async () => {
    // 3 wins, 1 NULL score (must be skipped!), 1 penalty shootout win (must count as W!), 1 regular win => 5-win streak!
    const matches = makeStreakMatches({
      team: MAN_UTD,
      startDate: '2025-01-01',
      stepDays: 4,
      results: ['W', 'W', 'W', 'NULL', 'PEN_W', 'W'],
      idStart: 10000,
    });

    const mockFetch = installMockFetch((call) => {
      const from = call.searchParams.get('dateFrom');
      const to = call.searchParams.get('dateTo');
      const inRange = matches.filter((m) => {
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
          CRON_SECRET: 'secret',
        },
        async () => {
          // Verify /api/united
          const unitedHandler = await importFresh('api/united.js');
          const uRes = await invokeHandler(unitedHandler, { method: 'GET' });
          assert.equal(uRes.status, 200);
          assert.equal(uRes.body.hasWon5, true, 'Null score must not break streak and PEN_W must count as W');
          assert.equal(uRes.body.bestStreak, 5);
          assert.equal(uRes.body.currentStreak, 5);
          assert.equal(uRes.body.form, 'WWWWW');

          // Verify /api/scan
          const scanHandler = await importFresh('api/scan.js');
          const sRes = await invokeHandler(scanHandler, {
            method: 'GET',
            query: { competition: 'PL' },
            headers: { authorization: 'Bearer secret' },
          });
          assert.equal(sRes.status, 200);
          const utdRow = mockSupa.db.teams.find((t) => t.team_id === 66 && t.league_id === 'PL');
          assert.ok(utdRow, 'Team 66 must be stored by scan');
          assert.equal(utdRow.has_5_wins, true, 'scan must skip null scores and credit penalty shootout wins');
          assert.equal(utdRow.max_streak, 5);
        },
      );
    } finally {
      mockFetch.restore();
    }
  });

  it('Midnight UTC 2-day historical cache buffer prevents prematurely freezing recent windows in /api/united', async (t) => {
    const mockFetch = installMockFetch(() => ({ status: 200, body: { matches: [] } }));

    try {
      await withEnv({ FOOTBALL_DATA_API_KEY: 'test-fd-key' }, async () => {
        // Freeze Date ONLY (never timers, so HTTP/undici works normally)
        // 700 days after 2024-10-05 is 2026-09-05 (window 1 ends 2026-09-04, only 1 day before today)
        t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-05T00:05:00Z') });

        const unitedHandler = await importFresh('api/united.js');

        // Call 1
        const r1 = await invokeHandler(unitedHandler, { method: 'GET' });
        assert.equal(r1.status, 200);
        const callsAfterFirst = mockFetch.calls.length;
        assert.ok(callsAfterFirst >= 2, `Expected >=2 window fetches at 2026-09-05, got ${callsAfterFirst}`);

        // Call 2 at same timestamp: window 1 ended only 1 day ago (<2-day buffer), so it MUST be re-fetched
        const r2 = await invokeHandler(unitedHandler, { method: 'GET' });
        assert.equal(r2.status, 200);
        const callsInSecond = mockFetch.calls.length - callsAfterFirst;
        assert.equal(
          callsInSecond,
          callsAfterFirst,
          'Window ending within 2 days of today must NOT be cached as historical',
        );

        // Advance clock to 2026-09-08T00:05:00Z (window 1 ended 4 days ago >= 2-day buffer)
        t.mock.timers.setTime(Date.parse('2026-09-08T00:05:00Z'));

        // Call 3 populates historical cache for window 1
        const before3 = mockFetch.calls.length;
        const r3 = await invokeHandler(unitedHandler, { method: 'GET' });
        assert.equal(r3.status, 200);
        const callsInThird = mockFetch.calls.length - before3;

        // Call 4 should serve window 1 from cache and only fetch the current window
        const before4 = mockFetch.calls.length;
        const r4 = await invokeHandler(unitedHandler, { method: 'GET' });
        assert.equal(r4.status, 200);
        const callsInFourth = mockFetch.calls.length - before4;
        assert.ok(
          callsInFourth < callsInThird,
          `Expected cached historical window after 2-day buffer (call 3=${callsInThird}, call 4=${callsInFourth})`,
        );
      });
    } finally {
      t.mock.timers.reset();
      mockFetch.restore();
    }
  });

  it('GET /api/scan rejects ?competition= path injection, array params, unknown codes (400), and unauthorized overrides (401)', async () => {
    const mockFetch = installMockFetch(() => ({ status: 200, body: { matches: [] } }));

    try {
      await withEnv(
        {
          SUPABASE_URL: mockSupa.url,
          SUPABASE_SERVICE_KEY: 'test-service-key',
          FOOTBALL_DATA_API_KEY: 'test-fd-key',
          CRON_SECRET: 'secret-token',
        },
        async () => {
          const handler = await importFresh('api/scan.js');

          // 1. Path injection
          const injRes = await invokeHandler(handler, {
            method: 'GET',
            query: { competition: '../../teams/66' },
            headers: { authorization: 'Bearer secret-token' },
          });
          assert.equal(injRes.status, 400, 'Path injection must return 400');

          // 2. Array param (?competition=PL&competition=PD)
          const arrRes = await invokeHandler(handler, {
            method: 'GET',
            query: { competition: ['PL', 'PD'] },
            headers: { authorization: 'Bearer secret-token' },
          });
          assert.equal(arrRes.status, 400, 'Array ?competition= must return 400, not 500 TypeError');

          // 3. Unknown code
          const unkRes = await invokeHandler(handler, {
            method: 'GET',
            query: { competition: 'XYZ' },
            headers: { authorization: 'Bearer secret-token' },
          });
          assert.equal(unkRes.status, 400, 'Unknown competition code must return 400');

          // 4. Valid code but missing Authorization header
          const unauth1 = await invokeHandler(handler, {
            method: 'GET',
            query: { competition: 'PL' },
          });
          assert.equal(unauth1.status, 401, 'Missing Authorization on manual override must return 401');

          // 5. Valid code with wrong Authorization header
          const unauth2 = await invokeHandler(handler, {
            method: 'GET',
            query: { competition: 'PL' },
            headers: { authorization: 'Bearer wrong-token' },
          });
          assert.equal(unauth2.status, 401, 'Wrong Authorization on manual override must return 401');

          assert.equal(mockFetch.calls.length, 0, 'Rejected requests must make zero upstream football-data.org calls');
        },
      );
    } finally {
      mockFetch.restore();
    }
  });

  it('GET /api/scan-all enforces CRON_SECRET auth (401 + no-store)', async () => {
    const mockFetch = installMockFetch(() => ({ status: 200, body: { matches: [] } }));
    try {
      await withEnv(
        {
          SUPABASE_URL: mockSupa.url,
          SUPABASE_SERVICE_KEY: 'test-service-key',
          FOOTBALL_DATA_API_KEY: 'test-fd-key',
          CRON_SECRET: 'cron-secret-xyz',
        },
        async () => {
          const handler = await importFresh('api/scan-all.js');

          const missingAuth = await invokeHandler(handler, { method: 'GET' });
          assert.equal(missingAuth.status, 401);
          assert.match(String(missingAuth.headers['cache-control'] || ''), /no-store/i);

          const badAuth = await invokeHandler(handler, {
            method: 'GET',
            headers: { authorization: 'Bearer nope' },
          });
          assert.equal(badAuth.status, 401);
          assert.match(String(badAuth.headers['cache-control'] || ''), /no-store/i);

          assert.equal(mockFetch.calls.length, 0);
        },
      );
    } finally {
      mockFetch.restore();
    }
  });

  it('All 4 API endpoints return 405 on POST/PUT/DELETE and proper CORS headers on OPTIONS', async () => {
    const routes = ['api/teams.js', 'api/united.js', 'api/scan.js', 'api/scan-all.js'];

    await withEnv(
      {
        SUPABASE_URL: mockSupa.url,
        SUPABASE_SERVICE_KEY: 'test-service-key',
        FOOTBALL_DATA_API_KEY: 'test-fd-key',
        CRON_SECRET: 'cron-secret',
      },
      async () => {
        for (const route of routes) {
          const handler = await importFresh(route);

          // OPTIONS preflight
          const optRes = await invokeHandler(handler, { method: 'OPTIONS' });
          assert.ok(optRes.status === 200 || optRes.status === 204, `${route} OPTIONS must return 200 or 204`);
          assert.equal(optRes.headers['access-control-allow-origin'], '*', `${route} OPTIONS must allow * origin`);
          assert.match(
            String(optRes.headers['access-control-allow-methods'] || ''),
            /GET/i,
            `${route} OPTIONS must include GET in Access-Control-Allow-Methods`,
          );
          if (route === 'api/scan-all.js' || route === 'api/scan.js') {
            assert.match(
              String(optRes.headers['access-control-allow-headers'] || ''),
              /Authorization/i,
              `${route} OPTIONS must allow Authorization header`,
            );
          }

          // Non-GET/OPTIONS methods -> 405
          for (const method of ['POST', 'PUT', 'DELETE']) {
            const mRes = await invokeHandler(handler, { method });
            assert.equal(mRes.status, 405, `${route} ${method} must return 405`);
            assert.match(String(mRes.headers['cache-control'] || ''), /no-store/i, `${route} 405 must be no-store`);
          }
        }
      },
    );
  });

  it('GET /api/scan-all stops on 429 rate limit and returns non-200 + success:false when leaguesScanned === 0', async () => {
    const mockFetch = installMockFetch(() => ({
      status: 429,
      body: { message: 'You reached your request limit.' },
    }));

    try {
      await withEnv(
        {
          SUPABASE_URL: mockSupa.url,
          SUPABASE_SERVICE_KEY: 'test-service-key',
          FOOTBALL_DATA_API_KEY: 'test-fd-key',
          CRON_SECRET: 'cron-secret',
        },
        async () => {
          const handler = await importFresh('api/scan-all.js');
          const res = await invokeHandler(handler, {
            method: 'GET',
            headers: { authorization: 'Bearer cron-secret' },
          });

          assert.notEqual(res.status, 200, 'scan-all must NOT return 200 when 429 prevents scanning any league');
          assert.equal(res.body.success, false);
          assert.equal(res.body.leaguesScanned, 0);
          assert.match(String(res.headers['cache-control'] || ''), /no-store/i);
          assert.ok(
            mockFetch.calls.length <= 2,
            `scan-all must stop immediately on 429 instead of hammering all leagues (made ${mockFetch.calls.length} calls)`,
          );
        },
      );
    } finally {
      mockFetch.restore();
    }
  });

  it('GET /api/scan avoids priority-league cooldown starvation when minor league is within its 60m cooldown', async () => {
    const now = Date.now();
    const min = 60 * 1000;
    const allCodes = ['PL', 'PD', 'BL1', 'SA', 'FL1', 'CL', 'DED', 'PPL', 'ELC', 'BSA', 'EC', 'WC'];

    // Seed every league so:
    // - BSA (minor, 60m cooldown) scanned 30m ago -> still in cooldown!
    // - PL (priority, 15m cooldown) scanned 20m ago -> ELIGIBLE!
    // - all others scanned 5m ago -> in cooldown
    for (const code of allCodes) {
      let ageMs = 5 * min;
      if (code === 'BSA') ageMs = 30 * min;
      if (code === 'PL') ageMs = 20 * min;
      mockSupa.db.scan_log.push({
        id: `seed-${code}`,
        sport: 'football',
        league_id: code,
        league_name: code,
        teams_scanned: 20,
        teams_qualified: 0,
        scanned_at: new Date(now - ageMs).toISOString(),
      });
    }

    const mockFetch = installMockFetch(() => ({ status: 200, body: { matches: [] } }));

    try {
      await withEnv(
        {
          SUPABASE_URL: mockSupa.url,
          SUPABASE_SERVICE_KEY: 'test-service-key',
          FOOTBALL_DATA_API_KEY: 'test-fd-key',
        },
        async () => {
          const handler = await importFresh('api/scan.js');
          const res = await invokeHandler(handler, { method: 'GET' });

          assert.equal(res.status, 200);
          assert.notEqual(res.body.skipped, true, 'Must NOT skip when priority league PL is past its 15m cooldown');
          assert.ok(
            mockFetch.calls.some((c) => c.pathname.includes('/competitions/PL/')),
            'Must select and scan PL rather than starving behind BSA',
          );
        },
      );
    } finally {
      mockFetch.restore();
    }
  });

  it('GET /api/teams accurately counts >100 scan_log rows without dropping older leagues', async () => {
    const now = Date.now();
    const min = 60 * 1000;

    // 5 older leagues (indices 146..150, older than the top 100 rows)
    const olderLeagues = ['SA', 'FL1', 'DED', 'PPL', 'BSA'];
    olderLeagues.forEach((code, idx) => {
      mockSupa.db.scan_log.push({
        id: `old-${code}`,
        sport: 'football',
        league_id: code,
        league_name: `League ${code}`,
        teams_scanned: 18,
        teams_qualified: 1,
        scanned_at: new Date(now - (500 + idx) * min).toISOString(),
      });
    });

    // 145 recent rows across PL, PD, BL1
    const recentLeagues = ['PL', 'PD', 'BL1'];
    for (let i = 0; i < 145; i++) {
      const code = recentLeagues[i % recentLeagues.length];
      mockSupa.db.scan_log.push({
        id: `rec-${i}`,
        sport: 'football',
        league_id: code,
        league_name: `League ${code}`,
        teams_scanned: 20,
        teams_qualified: 2,
        scanned_at: new Date(now - i * min).toISOString(),
      });
    }

    await withEnv(
      { SUPABASE_URL: mockSupa.url, SUPABASE_SERVICE_KEY: 'test-service-key' },
      async () => {
        const handler = await importFresh('api/teams.js');
        const res = await invokeHandler(handler, { method: 'GET' });

        assert.equal(res.status, 200);
        assert.equal(res.body.leaguesScanned, 8, 'Must count all 8 leagues beyond the 100-row scan_log cap');
        const returnedCodes = new Set(res.body.recentScans.map((s) => s.league_id));
        for (const code of [...recentLeagues, ...olderLeagues]) {
          assert.ok(returnedCodes.has(code), `recentScans must include ${code}`);
        }
      },
    );
  });

  it('Supabase & upstream errors propagate with non-200 status and Cache-Control: no-store (never swallowed)', async () => {
    // 1. /api/teams fails when Supabase returns 500
    mockSupa.setError((req) => (req.path === '/rest/v1/teams' ? { status: 500, message: 'DB down' } : null));
    await withEnv(
      { SUPABASE_URL: mockSupa.url, SUPABASE_SERVICE_KEY: 'test-service-key' },
      async () => {
        const teamsHandler = await importFresh('api/teams.js');
        const res = await invokeHandler(teamsHandler, { method: 'GET' });
        assert.equal(res.status, 500);
        assert.match(String(res.headers['cache-control'] || ''), /no-store/i);
      },
    );

    // 2. /api/scan fails when teams upsert returns 500 (must NOT insert scan_log or return 200)
    mockSupa.reset();
    mockSupa.setError((req) =>
      req.method === 'POST' && req.path === '/rest/v1/teams' ? { status: 500, message: 'Upsert failed' } : null,
    );
    const plMatches = makeStreakMatches({ team: ARSENAL, startDate: '2025-01-01', results: ['W', 'W', 'W', 'W', 'W'] });
    const mockFetch1 = installMockFetch(() => ({ status: 200, body: { matches: plMatches } }));
    try {
      await withEnv(
        {
          SUPABASE_URL: mockSupa.url,
          SUPABASE_SERVICE_KEY: 'test-service-key',
          FOOTBALL_DATA_API_KEY: 'test-fd-key',
          CRON_SECRET: 'secret',
        },
        async () => {
          const scanHandler = await importFresh('api/scan.js');
          const res = await invokeHandler(scanHandler, {
            method: 'GET',
            query: { competition: 'PL' },
            headers: { authorization: 'Bearer secret' },
          });
          assert.ok(res.status >= 500, `Expected 5xx on upsert failure, got ${res.status}`);
          assert.match(String(res.headers['cache-control'] || ''), /no-store/i);
          assert.equal(mockSupa.db.scan_log.length, 0, 'Must NOT insert scan_log when teams upsert fails');
        },
      );
    } finally {
      mockFetch1.restore();
    }

    // 3. /api/united propagates upstream 502 with Cache-Control: no-store
    const mockFetch2 = installMockFetch(() => ({ status: 502, body: { message: 'Bad Gateway' } }));
    try {
      await withEnv({ FOOTBALL_DATA_API_KEY: 'test-fd-key' }, async () => {
        const unitedHandler = await importFresh('api/united.js');
        const res = await invokeHandler(unitedHandler, { method: 'GET' });
        assert.ok(res.status >= 500, `Expected 5xx on upstream failure, got ${res.status}`);
        assert.match(String(res.headers['cache-control'] || ''), /no-store/i);
      });
    } finally {
      mockFetch2.restore();
    }

    // 4. Missing env vars return 500 + no-store
    await withEnv({ SUPABASE_URL: undefined, SUPABASE_SERVICE_KEY: undefined }, async () => {
      const teamsHandler = await importFresh('api/teams.js');
      const res = await invokeHandler(teamsHandler, { method: 'GET' });
      assert.equal(res.status, 500);
      assert.match(String(res.headers['cache-control'] || ''), /no-store/i);
    });
  });

  it('Non-destructive upsert in /api/scan preserves prior has_5_wins, max_streak, and earliest streak_achieved_date', async () => {
    // Pre-seed Arsenal with an earlier 6-win achievement
    mockSupa.db.teams.push({
      id: 'existing-arsenal',
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
      streak_achieved_date: '2025-01-15',
      first_detected: '2025-01-15T18:00:00Z',
      last_checked: '2025-01-16T12:00:00Z',
    });

    // Subsequent scan only returns 2 wins + 1 loss for Arsenal
    const partialMatches = makeStreakMatches({
      team: ARSENAL,
      startDate: '2025-03-01',
      stepDays: 4,
      results: ['W', 'W', 'L'],
      idStart: 12000,
    });

    const mockFetch = installMockFetch((call) => {
      const from = call.searchParams.get('dateFrom');
      const to = call.searchParams.get('dateTo');
      const inRange = partialMatches.filter((m) => {
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
          CRON_SECRET: 'secret',
        },
        async () => {
          const handler = await importFresh('api/scan.js');
          const res = await invokeHandler(handler, {
            method: 'GET',
            query: { competition: 'PL' },
            headers: { authorization: 'Bearer secret' },
          });
          assert.equal(res.status, 200);

          const row = mockSupa.db.teams.find((t) => t.team_id === 57 && t.league_id === 'PL');
          assert.ok(row);
          assert.equal(row.has_5_wins, true, 'Prior has_5_wins achievement must never be wiped');
          assert.ok(row.max_streak >= 6, `Prior max_streak (6) must be preserved, got ${row.max_streak}`);
          assert.equal(row.streak_achieved_date, '2025-01-15', 'Earliest streak_achieved_date must be preserved');
        },
      );
    } finally {
      mockFetch.restore();
    }
  });
});
