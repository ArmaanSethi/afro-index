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

const TEAM_X = {
  id: 500,
  name: 'Streak United FC',
  shortName: 'Streak Utd',
  tla: 'STR',
  crest: 'https://crests.football-data.org/500.png',
};

describe('Tier 4 — End-to-End Operational API Scenarios', () => {
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

  it('Multi-cycle cold start -> 429 rate-limit recovery -> 5-win streak achieved then subsequent loss retains achievement', async () => {
    // Phase state controlled per cycle
    let rateLimitAfterLeagues = 2;
    const leaguesAttemptedInCycle1 = new Set();
    let plResults = ['W', 'W', 'W', 'W', 'W'];

    // Use recent dates relative to today so Cycle 3's 6th-match loss is in the live window (not historical cache)
    const startMs = Date.now() - 24 * 86400000;
    const startDateStr = new Date(startMs).toISOString().slice(0, 10);
    const expected5thWinDate = new Date(Date.parse(`${startDateStr}T15:00:00Z`) + 4 * 4 * 86400000)
      .toISOString()
      .slice(0, 10);

    const buildPlMatches = () =>
      makeStreakMatches({
        team: TEAM_X,
        startDate: startDateStr,
        stepDays: 4,
        results: plResults,
        idStart: 40000,
        competition: { id: 2021, name: 'Premier League', code: 'PL' },
      });

    let cycle = 1;
    const cycle2Leagues = new Set();

    const mockFetch = installMockFetch((call) => {
      const m = /\/competitions\/([^/]+)\/matches/.exec(call.pathname);
      const code = m ? m[1] : 'UNKNOWN';

      if (cycle === 1) {
        if (!leaguesAttemptedInCycle1.has(code) && leaguesAttemptedInCycle1.size >= rateLimitAfterLeagues) {
          return { status: 429, body: { message: 'Rate limit reached' } };
        }
        leaguesAttemptedInCycle1.add(code);
      } else if (cycle === 2) {
        cycle2Leagues.add(code);
      }

      const from = call.searchParams.get('dateFrom');
      const to = call.searchParams.get('dateTo');
      const source = code === 'PL' ? buildPlMatches() : [];
      const inRange = source.filter((match) => {
        const d = match.utcDate.slice(0, 10);
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
          CRON_SECRET: 'cron-secret',
        },
        async () => {
          const scanAllHandler = await importFresh('api/scan-all.js');
          const scanHandler = await importFresh('api/scan.js');
          const teamsHandler = await importFresh('api/teams.js');

          // --- Cycle 1: Cold start + hits 429 on 3rd league ---
          const c1 = await invokeHandler(scanAllHandler, {
            method: 'GET',
            headers: { authorization: 'Bearer cron-secret' },
          });
          assert.equal(c1.status, 200, 'Partial progress (2 leagues scanned before 429) should succeed');
          assert.equal(c1.body.success, true);
          assert.equal(c1.body.leaguesScanned, 2);

          const t1 = await invokeHandler(teamsHandler, { method: 'GET' });
          assert.equal(t1.status, 200);
          assert.equal(t1.body.leaguesScanned, 2, 'GET /api/teams must immediately reflect the 2 persisted leagues');
          const cycle1Scanned = new Set(t1.body.recentScans.map((s) => s.league_id));
          assert.equal(cycle1Scanned.size, 2);

          // --- Cycle 2: Recovery resumes with unscanned leagues ---
          cycle = 2;
          const c2 = await invokeHandler(scanAllHandler, {
            method: 'GET',
            headers: { authorization: 'Bearer cron-secret' },
          });
          assert.equal(c2.status, 200);
          assert.ok(c2.body.leaguesScanned > 0, 'Cycle 2 must scan additional leagues');

          for (const scannedNow of cycle2Leagues) {
            assert.ok(
              !cycle1Scanned.has(scannedNow),
              `Cycle 2 should prioritize unscanned leagues first, not re-scan ${scannedNow}`,
            );
          }

          const t2 = await invokeHandler(teamsHandler, { method: 'GET' });
          assert.equal(t2.status, 200);
          assert.ok(
            t2.body.leaguesScanned > 2,
            `Expected leaguesScanned > 2 after recovery, got ${t2.body.leaguesScanned}`,
          );

          // --- Cycle 3: Team X achieves 5-win streak, then loses 6th match ---
          cycle = 3;
          const s3a = await invokeHandler(scanHandler, {
            method: 'GET',
            query: { competition: 'PL' },
            headers: { authorization: 'Bearer cron-secret' },
          });
          assert.equal(s3a.status, 200);

          const t3a = await invokeHandler(teamsHandler, { method: 'GET' });
          const teamXBefore = t3a.body.teams.find((t) => t.team_id === TEAM_X.id && t.league_id === 'PL');
          assert.ok(teamXBefore, 'Team X must appear in /api/teams after 5-win streak');
          assert.equal(teamXBefore.has_5_wins, true);
          assert.equal(teamXBefore.max_streak, 5);
          assert.equal(teamXBefore.streak_achieved_date, expected5thWinDate);

          // Team X now loses its 6th match
          plResults = ['W', 'W', 'W', 'W', 'W', 'L'];
          const s3b = await invokeHandler(scanHandler, {
            method: 'GET',
            query: { competition: 'PL' },
            headers: { authorization: 'Bearer cron-secret' },
          });
          assert.equal(s3b.status, 200);

          const t3b = await invokeHandler(teamsHandler, { method: 'GET' });
          const teamXAfter = t3b.body.teams.find((t) => t.team_id === TEAM_X.id && t.league_id === 'PL');
          assert.ok(teamXAfter, 'Team X must STILL appear in /api/teams after subsequent loss');
          assert.equal(teamXAfter.has_5_wins, true);
          assert.equal(teamXAfter.max_streak, 5);
          assert.equal(teamXAfter.streak_achieved_date, expected5thWinDate);
          assert.ok(
            String(teamXAfter.form || '').endsWith('L'),
            `Expected updated form ending in L, got ${teamXAfter.form}`,
          );
        },
      );
    } finally {
      mockFetch.restore();
    }
  });
});
