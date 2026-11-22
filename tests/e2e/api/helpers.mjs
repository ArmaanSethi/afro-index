import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, '../../..');

let importSeq = 0;

/**
 * Cache-busting dynamic ESM import for Vercel API handlers.
 * @param {string} relPathFromRepoRoot e.g. 'api/united.js'
 */
export async function importFresh(relPathFromRepoRoot) {
  const absPath = path.resolve(REPO_ROOT, relPathFromRepoRoot);
  const url = new URL(`file://${absPath}?v=${++importSeq}-${Date.now()}`);
  const mod = await import(url.href);
  return mod.default ?? mod;
}

/**
 * Temporarily set/unset process.env keys and restore in finally.
 */
export async function withEnv(overrides, fn) {
  const saved = new Map();
  for (const [k, v] of Object.entries(overrides)) {
    saved.set(k, Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined);
    if (v === undefined || v === null) {
      delete process.env[k];
    } else {
      process.env[k] = String(v);
    }
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved.entries()) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

function coerceComparable(rawVal, sample) {
  if (rawVal === 'null') return null;
  if (typeof sample === 'boolean') {
    if (rawVal === 'true') return true;
    if (rawVal === 'false') return false;
  }
  if (typeof sample === 'number') {
    const n = Number(rawVal);
    if (!Number.isNaN(n)) return n;
  }
  if (rawVal === 'true') return true;
  if (rawVal === 'false') return false;
  return rawVal;
}

function parseInList(expr) {
  // expr looks like "(1,2,3)" or "(\"PL\",\"PD\")"
  const inner = expr.startsWith('(') && expr.endsWith(')') ? expr.slice(1, -1) : expr;
  if (!inner.trim()) return [];
  const items = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"' && inner[i - 1] !== '\\') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      items.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  items.push(cur);
  return items;
}

function matchesFilter(row, col, expr) {
  const val = row[col];
  if (expr.startsWith('eq.')) {
    const target = coerceComparable(expr.slice(3), val);
    return val === target;
  }
  if (expr.startsWith('neq.')) {
    const target = coerceComparable(expr.slice(4), val);
    return val !== target;
  }
  if (expr.startsWith('gt.')) {
    const target = coerceComparable(expr.slice(3), val);
    return val !== null && val !== undefined && val > target;
  }
  if (expr.startsWith('gte.')) {
    const target = coerceComparable(expr.slice(4), val);
    return val !== null && val !== undefined && val >= target;
  }
  if (expr.startsWith('lt.')) {
    const target = coerceComparable(expr.slice(3), val);
    return val !== null && val !== undefined && val < target;
  }
  if (expr.startsWith('lte.')) {
    const target = coerceComparable(expr.slice(4), val);
    return val !== null && val !== undefined && val <= target;
  }
  if (expr.startsWith('is.')) {
    const target = expr.slice(3);
    if (target === 'null') return val === null || val === undefined;
    if (target === 'true') return val === true;
    if (target === 'false') return val === false;
    return false;
  }
  if (expr.startsWith('in.')) {
    const list = parseInList(expr.slice(3)).map((item) => coerceComparable(item, val));
    return list.includes(val);
  }
  throw new Error(`Unsupported filter operator: ${expr}`);
}

function sortRows(rows, orderParam) {
  if (!orderParam) return rows;
  const specs = orderParam.split(',').map((part) => {
    const tokens = part.trim().split('.');
    const col = tokens[0];
    const dir = tokens[1] === 'desc' ? 'desc' : 'asc';
    let nulls = dir === 'asc' ? 'nullslast' : 'nullsfirst';
    if (tokens[2] === 'nullsfirst' || tokens[2] === 'nullslast') {
      nulls = tokens[2];
    }
    return { col, dir, nulls };
  });

  return [...rows].sort((a, b) => {
    for (const { col, dir, nulls } of specs) {
      const av = a[col];
      const bv = b[col];
      const aNull = av === null || av === undefined;
      const bNull = bv === null || bv === undefined;
      if (aNull && bNull) continue;
      if (aNull) return nulls === 'nullsfirst' ? -1 : 1;
      if (bNull) return nulls === 'nullsfirst' ? 1 : -1;
      if (av < bv) return dir === 'asc' ? -1 : 1;
      if (av > bv) return dir === 'asc' ? 1 : -1;
    }
    return 0;
  });
}

function projectRow(row, selectParam) {
  if (!selectParam || selectParam.trim() === '*') {
    return structuredClone(row);
  }
  const cols = selectParam
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const out = {};
  for (const col of cols) {
    if (col === '*') {
      Object.assign(out, structuredClone(row));
    } else if (Object.prototype.hasOwnProperty.call(row, col)) {
      out[col] = structuredClone(row[col]);
    } else {
      out[col] = null;
    }
  }
  return out;
}

const RESERVED_QUERY_KEYS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);
const VALID_FILTER_RE = /^(eq|neq|gt|gte|lt|lte|is|in)\./;
const TABLE_COLUMNS = {
  teams: new Set([
    'id',
    'team_id',
    'sport',
    'name',
    'logo',
    'country_name',
    'country_flag',
    'league_id',
    'league_name',
    'form',
    'has_5_wins',
    'max_streak',
    'streak_achieved_date',
    'first_detected',
    'last_checked',
  ]),
  scan_log: new Set([
    'id',
    'sport',
    'league_id',
    'league_name',
    'teams_scanned',
    'teams_qualified',
    'scanned_at',
  ]),
};

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

/**
 * Ephemeral local mock Supabase PostgREST HTTP server wire-compatible with @supabase/supabase-js.
 */
export async function createMockSupabaseServer() {
  const db = {
    teams: [],
    scan_log: [],
  };
  const requests = [];
  let errorMatcher = null;
  let maxRows = null;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let parsedBody = null;
    let jsonParseError = false;
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        jsonParseError = true;
        parsedBody = rawBody;
      }
    }

    const urlObj = new URL(req.url, 'http://127.0.0.1');
    const reqInfo = {
      method: req.method,
      path: urlObj.pathname,
      query: Object.fromEntries(urlObj.searchParams.entries()),
      searchParams: urlObj.searchParams,
      headers: req.headers,
      body: parsedBody,
    };
    requests.push(reqInfo);

    if (errorMatcher) {
      const errResp = typeof errorMatcher === 'function' ? errorMatcher(reqInfo) : errorMatcher;
      if (errResp) {
        const status = errResp.status ?? 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            code: errResp.code ?? 'PGRST500',
            details: errResp.details ?? 'Injected mock Supabase error',
            hint: errResp.hint ?? null,
            message: errResp.message ?? 'Mock PostgREST failure',
          }),
        );
        return;
      }
    }

    const match = /^\/rest\/v1\/([a-zA-Z0-9_]+)$/.exec(urlObj.pathname);
    if (!match || !Object.prototype.hasOwnProperty.call(db, match[1])) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'PGRST205', message: `Table not found: ${urlObj.pathname}` }));
      return;
    }

    const table = match[1];
    const prefer = String(req.headers['prefer'] || '');

    // Collect & validate filters
    const filters = [];
    for (const [k, v] of urlObj.searchParams.entries()) {
      if (!RESERVED_QUERY_KEYS.has(k)) {
        if (!VALID_FILTER_RE.test(v)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              code: 'PGRST100',
              message: `Unsupported or malformed filter operator for column "${k}": "${v}"`,
            }),
          );
          return;
        }
        filters.push([k, v]);
      }
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      let offset = 0;
      let limit = null;
      if (urlObj.searchParams.has('offset')) {
        const rawOffset = urlObj.searchParams.get('offset');
        if (!/^\d+$/.test(rawOffset)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              code: 'PGRST100',
              message: `Invalid offset parameter: "${rawOffset}"`,
            }),
          );
          return;
        }
        offset = Number(rawOffset);
      }
      if (urlObj.searchParams.has('limit')) {
        const rawLimit = urlObj.searchParams.get('limit');
        if (!/^\d+$/.test(rawLimit)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              code: 'PGRST100',
              message: `Invalid limit parameter: "${rawLimit}"`,
            }),
          );
          return;
        }
        limit = Number(rawLimit);
      }

      let rows = db[table].filter((row) => filters.every(([col, expr]) => matchesFilter(row, col, expr)));
      const total = rows.length;
      rows = sortRows(rows, urlObj.searchParams.get('order'));
      const rangeHeader = req.headers['range'];
      if (typeof rangeHeader === 'string' && /^\d+-\d*$/.test(rangeHeader)) {
        const [startStr, endStr] = rangeHeader.split('-');
        offset = Number(startStr);
        if (endStr !== '') {
          limit = Math.max(0, Number(endStr) - offset + 1);
        }
      }
      if (maxRows !== null && (limit === null || limit > maxRows)) {
        limit = maxRows;
      }

      const sliced = limit === null ? rows.slice(offset) : rows.slice(offset, offset + limit);
      const selectParam = urlObj.searchParams.get('select');
      const projected = sliced.map((r) => projectRow(r, selectParam));

      const headers = { 'Content-Type': 'application/json' };
      if (req.method === 'HEAD' || prefer.includes('count=exact')) {
        if (total === 0) {
          headers['Content-Range'] = '*/0';
        } else {
          const endIdx = sliced.length > 0 ? offset + sliced.length - 1 : offset;
          headers['Content-Range'] = `${offset}-${endIdx}/${total}`;
        }
      }

      res.writeHead(200, headers);
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(JSON.stringify(projected));
      }
      return;
    }

    if (req.method === 'POST') {
      if (jsonParseError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'PGRST102', message: 'Invalid JSON body' }));
        return;
      }
      if (rawBody) {
        const validPayload = Array.isArray(parsedBody)
          ? parsedBody.every((el) => isPlainObject(el))
          : isPlainObject(parsedBody);
        if (!validPayload) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              code: 'PGRST102',
              message: 'POST body must be a JSON object or array of objects',
            }),
          );
          return;
        }
      }

      const incoming = Array.isArray(parsedBody) ? parsedBody : parsedBody ? [parsedBody] : [];
      const onConflictParam = urlObj.searchParams.get('on_conflict');
      const conflictCols = onConflictParam
        ? onConflictParam.split(',').map((c) => c.trim()).filter(Boolean)
        : [];
      const mergeDuplicates = prefer.includes('resolution=merge-duplicates');
      const ignoreDuplicates = prefer.includes('resolution=ignore-duplicates');
      const returnRep = prefer.includes('return=representation');

      const knownCols = TABLE_COLUMNS[table];
      for (const c of conflictCols) {
        if (!knownCols.has(c)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              code: '42P10',
              message: `Unknown on_conflict column "${c}" for table "${table}"`,
            }),
          );
          return;
        }
      }

      const nowIso = new Date().toISOString();
      const prepared = [];
      for (const rawItem of incoming) {
        const item = structuredClone(rawItem);
        if (table === 'teams') {
          if (!item.sport) item.sport = 'football';
          if (!item.last_checked) item.last_checked = nowIso;
        } else if (table === 'scan_log') {
          if (!item.sport) item.sport = 'football';
          if (!item.scanned_at) item.scanned_at = nowIso;
        }
        for (const c of conflictCols) {
          if (item[c] === undefined) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                code: '42P10',
                message: `Missing on_conflict column "${c}" in upserted row`,
              }),
            );
            return;
          }
        }
        prepared.push(item);
      }

      const affected = [];
      for (const item of prepared) {
        let existingIdx = -1;
        if (conflictCols.length > 0) {
          existingIdx = db[table].findIndex((row) =>
            conflictCols.every((c) => row[c] !== undefined && item[c] !== undefined && String(row[c]) === String(item[c])),
          );
        }

        if (existingIdx !== -1) {
          if (ignoreDuplicates) {
            continue;
          }
          if (mergeDuplicates || conflictCols.length > 0) {
            const existing = db[table][existingIdx];
            const merged = {
              ...existing,
              ...item,
              id: existing.id,
              first_detected: item.first_detected ?? existing.first_detected ?? nowIso,
            };
            db[table][existingIdx] = merged;
            affected.push(merged);
            continue;
          }
        }

        const inserted = {
          id: item.id ?? crypto.randomUUID(),
          ...(table === 'teams' ? { first_detected: item.first_detected ?? nowIso } : {}),
          ...item,
        };
        db[table].push(inserted);
        affected.push(inserted);
      }

      if (returnRep) {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(affected));
      } else {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end();
      }
      return;
    }

    if (req.method === 'PATCH') {
      if (jsonParseError || (rawBody && !isPlainObject(parsedBody))) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'PGRST102', message: 'PATCH body must be a valid JSON object' }));
        return;
      }
      const updated = [];
      for (let i = 0; i < db[table].length; i++) {
        if (filters.every(([col, expr]) => matchesFilter(db[table][i], col, expr))) {
          db[table][i] = { ...db[table][i], ...(parsedBody || {}) };
          updated.push(db[table][i]);
        }
      }
      if (prefer.includes('return=representation')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(updated));
      } else {
        res.writeHead(204);
        res.end();
      }
      return;
    }

    if (req.method === 'DELETE') {
      const kept = [];
      const removed = [];
      for (const row of db[table]) {
        if (filters.every(([col, expr]) => matchesFilter(row, col, expr))) {
          removed.push(row);
        } else {
          kept.push(row);
        }
      }
      db[table] = kept;
      if (prefer.includes('return=representation')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(removed));
      } else {
        res.writeHead(204);
        res.end();
      }
      return;
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Method not allowed' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();

  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    db,
    requests,
    setError(fn) {
      errorMatcher = fn;
    },
    setMaxRows(n) {
      maxRows = n;
    },
    reset() {
      db.teams.length = 0;
      db.scan_log.length = 0;
      requests.length = 0;
      errorMatcher = null;
      maxRows = null;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Intercepts globalThis.fetch ONLY for api.football-data.org.
 * All localhost / Mock PostgREST requests pass straight through to realFetch.
 */
export function installMockFetch(routerFn) {
  const realFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async function mockedFetch(input, init = {}) {
    const urlStr =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input && typeof input.url === 'string'
            ? input.url
            : String(input);

    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch {
      return realFetch(input, init);
    }

    if (parsed.hostname !== 'api.football-data.org') {
      return realFetch(input, init);
    }

    const headers = {};
    if (init.headers) {
      if (typeof init.headers.forEach === 'function') {
        init.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) {
          headers[String(k).toLowerCase()] = v;
        }
      } else {
        for (const [k, v] of Object.entries(init.headers)) {
          headers[k.toLowerCase()] = v;
        }
      }
    }

    const callInfo = {
      url: urlStr,
      pathname: parsed.pathname,
      searchParams: parsed.searchParams,
      headers,
      method: init.method || 'GET',
    };
    calls.push(callInfo);

    const signal = init.signal;
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const reply = (await routerFn(callInfo, init)) || { status: 200, body: { matches: [] } };

    if (reply.delayMs && reply.delayMs > 0) {
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, reply.delayMs);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }

    if (reply.throwError) {
      throw reply.throwError;
    }

    const status = reply.status ?? 200;
    const bodyText =
      reply.body === undefined || reply.body === null
        ? ''
        : typeof reply.body === 'string'
          ? reply.body
          : JSON.stringify(reply.body);

    return new Response(bodyText, {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...(reply.headers || {}),
      },
    });
  };

  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

/**
 * Invoke a Vercel serverless (req, res) handler and capture status, headers, and parsed body.
 */
export async function invokeHandler(handler, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const query = opts.query || {};
  const headers = {};
  for (const [k, v] of Object.entries(opts.headers || {})) {
    headers[k.toLowerCase()] = v;
  }

  const req = {
    method,
    query,
    headers,
    url: opts.url || '/',
  };

  let statusCode = 200;
  const resHeaders = new Map();
  let ended = false;
  let body = undefined;

  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(code) {
      statusCode = code;
    },
    setHeader(k, v) {
      resHeaders.set(String(k).toLowerCase(), v);
      return res;
    },
    getHeader(k) {
      return resHeaders.get(String(k).toLowerCase());
    },
    removeHeader(k) {
      resHeaders.delete(String(k).toLowerCase());
      return res;
    },
    status(code) {
      statusCode = code;
      return res;
    },
    json(obj) {
      resHeaders.set('content-type', 'application/json');
      body = obj;
      ended = true;
      return res;
    },
    send(val) {
      if (typeof val === 'string') {
        try {
          body = JSON.parse(val);
        } catch {
          body = val;
        }
      } else {
        body = val;
      }
      ended = true;
      return res;
    },
    end(val) {
      if (val !== undefined && body === undefined) {
        if (typeof val === 'string' && val.length > 0) {
          try {
            body = JSON.parse(val);
          } catch {
            body = val;
          }
        } else {
          body = val;
        }
      }
      ended = true;
      return res;
    },
  };

  await handler(req, res);

  return {
    status: statusCode,
    headers: Object.fromEntries(resHeaders.entries()),
    body,
    ended,
  };
}

/**
 * Build a football-data.org v4 FINISHED match object.
 */
export function makeMatch({
  id = 1000,
  utcDate = '2025-01-15T15:00:00Z',
  homeTeam = { id: 66, name: 'Manchester United FC', shortName: 'Man United', tla: 'MUN', crest: 'https://crests.football-data.org/66.png' },
  awayTeam = { id: 57, name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS', crest: 'https://crests.football-data.org/57.png' },
  homeGoals = 2,
  awayGoals = 1,
  winner = undefined,
  duration = 'REGULAR',
  competition = { id: 2021, name: 'Premier League', code: 'PL' },
}) {
  let resolvedWinner = winner;
  if (resolvedWinner === undefined) {
    if (homeGoals === null || awayGoals === null) {
      resolvedWinner = null;
    } else if (homeGoals > awayGoals) {
      resolvedWinner = 'HOME_TEAM';
    } else if (awayGoals > homeGoals) {
      resolvedWinner = 'AWAY_TEAM';
    } else {
      resolvedWinner = 'DRAW';
    }
  }
  return {
    id,
    utcDate,
    status: 'FINISHED',
    competition,
    homeTeam,
    awayTeam,
    score: {
      winner: resolvedWinner,
      duration,
      fullTime: {
        home: homeGoals,
        away: awayGoals,
      },
    },
  };
}

/**
 * Build chronological FINISHED matches for a target team.
 * results: array of 'W' | 'D' | 'L' | 'PEN_W' | 'PEN_L' | 'NULL'
 */
export function makeStreakMatches({
  team,
  startDate = '2025-01-01',
  stepDays = 4,
  results = ['W', 'W', 'W', 'W', 'W'],
  idStart = 10000,
  competition = { id: 2021, name: 'Premier League', code: 'PL' },
}) {
  const baseMs = Date.parse(`${startDate}T15:00:00Z`);
  return results.map((res, idx) => {
    const utcDate = new Date(baseMs + idx * stepDays * 86400000).toISOString();
    const oppId = 900 + idx;
    const opp = {
      id: oppId,
      name: `Opponent ${idx + 1} FC`,
      shortName: `Opp ${idx + 1}`,
      tla: `OP${idx + 1}`,
      crest: `https://crests.football-data.org/${oppId}.png`,
    };
    if (res === 'W') {
      return makeMatch({ id: idStart + idx, utcDate, homeTeam: team, awayTeam: opp, homeGoals: 2, awayGoals: 0, winner: 'HOME_TEAM', competition });
    }
    if (res === 'L') {
      return makeMatch({ id: idStart + idx, utcDate, homeTeam: team, awayTeam: opp, homeGoals: 0, awayGoals: 2, winner: 'AWAY_TEAM', competition });
    }
    if (res === 'D') {
      return makeMatch({ id: idStart + idx, utcDate, homeTeam: team, awayTeam: opp, homeGoals: 1, awayGoals: 1, winner: 'DRAW', competition });
    }
    if (res === 'PEN_W') {
      return makeMatch({ id: idStart + idx, utcDate, homeTeam: team, awayTeam: opp, homeGoals: 1, awayGoals: 1, winner: 'HOME_TEAM', duration: 'PENALTY_SHOOTOUT', competition });
    }
    if (res === 'PEN_L') {
      return makeMatch({ id: idStart + idx, utcDate, homeTeam: team, awayTeam: opp, homeGoals: 1, awayGoals: 1, winner: 'AWAY_TEAM', duration: 'PENALTY_SHOOTOUT', competition });
    }
    // NULL
    return makeMatch({ id: idStart + idx, utcDate, homeTeam: team, awayTeam: opp, homeGoals: null, awayGoals: null, winner: null, competition });
  });
}
