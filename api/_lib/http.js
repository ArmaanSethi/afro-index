import { timingSafeEqual } from 'node:crypto';

export const DEFAULT_FETCH_TIMEOUT_MS = 6000;

export async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  fetchImpl = globalThis.fetch
) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  return fetchImpl(url, {
    ...options,
    signal,
  });
}

export function setCorsHeaders(res, { allowAuthorization = false } = {}) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    allowAuthorization ? 'Content-Type, Authorization' : 'Content-Type'
  );
}

export function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

export function setPublicCache(res, { sMaxAge = 60, staleWhileRevalidate = 300 } = {}) {
  res.setHeader(
    'Cache-Control',
    `s-maxage=${sMaxAge}, stale-while-revalidate=${staleWhileRevalidate}`
  );
}

export function handlePreflightAndMethod(
  req,
  res,
  { allowedMethods = ['GET'], allowAuthorization = false } = {}
) {
  setCorsHeaders(res, { allowAuthorization });

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }

  if (!allowedMethods.includes(req.method)) {
    res.setHeader('Allow', [...allowedMethods, 'OPTIONS'].join(', '));
    setNoStore(res);
    res.status(405).json({ error: 'Method Not Allowed' });
    return true;
  }

  return false;
}

export function isAuthorizedCron(req, secret) {
  if (!secret || typeof secret !== 'string') {
    return false;
  }

  const header = req?.headers?.authorization ?? req?.headers?.Authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return false;
  }

  const token = header.slice('Bearer '.length);
  const tokenBuf = Buffer.from(token, 'utf8');
  const secretBuf = Buffer.from(secret, 'utf8');

  if (tokenBuf.length !== secretBuf.length) {
    return false;
  }

  return timingSafeEqual(tokenBuf, secretBuf);
}
