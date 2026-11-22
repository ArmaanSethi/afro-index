import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT,
  createMockSupabaseServer,
  installMockFetch,
  invokeHandler,
  makeMatch,
  makeStreakMatches,
  withEnv,
  importFresh,
} from './helpers.mjs';

const ARSENAL = { id: 57, name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS', crest: 'https://crests.football-data.org/57.png' };
const LIVERPOOL = { id: 64, name: 'Liverpool FC', shortName: 'Liverpool', tla: 'LIV', crest: 'https://crests.football-data.org/64.png' };
const CHELSEA = { id: 61, name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE', crest: 'https://crests.football-data.org/61.png' };
const SPURS = { id: 73, name: 'Tottenham Hotspur FC', shortName: 'Tottenham', tla: 'TOT', crest: 'https://crests.football-data.org/73.png' };

describe('Tier 3 — Multi-Component Combinations (API <-> DB & Config <-> Assets)', () => {
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

  it('/api/scan -> /api/teams read-after-write consistency', async () => {
    // 2 qualifying teams (Liverpool earlier on Jan 17, Arsenal later on Feb 17) and 2 non-qualifying teams (Chelsea, Spurs)
    const matches = [
      // Liverpool beats Chelsea 5 times (Jan 1..Jan 17)
      ...[0, 4, 8, 12, 16].map((d, i) =>
        makeMatch({
          id: 20000 + i,
          utcDate: new Date(Date.parse('2025-01-01T15:00:00Z') + d * 86400000).toISOString(),
          homeTeam: LIVERPOOL,
          awayTeam: CHELSEA,
          homeGoals: 2,
          awayGoals: 0,
        }),
      ),
      // Arsenal beats Spurs 5 times (Feb 1..Feb 17)
      ...[0, 4, 8, 12, 16].map((d, i) =>
        makeMatch({
          id: 21000 + i,
          utcDate: new Date(Date.parse('2025-02-01T15:00:00Z') + d * 86400000).toISOString(),
          homeTeam: ARSENAL,
          awayTeam: SPURS,
          homeGoals: 3,
          awayGoals: 1,
        }),
      ),
    ];

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
        },
        async () => {
          const scanHandler = await importFresh('api/scan.js');
          const teamsHandler = await importFresh('api/teams.js');

          const scanRes = await invokeHandler(scanHandler, { method: 'GET' });
          assert.equal(scanRes.status, 200);
          assert.equal(scanRes.body.success, true);

          const teamsRes = await invokeHandler(teamsHandler, { method: 'GET' });
          assert.equal(teamsRes.status, 200);
          assert.equal(teamsRes.body.winnersCount, 2);
          assert.equal(teamsRes.body.totalScanned, 4);
          assert.equal(teamsRes.body.leaguesScanned, 1);
          assert.equal(teamsRes.body.teams.length, 2);
          assert.equal(teamsRes.body.teams[0].team_id, LIVERPOOL.id, 'Liverpool achieved 5 wins earlier');
          assert.equal(teamsRes.body.teams[1].team_id, ARSENAL.id, 'Arsenal achieved 5 wins second');
          assert.equal(teamsRes.body.recentScans.length, 1);
          assert.equal(teamsRes.body.recentScans[0].league_id, 'PL');
        },
      );
    } finally {
      mockFetch.restore();
    }
  });

  it('/api/scan-all -> /api/teams preserves distinct composite keys (team_id, league_id, sport) across multiple leagues', async () => {
    // Arsenal qualifies in both PL and CL (same team_id=57, different league_id)
    const plMatches = makeStreakMatches({
      team: ARSENAL,
      startDate: '2025-01-01',
      stepDays: 4,
      results: ['W', 'W', 'W', 'W', 'W'],
      idStart: 30000,
      competition: { id: 2021, name: 'Premier League', code: 'PL' },
    });
    const pdMatches = makeStreakMatches({
      team: LIVERPOOL,
      startDate: '2025-01-05',
      stepDays: 4,
      results: ['W', 'W', 'W', 'W', 'W'],
      idStart: 31000,
      competition: { id: 2014, name: 'La Liga', code: 'PD' },
    });
    const clMatches = makeStreakMatches({
      team: ARSENAL,
      startDate: '2025-02-01',
      stepDays: 4,
      results: ['W', 'W', 'W', 'W', 'W'],
      idStart: 32000,
      competition: { id: 2001, name: 'UEFA Champions League', code: 'CL' },
    });

    // Pre-seed other leagues as recently scanned so scan-all focuses on PL, PD, CL within a single budget
    const nowIso = new Date().toISOString();
    for (const code of ['BL1', 'SA', 'FL1', 'DED', 'PPL', 'ELC', 'BSA', 'EC', 'WC']) {
      mockSupa.db.scan_log.push({
        id: `fresh-${code}`,
        sport: 'football',
        league_id: code,
        league_name: code,
        teams_scanned: 10,
        teams_qualified: 0,
        scanned_at: nowIso,
      });
    }

    const mockFetch = installMockFetch((call) => {
      const from = call.searchParams.get('dateFrom');
      const to = call.searchParams.get('dateTo');
      let source = [];
      if (call.pathname.includes('/competitions/PL/')) source = plMatches;
      else if (call.pathname.includes('/competitions/PD/')) source = pdMatches;
      else if (call.pathname.includes('/competitions/CL/')) source = clMatches;
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
          CRON_SECRET: 'cron-secret',
        },
        async () => {
          const scanAllHandler = await importFresh('api/scan-all.js');
          const teamsHandler = await importFresh('api/teams.js');

          // Run scan-all (potentially 2 quick cycles if per-run budget is 2-3 leagues)
          const r1 = await invokeHandler(scanAllHandler, {
            method: 'GET',
            headers: { authorization: 'Bearer cron-secret' },
          });
          assert.equal(r1.status, 200);
          assert.equal(r1.body.success, true);

          // If budget scanned < 3 leagues in 1 run, run one more cycle to finish the 3 unscanned leagues
          const scannedCodes = new Set(mockSupa.db.scan_log.map((s) => s.league_id));
          if (!scannedCodes.has('PL') || !scannedCodes.has('PD') || !scannedCodes.has('CL')) {
            const r2 = await invokeHandler(scanAllHandler, {
              method: 'GET',
              headers: { authorization: 'Bearer cron-secret' },
            });
            assert.equal(r2.status, 200);
          }

          const teamsRes = await invokeHandler(teamsHandler, { method: 'GET' });
          assert.equal(teamsRes.status, 200);
          assert.equal(teamsRes.body.winnersCount, 3, 'Arsenal in PL + Arsenal in CL + Liverpool in PD = 3 distinct winner rows');

          const arsenalRows = teamsRes.body.teams.filter((t) => t.team_id === ARSENAL.id);
          assert.equal(arsenalRows.length, 2, 'Composite key (team_id, league_id, sport) must keep PL and CL rows distinct');
          assert.deepEqual(arsenalRows.map((r) => r.league_id).sort(), ['CL', 'PL']);
        },
      );
    } finally {
      mockFetch.restore();
    }
  });

  it('T3-SEO-01 & T3-SEO-02: index.html <-> public/index.html byte parity and vercel.json <-> public/ asset alignment', () => {
    // 1. Byte-for-byte parity between root index.html and public/index.html
    const rootHtml = fs.readFileSync(path.join(REPO_ROOT, 'index.html'));
    const publicHtml = fs.readFileSync(path.join(REPO_ROOT, 'public/index.html'));
    assert.equal(
      Buffer.compare(rootHtml, publicHtml),
      0,
      'root index.html and public/index.html must be byte-for-byte identical (run npm run build)',
    );

    // 2. vercel.json outputDirectory and headers align with actual public/ assets
    const vercel = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'vercel.json'), 'utf8'));
    const outDir = path.join(REPO_ROOT, vercel.outputDirectory || 'public');
    assert.ok(fs.existsSync(outDir), `outputDirectory ${outDir} must exist`);

    for (const rel of ['index.html', 'output.css', 'confetti.js', 'og_image.jpeg', 'united-crest.png']) {
      assert.ok(fs.existsSync(path.join(outDir, rel)), `Expected static asset public/${rel} to exist`);
    }

    // Verify every /fonts/... url referenced in public/output.css resolves to an existing file in public/fonts/
    const css = fs.readFileSync(path.join(outDir, 'output.css'), 'utf8');
    const fontUrls = [...css.matchAll(/url\(['"]?(\/fonts\/[^'")\s]+)['"]?\)/g)].map((m) => m[1]);
    assert.ok(fontUrls.length >= 1, 'Expected at least one /fonts/ URL in public/output.css');
    for (const fontUrl of fontUrls) {
      const absFont = path.join(outDir, fontUrl.replace(/^\//, ''));
      assert.ok(fs.existsSync(absFont), `Font referenced in public/output.css does not exist: ${fontUrl}`);
    }

    // Verify vercel.json security headers include Permissions-Policy as well as standard headers
    const globalRule = (vercel.headers || []).find((h) => h.source === '/(.*)' || h.source === '/:path*');
    assert.ok(globalRule, 'vercel.json must define global security headers rule');
    const secMap = new Map((globalRule.headers || []).map((h) => [h.key.toLowerCase(), h.value]));
    assert.equal(secMap.get('x-content-type-options'), 'nosniff');
    assert.ok(secMap.has('x-frame-options'), 'Missing X-Frame-Options');
    assert.ok(secMap.has('referrer-policy'), 'Missing Referrer-Policy');
    assert.ok(secMap.has('permissions-policy'), 'Missing Permissions-Policy');
  });
});
