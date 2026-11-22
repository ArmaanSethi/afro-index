import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPETITIONS,
  START_DATE,
  buildDateWindows,
  fetchCompetitionMatches,
  findFiveWinStreak,
  formatMatchScore,
  getMatchResult,
  mergeTeamRecord,
} from '../../api/_lib/football.js';
import {
  fetchWithTimeout,
  handlePreflightAndMethod,
  isAuthorizedCron,
} from '../../api/_lib/http.js';
import { createHandler as createTeamsHandler } from '../../api/teams.js';
import { createHandler as createUnitedHandler } from '../../api/united.js';
import { createHandler as createScanHandler } from '../../api/scan.js';
import {
  HARD_DEADLINE_MS,
  createHandler as createScanAllHandler,
} from '../../api/scan-all.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

function createMockReq({ method = 'GET', query = {}, headers = {} } = {}) {
  return { method, query, headers };
}

function createMockRes() {
  const headers = new Map();
  const res = {
    statusCode: 200,
    body: undefined,
    ended: false,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
  return res;
}

function createMockSupabase(handlers = {}) {
  const calls = [];

  function from(table) {
    const state = {
      table,
      op: 'select',
      columns: '*',
      selectOptions: undefined,
      filters: [],
      orders: [],
      limitValue: undefined,
      rangeValue: undefined,
      payload: undefined,
      opOptions: undefined,
    };

    const builder = {
      select(columns = '*', options) {
        state.op = 'select';
        state.columns = columns;
        state.selectOptions = options;
        return builder;
      },
      eq(col, val) {
        state.filters.push({ col, val });
        return builder;
      },
      order(col, opts) {
        state.orders.push({ col, opts });
        return builder;
      },
      limit(n) {
        state.limitValue = n;
        return builder;
      },
      range(fromIdx, toIdx) {
        state.rangeValue = [fromIdx, toIdx];
        return builder;
      },
      upsert(rows, opts) {
        state.op = 'upsert';
        state.payload = rows;
        state.opOptions = opts;
        return builder;
      },
      insert(row) {
        state.op = 'insert';
        state.payload = row;
        return builder;
      },
      then(resolve, reject) {
        const snapshot = {
          table: state.table,
          op: state.op,
          columns: state.columns,
          selectOptions: state.selectOptions,
          filters: [...state.filters],
          orders: [...state.orders],
          limit: state.limitValue,
          range: state.rangeValue,
          payload: state.payload,
          opOptions: state.opOptions,
        };
        calls.push(snapshot);
        Promise.resolve()
          .then(() => {
            const key = `${state.table}:${state.op}`;
            const fn = handlers[key] || handlers[state.table] || handlers.default;
            if (!fn) {
              return { data: [], count: 0, error: null };
            }
            return fn(snapshot);
          })
          .then(resolve, reject);
      },
    };

    return builder;
  }

  return { from, calls };
}

function createMockFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return responder(url, options, calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function makeMatch(id, utcDate, homeId, awayId, { homeGoals, awayGoals, winner, homeName = `Team ${homeId}`, awayName = `Team ${awayId}` } = {}) {
  return {
    id,
    utcDate,
    homeTeam: { id: homeId, name: homeName, tla: `T${homeId}`, crest: `https://example.com/${homeId}.png` },
    awayTeam: { id: awayId, name: awayName, tla: `T${awayId}`, crest: `https://example.com/${awayId}.png` },
    score: {
      winner: winner ?? null,
      fullTime: {
        home: homeGoals ?? null,
        away: awayGoals ?? null,
      },
    },
  };
}

// ============================================================================
// F1: supabase-setup.sql
// ============================================================================
describe('F1: supabase-setup.sql DDL and RLS policies', () => {
  const sql = fs.readFileSync(path.join(REPO_ROOT, 'supabase-setup.sql'), 'utf8');

  it('contains pure executable SQL with no Markdown headings or code fences', () => {
    assert.equal(/^#/m.test(sql), false, 'SQL must not contain Markdown headings');
    assert.equal(sql.includes('```'), false, 'SQL must not contain Markdown code fences');
  });

  it('defines streak_achieved_date DATE and idempotent ALTER TABLE migration', () => {
    assert.match(sql, /streak_achieved_date\s+DATE/i);
    assert.match(
      sql,
      /ALTER\s+TABLE\s+teams\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+streak_achieved_date\s+DATE/i
    );
  });

  it('enforces NOT NULL on sport and league_id for teams and scan_log', () => {
    const teamsTableMatch = sql.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+teams\s*\(([\s\S]*?)\);/i);
    assert.ok(teamsTableMatch, 'teams CREATE TABLE block should exist');
    const teamsBlock = teamsTableMatch[1];
    assert.match(teamsBlock, /sport\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'football'/i);
    assert.match(teamsBlock, /league_id\s+TEXT\s+NOT\s+NULL/i);
    assert.match(teamsBlock, /UNIQUE\s*\(\s*team_id\s*,\s*league_id\s*,\s*sport\s*\)/i);

    const scanLogMatch = sql.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+scan_log\s*\(([\s\S]*?)\);/i);
    assert.ok(scanLogMatch, 'scan_log CREATE TABLE block should exist');
    const scanLogBlock = scanLogMatch[1];
    assert.match(scanLogBlock, /sport\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'football'/i);
    assert.match(scanLogBlock, /league_id\s+TEXT\s+NOT\s+NULL/i);
  });

  it('enables RLS, drops existing policies idempotently, and restricts INSERT/UPDATE to service_role', () => {
    assert.match(sql, /ALTER\s+TABLE\s+teams\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    assert.match(sql, /ALTER\s+TABLE\s+scan_log\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);

    const createPolicies = [...sql.matchAll(/CREATE\s+POLICY\s+"([^"]+)"\s+ON\s+(\w+)([\s\S]*?);/gi)];
    assert.ok(createPolicies.length >= 5, 'Expected at least 5 RLS policies');

    for (const [, policyName, tableName, clause] of createPolicies) {
      const dropRegex = new RegExp(
        `DROP\\s+POLICY\\s+IF\\s+EXISTS\\s+"${policyName}"\\s+ON\\s+${tableName}\\s*;`,
        'i'
      );
      assert.match(sql, dropRegex, `Policy "${policyName}" must have DROP POLICY IF EXISTS`);

      if (/FOR\s+(INSERT|UPDATE)/i.test(clause)) {
        assert.match(
          clause,
          /TO\s+service_role/i,
          `Write policy "${policyName}" on ${tableName} must be restricted TO service_role`
        );
      }
    }
  });
});

// ============================================================================
// F2: Shared Helpers (api/_lib/)
// ============================================================================
describe('F2: api/_lib shared helpers', () => {
  it('buildDateWindows applies 2-day historical buffer (#14)', () => {
    // START_DATE = 2024-10-05; 700-day window ends 2026-09-04
    const oneDayAfter = buildDateWindows(START_DATE, '2026-09-05', 700, 2);
    assert.equal(oneDayAfter.length, 2);
    assert.equal(oneDayAfter[0].from, '2024-10-05');
    assert.equal(oneDayAfter[0].to, '2026-09-04');
    assert.equal(oneDayAfter[0].isHistorical, false, '1 day after windowEnd must NOT be historical');
    assert.equal(oneDayAfter[1].isHistorical, false);

    const twoDaysAfter = buildDateWindows(START_DATE, '2026-09-06', 700, 2);
    assert.equal(twoDaysAfter.length, 2);
    assert.equal(twoDaysAfter[0].isHistorical, true, '2 days after windowEnd IS historical');
    assert.equal(twoDaysAfter[1].isHistorical, false);

    assert.deepEqual(buildDateWindows('2026-10-01', '2026-09-01'), []);
  });

  it('getMatchResult prefers score.winner and never coerces null scores to 0-0 draw (#12)', () => {
    // Penalty shootout where fullTime is 1-1 but winner is HOME_TEAM
    const shootout = makeMatch(1, '2025-05-01T18:00:00Z', 66, 100, {
      homeGoals: 1,
      awayGoals: 1,
      winner: 'HOME_TEAM',
    });
    assert.equal(getMatchResult(shootout, 66), 'W');
    assert.equal(getMatchResult(shootout, 100), 'L');

    // Awarded match with null fullTime goals but winner set
    const awarded = makeMatch(2, '2025-05-02T18:00:00Z', 66, 100, {
      homeGoals: null,
      awayGoals: null,
      winner: 'AWAY_TEAM',
    });
    assert.equal(getMatchResult(awarded, 66), 'L');
    assert.equal(getMatchResult(awarded, 100), 'W');
    assert.equal(formatMatchScore(awarded), null);

    // Missing winner AND null fullTime scores -> null (not 'D')
    const missing = makeMatch(3, '2025-05-03T18:00:00Z', 66, 100, {
      homeGoals: null,
      awayGoals: null,
      winner: null,
    });
    assert.equal(getMatchResult(missing, 66), null);

    // Fallback to finite fullTime when winner is absent
    const fallbackWin = makeMatch(4, '2025-05-04T18:00:00Z', 66, 100, {
      homeGoals: 2,
      awayGoals: 0,
      winner: null,
    });
    assert.equal(getMatchResult(fallbackWin, 66), 'W');
    assert.equal(getMatchResult(fallbackWin, 100), 'L');
    assert.equal(formatMatchScore(fallbackWin), '2-0');

    // Unrelated team ID -> null
    assert.equal(getMatchResult(fallbackWin, 999), null);
  });

  it('findFiveWinStreak detects earliest 5th win and max consecutive wins', () => {
    const fourWins = [
      { result: 'W', date: '2025-01-01' },
      { result: 'W', date: '2025-01-02' },
      { result: 'W', date: '2025-01-03' },
      { result: 'W', date: '2025-01-04' },
      { result: 'D', date: '2025-01-05' },
      { result: 'W', date: '2025-01-06' },
    ];
    assert.deepEqual(findFiveWinStreak(fourWins), {
      achievedStreak: false,
      maxConsecutive: 4,
      achievedDate: null,
    });

    const sevenThenFive = [
      { result: 'W', date: '2025-02-01' },
      { result: 'W', date: '2025-02-02' },
      { result: 'W', date: '2025-02-03' },
      { result: 'W', date: '2025-02-04' },
      { result: 'W', date: '2025-02-05' },
      { result: 'W', date: '2025-02-06' },
      { result: 'W', date: '2025-02-07' },
      { result: 'L', date: '2025-02-08' },
      { result: 'W', date: '2025-02-09' },
      { result: 'W', date: '2025-02-10' },
      { result: 'W', date: '2025-02-11' },
      { result: 'W', date: '2025-02-12' },
      { result: 'W', date: '2025-02-13' },
    ];
    assert.deepEqual(findFiveWinStreak(sevenThenFive), {
      achievedStreak: true,
      maxConsecutive: 7,
      achievedDate: '2025-02-05',
    });
  });

  it('mergeTeamRecord preserves prior achievements, max_streak, earliest date, and first_detected', () => {
    const existing = {
      team_id: 57,
      logo: 'https://old.logo/arsenal.png',
      has_5_wins: true,
      max_streak: 7,
      streak_achieved_date: '2024-11-10',
      first_detected: '2024-11-11T00:00:00Z',
    };
    const incoming = {
      team_id: 57,
      logo: null,
      has_5_wins: false,
      max_streak: 3,
      streak_achieved_date: null,
      form: 'WWL',
    };

    const merged = mergeTeamRecord(existing, incoming);
    assert.equal(merged.has_5_wins, true);
    assert.equal(merged.max_streak, 7);
    assert.equal(merged.streak_achieved_date, '2024-11-10');
    assert.equal(merged.first_detected, '2024-11-11T00:00:00Z');
    assert.equal(merged.logo, 'https://old.logo/arsenal.png');
    assert.equal(merged.form, 'WWL');

    // Earlier incoming date wins over later existing date; empty string logo preserves existing logo
    const mergedEarlier = mergeTeamRecord(
      { logo: 'https://old.logo/arsenal.png', has_5_wins: true, max_streak: 5, streak_achieved_date: '2025-02-01' },
      { logo: '', has_5_wins: true, max_streak: 6, streak_achieved_date: '2024-12-15' }
    );
    assert.equal(mergedEarlier.streak_achieved_date, '2024-12-15');
    assert.equal(mergedEarlier.max_streak, 6);
    assert.equal(mergedEarlier.logo, 'https://old.logo/arsenal.png');
  });

  it('isAuthorizedCron verifies Bearer token with timing-safe comparison', () => {
    assert.equal(isAuthorizedCron(createMockReq({ headers: { authorization: 'Bearer secret123' } }), 'secret123'), true);
    assert.equal(isAuthorizedCron(createMockReq({ headers: { Authorization: 'Bearer secret123' } }), 'secret123'), true);
    assert.equal(isAuthorizedCron(createMockReq({ headers: { authorization: 'Bearer wrong' } }), 'secret123'), false);
    assert.equal(isAuthorizedCron(createMockReq({ headers: { authorization: 'Bearer secret124' } }), 'secret123'), false);
    assert.equal(isAuthorizedCron(createMockReq({ headers: {} }), 'secret123'), false);
    assert.equal(isAuthorizedCron(createMockReq({ headers: { authorization: 'Bearer secret123' } }), ''), false);
  });

  it('handlePreflightAndMethod enforces OPTIONS 200 and non-GET 405 with no-store', () => {
    const optRes = createMockRes();
    assert.equal(handlePreflightAndMethod(createMockReq({ method: 'OPTIONS' }), optRes), true);
    assert.equal(optRes.statusCode, 200);
    assert.equal(optRes.getHeader('access-control-allow-methods'), 'GET, OPTIONS');

    const postRes = createMockRes();
    assert.equal(handlePreflightAndMethod(createMockReq({ method: 'POST' }), postRes), true);
    assert.equal(postRes.statusCode, 405);
    assert.equal(postRes.getHeader('allow'), 'GET, OPTIONS');
    assert.equal(postRes.getHeader('cache-control'), 'no-store');
  });

  it('fetchWithTimeout attaches an AbortSignal to fetchImpl', async () => {
    const mockFetch = createMockFetch(async () => ({ ok: true, status: 200 }));
    await fetchWithTimeout('https://example.com', { headers: { 'X-Test': '1' } }, 2500, mockFetch);
    assert.equal(mockFetch.calls.length, 1);
    assert.ok(mockFetch.calls[0].options.signal instanceof AbortSignal);
  });
});

// ============================================================================
// F3: api/teams.js
// ============================================================================
describe('F3: api/teams.js', () => {
  const baseEnv = {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_KEY: 'service-key',
  };

  it('handles OPTIONS 200, POST 405, and missing env 500 with no-store', async () => {
    const handler = createTeamsHandler({ env: {} });

    const optRes = createMockRes();
    await handler(createMockReq({ method: 'OPTIONS' }), optRes);
    assert.equal(optRes.statusCode, 200);

    const postRes = createMockRes();
    await handler(createMockReq({ method: 'POST' }), postRes);
    assert.equal(postRes.statusCode, 405);
    assert.equal(postRes.getHeader('allow'), 'GET, OPTIONS');
    assert.equal(postRes.getHeader('cache-control'), 'no-store');

    const envRes = createMockRes();
    await handler(createMockReq({ method: 'GET' }), envRes);
    assert.equal(envRes.statusCode, 500);
    assert.equal(envRes.getHeader('cache-control'), 'no-store');
  });

  it('paginates >1000 winners and reports all 12 leagues beyond 100 scan_log rows (#10, #13)', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      team_id: i + 1,
      name: `Team ${i + 1}`,
      league_id: 'PL',
      has_5_wins: true,
      streak_achieved_date: '2025-01-01',
    }));
    const page2 = [
      {
        team_id: 1001,
        name: 'Team 1001',
        league_id: 'PD',
        has_5_wins: true,
        streak_achieved_date: '2025-01-02',
      },
    ];

    const supabase = createMockSupabase({
      'teams:select': (q) => {
        if (q.selectOptions?.head) {
          return { data: null, count: 1500, error: null };
        }
        if (q.range?.[0] === 0) return { data: page1, error: null };
        if (q.range?.[0] === 1000) return { data: page2, error: null };
        return { data: [], error: null };
      },
      'scan_log:select': (q) => {
        const leagueFilter = q.filters.find((f) => f.col === 'league_id')?.val;
        const idx = COMPETITIONS.findIndex((c) => c.code === leagueFilter);
        return {
          data: [
            {
              league_id: leagueFilter,
              league_name: COMPETITIONS[idx].name,
              teams_scanned: 20,
              teams_qualified: 3,
              scanned_at: new Date(Date.UTC(2026, 10, 1 + idx)).toISOString(),
            },
          ],
          error: null,
        };
      },
    });

    const handler = createTeamsHandler({
      getSupabase: () => supabase,
      env: baseEnv,
    });

    const res = createMockRes();
    await handler(createMockReq({ method: 'GET' }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.getHeader('cache-control'), 's-maxage=60, stale-while-revalidate=300');
    assert.equal(res.body.success, true);
    assert.equal(res.body.winnersCount, 1001);
    assert.equal(res.body.teams.length, 1001);
    assert.equal(res.body.totalScanned, 1500);
    assert.equal(res.body.leaguesScanned, 12);
    assert.equal(res.body.recentScans.length, 12);
    // Most recent scan should be sorted first
    assert.equal(res.body.recentScans[0].league_id, COMPETITIONS[11].code);
  });

  it('propagates Supabase errors from teams, count, and scan_log with no-store', async () => {
    for (const failingQuery of ['winners', 'count', 'scan_log']) {
      const supabase = createMockSupabase({
        'teams:select': (q) => {
          if (q.selectOptions?.head) {
            return failingQuery === 'count'
              ? { count: null, error: new Error('count failed') }
              : { count: 10, error: null };
          }
          return failingQuery === 'winners'
            ? { data: null, error: new Error('winners failed') }
            : { data: [], error: null };
        },
        'scan_log:select': () =>
          failingQuery === 'scan_log'
            ? { data: null, error: new Error('scan_log failed') }
            : { data: [], error: null },
      });

      const handler = createTeamsHandler({
        getSupabase: () => supabase,
        env: baseEnv,
      });

      const res = createMockRes();
      await handler(createMockReq({ method: 'GET' }), res);
      assert.equal(res.statusCode, 500, `Expected 500 when ${failingQuery} fails`);
      assert.equal(res.getHeader('cache-control'), 'no-store');
    }
  });
});

// ============================================================================
// F4: api/united.js
// ============================================================================
describe('F4: api/united.js', () => {
  const baseEnv = { FOOTBALL_DATA_API_KEY: 'test-key' };

  it('handles OPTIONS 200, POST 405, and missing API key 500 with no-store', async () => {
    const handler = createUnitedHandler({ env: {} });

    const optRes = createMockRes();
    await handler(createMockReq({ method: 'OPTIONS' }), optRes);
    assert.equal(optRes.statusCode, 200);

    const postRes = createMockRes();
    await handler(createMockReq({ method: 'POST' }), postRes);
    assert.equal(postRes.statusCode, 405);
    assert.equal(postRes.getHeader('cache-control'), 'no-store');

    const keyRes = createMockRes();
    await handler(createMockReq({ method: 'GET' }), keyRes);
    assert.equal(keyRes.statusCode, 500);
    assert.equal(keyRes.getHeader('cache-control'), 'no-store');
  });

  it('returns all_competitions scope, respects score.winner, skips null scores, and sets public cache on 200', async () => {
    const matches = [
      // 5 wins including a shootout (1-1, winner HOME_TEAM) and an awarded match (null score, winner AWAY_TEAM)
      makeMatch(1, '2025-01-01T15:00:00Z', 66, 10, { homeGoals: 2, awayGoals: 0, winner: 'HOME_TEAM' }),
      makeMatch(2, '2025-01-05T15:00:00Z', 66, 11, { homeGoals: 1, awayGoals: 1, winner: 'HOME_TEAM' }),
      // Null-score match with no winner -> must be skipped (NOT break the streak as 0-0 draw)
      makeMatch(3, '2025-01-08T15:00:00Z', 66, 12, { homeGoals: null, awayGoals: null, winner: null }),
      makeMatch(4, '2025-01-12T15:00:00Z', 13, 66, { homeGoals: null, awayGoals: null, winner: 'AWAY_TEAM' }),
      makeMatch(5, '2025-01-19T15:00:00Z', 66, 14, { homeGoals: 3, awayGoals: 1, winner: 'HOME_TEAM' }),
      makeMatch(6, '2025-01-26T15:00:00Z', 15, 66, { homeGoals: 0, awayGoals: 1, winner: 'AWAY_TEAM' }),
    ];

    const mockFetch = createMockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ matches }),
    }));

    const handler = createUnitedHandler({
      fetchImpl: mockFetch,
      now: () => Date.parse('2025-02-01T12:00:00Z'),
      env: baseEnv,
      cache: new Map(),
    });

    const res = createMockRes();
    await handler(createMockReq({ method: 'GET' }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.getHeader('cache-control'), 's-maxage=60, stale-while-revalidate=300');
    assert.equal(res.body.scope, 'all_competitions');
    assert.equal(res.body.hasWon5, true);
    assert.equal(res.body.currentStreak, 5);
    assert.equal(res.body.bestStreak, 5);
    assert.equal(res.body.achievementDate, '2025-01-26T15:00:00Z');
    assert.equal(res.body.form, 'WWWWW');
    assert.equal(res.body.recentMatches.length, 5);
    // Awarded match (id 4, index 2 in descending order) has null score
    assert.equal(res.body.recentMatches[2].score, null);
    assert.ok(mockFetch.calls[0].options.signal instanceof AbortSignal);
  });

  it('caches historical windows only when >= 2 days old (#14) and returns no-store on upstream error (#13)', async () => {
    const cache = new Map();
    const mockFetch = createMockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ matches: [] }),
    }));

    // 2026-09-05 is 1 day after first window end (2026-09-04): NOT historical -> not cached
    const handlerDay1 = createUnitedHandler({
      fetchImpl: mockFetch,
      now: () => Date.parse('2026-09-05T00:01:00Z'),
      env: baseEnv,
      cache,
    });
    await handlerDay1(createMockReq(), createMockRes());
    assert.equal(mockFetch.calls.length, 2);
    assert.equal(cache.size, 0);

    // 2026-09-06 is 2 days after first window end: IS historical -> cached on 1st call, reused on 2nd
    const handlerDay2 = createUnitedHandler({
      fetchImpl: mockFetch,
      now: () => Date.parse('2026-09-06T00:01:00Z'),
      env: baseEnv,
      cache,
    });
    await handlerDay2(createMockReq(), createMockRes());
    assert.equal(mockFetch.calls.length, 4);
    assert.equal(cache.size, 1);

    await handlerDay2(createMockReq(), createMockRes());
    assert.equal(mockFetch.calls.length, 5, 'Only recent window should be re-fetched');

    // Upstream 429 -> returns 429 with Cache-Control: no-store
    const rateLimitedHandler = createUnitedHandler({
      fetchImpl: createMockFetch(async () => ({
        ok: false,
        status: 429,
        text: async () => 'Too Many Requests',
      })),
      now: () => Date.parse('2025-02-01T12:00:00Z'),
      env: baseEnv,
      cache: new Map(),
    });
    const errRes = createMockRes();
    await rateLimitedHandler(createMockReq(), errRes);
    assert.equal(errRes.statusCode, 429);
    assert.equal(errRes.getHeader('cache-control'), 'no-store');
  });

  it('rejects malformed upstream payloads with 502 + no-store and does not poison historical cache', async () => {
    const nowMs = Date.parse('2026-09-06T00:01:00Z'); // window 0 is historical (>= 2 days old)
    const malformedPayloads = [
      [],
      { matches: null },
      { matches: 'bad' },
      { matches: 123 },
      { matches: { a: 1 } },
      { matches: [null, undefined, { id: null }] },
      null,
    ];

    for (const badPayload of malformedPayloads) {
      const cache = new Map();
      let serveValid = false;
      const mockFetch = createMockFetch(async () => ({
        ok: true,
        status: 200,
        json: async () =>
          serveValid
            ? {
                matches: [
                  makeMatch(101, '2025-01-10T15:00:00Z', 66, 10, {
                    homeGoals: 2,
                    awayGoals: 0,
                    winner: 'HOME_TEAM',
                  }),
                ],
              }
            : badPayload,
      }));

      const handler = createUnitedHandler({
        fetchImpl: mockFetch,
        now: () => nowMs,
        env: baseEnv,
        cache,
      });

      const badRes = createMockRes();
      await handler(createMockReq({ method: 'GET' }), badRes);
      assert.equal(
        badRes.statusCode,
        502,
        `Expected 502 for malformed payload ${JSON.stringify(badPayload)}`
      );
      assert.equal(badRes.getHeader('cache-control'), 'no-store');
      assert.equal(
        cache.size,
        0,
        `Historical cache must not be poisoned by ${JSON.stringify(badPayload)}`
      );

      // Subsequent valid request with the same cache must succeed with 200
      serveValid = true;
      const okRes = createMockRes();
      await handler(createMockReq({ method: 'GET' }), okRes);
      assert.equal(okRes.statusCode, 200);
      assert.equal(okRes.getHeader('cache-control'), 's-maxage=60, stale-while-revalidate=300');
      assert.equal(okRes.body.currentStreak, 1);
      assert.equal(cache.size, 1);
    }
  });
});

// ============================================================================
// F5: api/scan.js
// ============================================================================
describe('F5: api/scan.js', () => {
  const baseEnv = {
    FOOTBALL_DATA_API_KEY: 'test-key',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_KEY: 'service-key',
    CRON_SECRET: 'super-secret',
  };

  it('handles OPTIONS CORS (with Authorization), POST 405, and invalid/array ?competition= 400 (#5)', async () => {
    const mockFetch = createMockFetch(async () => {
      throw new Error('Should not call fetch');
    });
    const handler = createScanHandler({ fetchImpl: mockFetch, env: baseEnv });

    const optRes = createMockRes();
    await handler(createMockReq({ method: 'OPTIONS' }), optRes);
    assert.equal(optRes.statusCode, 200);
    assert.equal(optRes.getHeader('access-control-allow-headers'), 'Content-Type, Authorization');

    const postRes = createMockRes();
    await handler(createMockReq({ method: 'POST' }), postRes);
    assert.equal(postRes.statusCode, 405);
    assert.equal(postRes.getHeader('cache-control'), 'no-store');

    for (const badComp of ['../teams/66', 'INVALID', '', ['PL', 'PD']]) {
      const res = createMockRes();
      await handler(createMockReq({ query: { competition: badComp } }), res);
      assert.equal(res.statusCode, 400, `Expected 400 for competition=${JSON.stringify(badComp)}`);
      assert.equal(res.getHeader('cache-control'), 'no-store');
    }

    assert.equal(mockFetch.calls.length, 0);
  });

  it('requires Bearer CRON_SECRET for ?competition= override while keeping public GET /api/scan working (#5)', async () => {
    const nowMs = Date.parse('2025-03-01T12:00:00Z');
    const supabase = createMockSupabase({
      'scan_log:select': () => ({ data: [], error: null }),
      'teams:select': () => ({ data: [], error: null }),
      'teams:upsert': () => ({ error: null }),
      'scan_log:insert': () => ({ error: null }),
    });
    const mockFetch = createMockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        competition: { name: 'Premier League', area: { name: 'England', flag: null } },
        matches: [
          makeMatch(1, '2025-02-01T15:00:00Z', 1, 2, { homeGoals: 2, awayGoals: 1, winner: 'HOME_TEAM' }),
        ],
      }),
    }));

    const handler = createScanHandler({
      getSupabase: () => supabase,
      fetchImpl: mockFetch,
      now: () => nowMs,
      env: baseEnv,
      cache: new Map(),
    });

    // Unauthenticated ?competition=PL -> 401
    const unauthRes = createMockRes();
    await handler(createMockReq({ query: { competition: 'PL' } }), unauthRes);
    assert.equal(unauthRes.statusCode, 401);
    assert.equal(unauthRes.getHeader('cache-control'), 'no-store');

    // Authorized ?competition=PL -> 200
    const authRes = createMockRes();
    await handler(
      createMockReq({
        query: { competition: 'pl' },
        headers: { authorization: 'Bearer super-secret' },
      }),
      authRes
    );
    assert.equal(authRes.statusCode, 200);
    assert.equal(authRes.getHeader('cache-control'), 'no-store');
    assert.equal(authRes.body.competition.code, 'PL');

    // Public unauthenticated GET /api/scan (no query) -> 200
    const pubRes = createMockRes();
    await handler(createMockReq(), pubRes);
    assert.equal(pubRes.statusCode, 200);
    assert.equal(pubRes.body.success, true);
  });

  it('fixes priority-league cooldown starvation (#11) and computes min remaining cooldown when all fresh', async () => {
    const nowMs = Date.parse('2025-03-01T12:00:00Z');
    // DED (non-priority, 60m cooldown) is 30m old; PL (priority, 15m cooldown) is 20m old;
    // all others are 5m old. PL must be selected instead of skipping!
    const scanTimes = new Map(
      COMPETITIONS.map((c) => {
        if (c.code === 'DED') return [c.code, new Date(nowMs - 30 * 60 * 1000).toISOString()];
        if (c.code === 'PL') return [c.code, new Date(nowMs - 20 * 60 * 1000).toISOString()];
        return [c.code, new Date(nowMs - 5 * 60 * 1000).toISOString()];
      })
    );

    const supabase = createMockSupabase({
      'scan_log:select': (q) => {
        const code = q.filters.find((f) => f.col === 'league_id')?.val;
        return { data: [{ league_id: code, scanned_at: scanTimes.get(code) }], error: null };
      },
      'teams:select': () => ({ data: [], error: null }),
      'teams:upsert': () => ({ error: null }),
      'scan_log:insert': () => ({ error: null }),
    });

    const mockFetch = createMockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ competition: { name: 'Premier League' }, matches: [] }),
    }));

    const handler = createScanHandler({
      getSupabase: () => supabase,
      fetchImpl: mockFetch,
      now: () => nowMs,
      env: baseEnv,
      cache: new Map(),
    });

    const res = createMockRes();
    await handler(createMockReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.skipped, undefined);
    assert.equal(res.body.competition.code, 'PL');

    // Now make PL 10m old (< 15m cooldown) so ALL leagues are fresh
    scanTimes.set('PL', new Date(nowMs - 10 * 60 * 1000).toISOString());
    const freshRes = createMockRes();
    await handler(createMockReq(), freshRes);
    assert.equal(freshRes.statusCode, 200);
    assert.equal(freshRes.body.skipped, true);
    assert.equal(freshRes.body.nextScanIn, '300s');
    assert.equal(freshRes.getHeader('cache-control'), 'no-store');
  });

  it('performs non-destructive merge (#12), checks upsert & scan_log errors (#2), and computes accurate remainingCompetitions', async () => {
    const nowMs = Date.parse('2025-03-01T12:00:00Z');
    // Only PL has been scanned before (11 unscanned)
    const supabase = createMockSupabase({
      'scan_log:select': (q) => {
        const code = q.filters.find((f) => f.col === 'league_id')?.val;
        if (code === 'PL') {
          return { data: [{ league_id: 'PL', scanned_at: new Date(nowMs - 3600000).toISOString() }], error: null };
        }
        return { data: [], error: null };
      },
      'teams:select': () => ({
        data: [
          {
            team_id: 10,
            logo: 'https://old.logo/10.png',
            has_5_wins: true,
            max_streak: 8,
            streak_achieved_date: '2024-11-01',
            first_detected: '2024-11-02T00:00:00Z',
          },
        ],
        error: null,
      }),
      'teams:upsert': () => ({ error: null }),
      'scan_log:insert': () => ({ error: null }),
    });

    const mockFetch = createMockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        competition: { name: 'Premier League', area: { name: 'England', flag: null } },
        matches: [
          makeMatch(1, '2025-02-01T15:00:00Z', 10, 20, { homeGoals: 1, awayGoals: 0, winner: 'HOME_TEAM' }),
          makeMatch(2, '2025-02-08T15:00:00Z', 10, 20, { homeGoals: null, awayGoals: null, winner: null }),
        ],
      }),
    }));

    const handler = createScanHandler({
      getSupabase: () => supabase,
      fetchImpl: mockFetch,
      now: () => nowMs,
      env: baseEnv,
      cache: new Map(),
    });

    // Override already-scanned PL -> remainingCompetitions stays 11
    const res = createMockRes();
    await handler(
      createMockReq({
        query: { competition: 'PL' },
        headers: { authorization: 'Bearer super-secret' },
      }),
      res
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.remainingCompetitions, 11);
    const upsertCall = supabase.calls.find((c) => c.table === 'teams' && c.op === 'upsert');
    const team10 = upsertCall.payload.find((t) => t.team_id === 10);
    assert.equal(team10.has_5_wins, true);
    assert.equal(team10.max_streak, 8);
    assert.equal(team10.streak_achieved_date, '2024-11-01');
    assert.equal(team10.first_detected, '2024-11-02T00:00:00Z');
    assert.equal(team10.form, 'W', 'Null-score match must be skipped, not appended as D');

    // Upsert error -> aborts BEFORE scan_log insert and returns 500 no-store
    const failUpsertSupabase = createMockSupabase({
      'scan_log:select': () => ({ data: [], error: null }),
      'teams:select': () => ({ data: [], error: null }),
      'teams:upsert': () => ({ error: new Error('column streak_achieved_date missing') }),
      'scan_log:insert': () => ({ error: null }),
    });
    const failUpsertHandler = createScanHandler({
      getSupabase: () => failUpsertSupabase,
      fetchImpl: mockFetch,
      now: () => nowMs,
      env: baseEnv,
      cache: new Map(),
    });
    const errUpsertRes = createMockRes();
    await failUpsertHandler(createMockReq(), errUpsertRes);
    assert.equal(errUpsertRes.statusCode, 500);
    assert.equal(errUpsertRes.getHeader('cache-control'), 'no-store');
    assert.equal(
      failUpsertSupabase.calls.some((c) => c.table === 'scan_log' && c.op === 'insert'),
      false,
      'scan_log.insert must NOT be called when teams.upsert fails'
    );

    // scan_log insert error -> returns 500 no-store
    const failLogSupabase = createMockSupabase({
      'scan_log:select': () => ({ data: [], error: null }),
      'teams:select': () => ({ data: [], error: null }),
      'teams:upsert': () => ({ error: null }),
      'scan_log:insert': () => ({ error: new Error('RLS violation') }),
    });
    const failLogHandler = createScanHandler({
      getSupabase: () => failLogSupabase,
      fetchImpl: mockFetch,
      now: () => nowMs,
      env: baseEnv,
      cache: new Map(),
    });
    const errLogRes = createMockRes();
    await failLogHandler(createMockReq(), errLogRes);
    assert.equal(errLogRes.statusCode, 500);
    assert.equal(errLogRes.getHeader('cache-control'), 'no-store');
  });
});

// ============================================================================
// F6: api/scan-all.js
// ============================================================================
describe('F6: api/scan-all.js', () => {
  const baseEnv = {
    FOOTBALL_DATA_API_KEY: 'test-key',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_KEY: 'service-key',
    CRON_SECRET: 'cron-secret-xyz',
  };

  it('enforces CORS headers on OPTIONS, 405 on POST, CRON_SECRET auth, and no-store on all responses (#5, #13, #20)', async () => {
    const handler = createScanAllHandler({ env: baseEnv });

    const optRes = createMockRes();
    await handler(createMockReq({ method: 'OPTIONS' }), optRes);
    assert.equal(optRes.statusCode, 200);
    assert.equal(optRes.getHeader('access-control-allow-methods'), 'GET, OPTIONS');
    assert.equal(optRes.getHeader('access-control-allow-headers'), 'Content-Type, Authorization');
    assert.equal(optRes.getHeader('cache-control'), 'no-store');

    const postRes = createMockRes();
    await handler(createMockReq({ method: 'POST' }), postRes);
    assert.equal(postRes.statusCode, 405);
    assert.equal(postRes.getHeader('cache-control'), 'no-store');

    const unauthRes = createMockRes();
    await handler(createMockReq({ method: 'GET' }), unauthRes);
    assert.equal(unauthRes.statusCode, 401);
    assert.equal(unauthRes.getHeader('cache-control'), 'no-store');
  });

  it('enforces <= 8 upstream request budget on cold runs (4 leagues x 2 windows) in stalest-first order (#6, #10)', async () => {
    // 2026-11-22 -> 2 windows per league
    const nowMs = Date.parse('2026-11-22T12:00:00Z');
    const supabase = createMockSupabase({
      'scan_log:select': (q) => {
        const code = q.filters.find((f) => f.col === 'league_id')?.val;
        // Make BSA the stalest (oldest), PL the freshest
        const idx = COMPETITIONS.findIndex((c) => c.code === code);
        return {
          data: [
            {
              league_id: code,
              scanned_at: new Date(nowMs - (idx + 1) * 3600000).toISOString(),
            },
          ],
          error: null,
        };
      },
      'teams:select': () => ({ data: [], error: null }),
      'teams:upsert': () => ({ error: null }),
      'scan_log:insert': () => ({ error: null }),
    });

    const mockFetch = createMockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ competition: { name: 'League' }, matches: [] }),
    }));

    const handler = createScanAllHandler({
      getSupabase: () => supabase,
      fetchImpl: mockFetch,
      now: () => nowMs,
      env: baseEnv,
      cache: new Map(),
    });

    const res = createMockRes();
    await handler(
      createMockReq({ headers: { authorization: 'Bearer cron-secret-xyz' } }),
      res
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.getHeader('cache-control'), 'no-store');
    assert.equal(res.body.success, true);
    assert.equal(res.body.upstreamRequests, 8);
    assert.equal(res.body.leaguesScanned, 4);
    assert.equal(mockFetch.calls.length, 8);
    // Stalest first: BSA (index 11), WC (10), EC (9), CL (8)
    assert.deepEqual(
      res.body.results.slice(0, 4).map((r) => r.code),
      ['BSA', 'WC', 'EC', 'CL']
    );
    assert.equal(
      res.body.results.slice(4).every((r) => r.skipped && r.reason === 'request_budget'),
      true
    );
  });

  it('enforces 6500ms time budget and marks remaining leagues skipped with reason timeout (#6)', async () => {
    let clock = Date.parse('2025-03-01T12:00:00Z');
    const supabase = createMockSupabase({
      'scan_log:select': () => ({ data: [], error: null }),
      'teams:select': () => ({ data: [], error: null }),
      'teams:upsert': () => ({ error: null }),
      'scan_log:insert': () => ({ error: null }),
    });

    const mockFetch = createMockFetch(async () => {
      clock += 3500; // 2 leagues -> 7000ms > 6500ms budget
      return {
        ok: true,
        status: 200,
        json: async () => ({ competition: { name: 'League' }, matches: [] }),
      };
    });

    const handler = createScanAllHandler({
      getSupabase: () => supabase,
      fetchImpl: mockFetch,
      now: () => clock,
      env: baseEnv,
      cache: new Map(),
    });

    const res = createMockRes();
    await handler(
      createMockReq({ headers: { authorization: 'Bearer cron-secret-xyz' } }),
      res
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.leaguesScanned, 2);
    assert.equal(
      res.body.results.slice(2).every((r) => r.skipped && r.reason === 'timeout'),
      true
    );
  });

  it('returns 429 with success:false when rate-limited on first league, and 503 when all attempted fail (#2, #6)', async () => {
    const nowMs = Date.parse('2025-03-01T12:00:00Z');
    const supabase = createMockSupabase({
      'scan_log:select': () => ({ data: [], error: null }),
      'teams:select': () => ({ data: [], error: null }),
      'teams:upsert': () => ({ error: new Error('upsert failed') }),
      'scan_log:insert': () => ({ error: null }),
    });

    // 429 on first league
    const rlHandler = createScanAllHandler({
      getSupabase: () => supabase,
      fetchImpl: createMockFetch(async () => ({
        ok: false,
        status: 429,
        text: async () => 'Rate limit exceeded',
      })),
      now: () => nowMs,
      env: baseEnv,
      cache: new Map(),
    });

    const rlRes = createMockRes();
    await rlHandler(
      createMockReq({ headers: { authorization: 'Bearer cron-secret-xyz' } }),
      rlRes
    );
    assert.equal(rlRes.statusCode, 429);
    assert.equal(rlRes.body.success, false);
    assert.equal(rlRes.body.leaguesScanned, 0);
    assert.equal(rlRes.body.results.length, 12);
    assert.equal(
      rlRes.body.results.slice(1).every((r) => r.skipped && r.reason === 'rate_limit'),
      true
    );

    // Upsert error on all attempted leagues -> 503, success:false, scan_log.insert never called
    const upsertFailHandler = createScanAllHandler({
      getSupabase: () => supabase,
      fetchImpl: createMockFetch(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          competition: { name: 'League' },
          matches: [
            makeMatch(1, '2025-02-01T15:00:00Z', 1, 2, { homeGoals: 1, awayGoals: 0, winner: 'HOME_TEAM' }),
          ],
        }),
      })),
      now: () => nowMs,
      env: baseEnv,
      cache: new Map(),
    });

    const errRes = createMockRes();
    await upsertFailHandler(
      createMockReq({ headers: { authorization: 'Bearer cron-secret-xyz' } }),
      errRes
    );
    assert.equal(errRes.statusCode, 503);
    assert.equal(errRes.body.success, false);
    assert.equal(errRes.body.leaguesScanned, 0);
    assert.equal(
      supabase.calls.some((c) => c.table === 'scan_log' && c.op === 'insert'),
      false
    );
  });

  it('counts thrown network/timeout/JSON errors on window 1 or window 2 toward MAX_UPSTREAM_REQUESTS_PER_RUN <= 8 (#6)', async () => {
    // 2026-11-22 -> 2 windows per league
    const nowMs = Date.parse('2026-11-22T12:00:00Z');
    const supabase = createMockSupabase({
      'scan_log:select': () => ({ data: [], error: null }),
      'teams:select': () => ({ data: [], error: null }),
      'teams:upsert': () => ({ error: null }),
      'scan_log:insert': () => ({ error: null }),
    });

    // Case 1: window 1 throws a network error on every league
    // Each attempted league uses 1 request; after 7 leagues (7 requests), 7 + 2 > 8 -> remaining 5 skipped
    const win1ThrowFetch = createMockFetch(async () => {
      throw new Error('ECONNRESET');
    });
    const win1Handler = createScanAllHandler({
      getSupabase: () => supabase,
      fetchImpl: win1ThrowFetch,
      now: () => nowMs,
      env: baseEnv,
      cache: new Map(),
    });
    const win1Res = createMockRes();
    await win1Handler(
      createMockReq({ headers: { authorization: 'Bearer cron-secret-xyz' } }),
      win1Res
    );

    assert.equal(win1Res.statusCode, 503);
    assert.equal(win1Res.body.success, false);
    assert.equal(win1Res.body.leaguesScanned, 0);
    assert.ok(win1ThrowFetch.calls.length <= 8, `Expected <= 8 fetches, got ${win1ThrowFetch.calls.length}`);
    assert.equal(win1ThrowFetch.calls.length, 7);
    assert.equal(win1Res.body.upstreamRequests, 7);
    assert.equal(win1Res.body.results.length, 12);
    assert.equal(
      win1Res.body.results.slice(7).every((r) => r.skipped && r.reason === 'request_budget'),
      true
    );

    // Case 2: window 1 succeeds (200), window 2 throws a timeout/JSON error
    // Each attempted league uses 2 requests; after 4 leagues (8 requests), remaining 8 skipped
    const win2ThrowFetch = createMockFetch(async (_url, _opts, callNum) => {
      if (callNum % 2 === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ competition: { name: 'League' }, matches: [] }),
        };
      }
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    const win2Handler = createScanAllHandler({
      getSupabase: () => supabase,
      fetchImpl: win2ThrowFetch,
      now: () => nowMs,
      env: baseEnv,
      cache: new Map(),
    });
    const win2Res = createMockRes();
    await win2Handler(
      createMockReq({ headers: { authorization: 'Bearer cron-secret-xyz' } }),
      win2Res
    );

    assert.equal(win2Res.statusCode, 503);
    assert.equal(win2Res.body.success, false);
    assert.equal(win2Res.body.leaguesScanned, 0);
    assert.equal(win2ThrowFetch.calls.length, 8);
    assert.equal(win2Res.body.upstreamRequests, 8);
    assert.equal(win2Res.body.results.length, 12);
    assert.equal(
      win2Res.body.results.slice(4).every((r) => r.skipped && r.reason === 'request_budget'),
      true
    );
  });

  it('counts null or malformed JSON payloads toward MAX_UPSTREAM_REQUESTS_PER_RUN <= 8 and returns 503 (#6)', async () => {
    // 2026-11-22 -> 2 windows per league
    const nowMs = Date.parse('2026-11-22T12:00:00Z');
    const supabase = createMockSupabase({
      'scan_log:select': () => ({ data: [], error: null }),
      'teams:select': () => ({ data: [], error: null }),
      'teams:upsert': () => ({ error: null }),
      'scan_log:insert': () => ({ error: null }),
    });

    for (const badPayload of [null, { matches: 'not-an-array' }, { matches: [null, undefined, { id: null }] }]) {
      const cache = new Map();
      const mockFetch = createMockFetch(async () => ({
        ok: true,
        status: 200,
        json: async () => badPayload,
      }));
      const handler = createScanAllHandler({
        getSupabase: () => supabase,
        fetchImpl: mockFetch,
        now: () => nowMs,
        env: baseEnv,
        cache,
      });
      const res = createMockRes();
      await handler(
        createMockReq({ headers: { authorization: 'Bearer cron-secret-xyz' } }),
        res
      );

      assert.equal(res.statusCode, 503);
      assert.equal(res.body.success, false);
      assert.equal(res.body.leaguesScanned, 0);
      assert.ok(mockFetch.calls.length <= 8, `Expected <= 8 fetches, got ${mockFetch.calls.length}`);
      assert.equal(mockFetch.calls.length, 7);
      assert.equal(res.body.upstreamRequests, 7);
      assert.equal(cache.size, 0);
      assert.equal(res.body.results.length, 12);
      assert.equal(
        res.body.results.slice(7).every((r) => r.skipped && r.reason === 'request_budget'),
        true
      );
    }
  });

  it('preserves requestsMade when supabase.from("teams").upsert throws/rejects and enforces budget <= 8 (#6)', async () => {
    // 2026-11-22 -> 2 windows per league
    const nowMs = Date.parse('2026-11-22T12:00:00Z');
    const supabase = createMockSupabase({
      'scan_log:select': () => ({ data: [], error: null }),
      'teams:select': () => ({ data: [], error: null }),
      'teams:upsert': () => {
        throw new Error('Supabase network disconnect');
      },
      'scan_log:insert': () => ({ error: null }),
    });

    const mockFetch = createMockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        competition: { name: 'League' },
        matches: [
          makeMatch(1, '2025-02-01T15:00:00Z', 1, 2, {
            homeGoals: 2,
            awayGoals: 0,
            winner: 'HOME_TEAM',
          }),
        ],
      }),
    }));

    const handler = createScanAllHandler({
      getSupabase: () => supabase,
      fetchImpl: mockFetch,
      now: () => nowMs,
      env: baseEnv,
      cache: new Map(),
    });

    const res = createMockRes();
    await handler(
      createMockReq({ headers: { authorization: 'Bearer cron-secret-xyz' } }),
      res
    );

    assert.equal(res.statusCode, 503);
    assert.equal(res.getHeader('cache-control'), 'no-store');
    assert.equal(res.body.success, false);
    assert.equal(res.body.leaguesScanned, 0);
    assert.ok(mockFetch.calls.length <= 8, `Expected <= 8 fetches, got ${mockFetch.calls.length}`);
    assert.equal(mockFetch.calls.length, 8);
    assert.equal(res.body.upstreamRequests, 8);
    assert.equal(res.body.results.length, 12);
    assert.equal(
      res.body.results.slice(0, 4).every((r) => Boolean(r.error) && r.requestsMade === 2),
      true
    );
    assert.equal(
      res.body.results.slice(4).every((r) => r.skipped && r.reason === 'request_budget'),
      true
    );
  });

  it('produces homogeneous upsert keys with first_detected and defaultToNull: false for mixed existing and new teams', async () => {
    const nowMs = Date.parse('2025-03-10T12:00:00Z');
    const expectedCheckedAt = new Date(nowMs).toISOString();
    const existingRow = {
      team_id: 10,
      logo: 'https://old.logo/10.png',
      has_5_wins: true,
      max_streak: 6,
      streak_achieved_date: '2025-01-10',
      first_detected: '2025-01-10T12:00:00Z',
    };

    const matchPayload = {
      competition: { name: 'Premier League', area: { name: 'England', flag: null } },
      matches: [
        makeMatch(1, '2025-03-01T15:00:00Z', 10, 20, {
          homeGoals: 2,
          awayGoals: 1,
          winner: 'HOME_TEAM',
        }),
      ],
    };

    // Verify api/scan.js
    const scanSupabase = createMockSupabase({
      'scan_log:select': () => ({ data: [], error: null }),
      'teams:select': () => ({ data: [existingRow], error: null }),
      'teams:upsert': () => ({ error: null }),
      'scan_log:insert': () => ({ error: null }),
    });
    const scanHandler = createScanHandler({
      getSupabase: () => scanSupabase,
      fetchImpl: createMockFetch(async () => ({
        ok: true,
        status: 200,
        json: async () => matchPayload,
      })),
      now: () => nowMs,
      env: baseEnv,
      cache: new Map(),
    });

    const scanRes = createMockRes();
    await scanHandler(
      createMockReq({
        query: { competition: 'PL' },
        headers: { authorization: 'Bearer cron-secret-xyz' },
      }),
      scanRes
    );
    assert.equal(scanRes.statusCode, 200);

    const scanUpsert = scanSupabase.calls.find((c) => c.table === 'teams' && c.op === 'upsert');
    assert.ok(scanUpsert, 'Expected teams upsert call from api/scan.js');
    assert.equal(scanUpsert.opOptions.defaultToNull, false);
    assert.equal(scanUpsert.payload.length, 2);

    const scanExisting = scanUpsert.payload.find((r) => r.team_id === 10);
    const scanNew = scanUpsert.payload.find((r) => r.team_id === 20);
    assert.equal(scanExisting.first_detected, '2025-01-10T12:00:00Z');
    assert.equal(scanNew.first_detected, expectedCheckedAt);
    assert.deepEqual(Object.keys(scanExisting).sort(), Object.keys(scanNew).sort());

    // Verify api/scan-all.js
    const scanAllSupabase = createMockSupabase({
      'scan_log:select': () => ({ data: [], error: null }),
      'teams:select': () => ({ data: [existingRow], error: null }),
      'teams:upsert': () => ({ error: null }),
      'scan_log:insert': () => ({ error: null }),
    });
    const scanAllHandler = createScanAllHandler({
      getSupabase: () => scanAllSupabase,
      fetchImpl: createMockFetch(async () => ({
        ok: true,
        status: 200,
        json: async () => matchPayload,
      })),
      now: () => nowMs,
      env: baseEnv,
      cache: new Map(),
    });

    const scanAllRes = createMockRes();
    await scanAllHandler(
      createMockReq({ headers: { authorization: 'Bearer cron-secret-xyz' } }),
      scanAllRes
    );
    assert.equal(scanAllRes.statusCode, 200);

    const scanAllUpsert = scanAllSupabase.calls.find((c) => c.table === 'teams' && c.op === 'upsert');
    assert.ok(scanAllUpsert, 'Expected teams upsert call from api/scan-all.js');
    assert.equal(scanAllUpsert.opOptions.defaultToNull, false);
    const allExisting = scanAllUpsert.payload.find((r) => r.team_id === 10);
    const allNew = scanAllUpsert.payload.find((r) => r.team_id === 20);
    assert.equal(allExisting.first_detected, '2025-01-10T12:00:00Z');
    assert.equal(allNew.first_detected, expectedCheckedAt);
    assert.deepEqual(Object.keys(allExisting).sort(), Object.keys(allNew).sort());
  });

  it('returns 503 with success: false when pre-scan elapsed time skips all 12 competitions due to timeout', async () => {
    let clockMs = Date.parse('2026-11-22T12:00:00Z');
    let fetchCalls = 0;

    const supabase = createMockSupabase({
      'scan_log:select': () => {
        // Simulate slow initial DB scan_log lookup consuming >= MAX_RUN_MS (6500ms)
        clockMs += 7000;
        return { data: [], error: null };
      },
    });

    const handler = createScanAllHandler({
      getSupabase: () => supabase,
      fetchImpl: async () => {
        fetchCalls++;
        throw new Error('Should not fetch when already timed out');
      },
      now: () => clockMs,
      env: baseEnv,
      cache: new Map(),
    });

    const res = createMockRes();
    await handler(
      createMockReq({ headers: { authorization: 'Bearer cron-secret-xyz' } }),
      res
    );

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.success, false);
    assert.equal(res.body.leaguesScanned, 0);
    assert.equal(fetchCalls, 0);
    assert.equal(res.body.results.length, 12);
    assert.equal(
      res.body.results.every((r) => r.skipped && r.reason === 'timeout'),
      true
    );
  });

  it('enforces shared deadlineMs across multi-window fetches in fetchCompetitionMatches and scan-all', async () => {
    // Direct test on fetchCompetitionMatches with 2 windows (2026-11-22)
    let clockMs = Date.parse('2026-11-22T12:00:00Z');
    const startTime = clockMs;
    const deadlineMs = startTime + 5000;
    let directCalls = 0;

    const directResult = await fetchCompetitionMatches('PL', 'test-key', '2026-11-22', {
      cache: new Map(),
      timeoutMs: 3500,
      deadlineMs,
      now: () => clockMs,
      fetchImpl: async () => {
        directCalls++;
        // Window 1 consumes past the shared deadline
        clockMs += 5100;
        return {
          ok: true,
          status: 200,
          json: async () => ({ competition: { name: 'Premier League' }, matches: [] }),
        };
      },
    });

    assert.equal(directResult.ok, false);
    assert.equal(directResult.status, 503);
    assert.equal(directCalls, 1, 'Window 2 must not be issued after shared deadline expires');
    assert.equal(directResult.requestsMade, 1);

    // End-to-end test in scan-all: pre-scan takes 5400ms (< MAX_RUN_MS=6500ms),
    // Window 1 takes 3700ms (total elapsed 9100ms >= HARD_DEADLINE_MS=9000ms) -> Window 2 aborted
    let scanClock = Date.parse('2026-11-22T12:00:00Z');
    const scanStart = scanClock;
    let preScanAdvanced = false;
    const scanSupabase = createMockSupabase({
      'scan_log:select': () => {
        if (!preScanAdvanced) {
          preScanAdvanced = true;
          scanClock += 5400;
        }
        return { data: [], error: null };
      },
      'teams:select': () => ({ data: [], error: null }),
      'teams:upsert': () => ({ error: null }),
      'scan_log:insert': () => ({ error: null }),
    });

    const scanFetch = createMockFetch(async () => {
      scanClock += 3700;
      return {
        ok: true,
        status: 200,
        json: async () => ({ competition: { name: 'League' }, matches: [] }),
      };
    });

    const scanAllHandler = createScanAllHandler({
      getSupabase: () => scanSupabase,
      fetchImpl: scanFetch,
      now: () => scanClock,
      env: baseEnv,
      cache: new Map(),
    });

    const res = createMockRes();
    await scanAllHandler(
      createMockReq({ headers: { authorization: 'Bearer cron-secret-xyz' } }),
      res
    );

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.success, false);
    assert.equal(scanFetch.calls.length, 1, 'Window 2 must not start once HARD_DEADLINE_MS is reached');
    assert.equal(res.body.upstreamRequests, 1);
    assert.ok(scanClock - scanStart < HARD_DEADLINE_MS + 3500);
    assert.equal(res.body.results[0].status, 503);
    assert.equal(
      res.body.results.slice(1).every((r) => r.skipped && r.reason === 'timeout'),
      true
    );
  });
});

