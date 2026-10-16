import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, PUBLIC_KEY_PATH, SCOPES, loadEnvironment, readConfig } from './lib/config.mjs';
import { AppError, AUTHORIZE_URL, tokenRequest, fleetGet, vehicleSummary, vehicleDetails, oauthCallbackCode } from './lib/tesla.mjs';

import { garageApi, scopesFor } from './lib/garage.mjs';
import { loginScopes } from './lib/settings.mjs';

const SESSION_AGE = 7 * 24 * 60 * 60 * 1000;
const CACHE_AGE = 60_000;
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/car.svg', ['car.svg', 'image/svg+xml']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  [PUBLIC_KEY_PATH, [PUBLIC_KEY_PATH.slice(1), 'application/x-pem-file']],
]);
const random = () => randomBytes(32).toString('base64url');
const equal = (left, right) => typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));

export function createApp(config, { fetchImpl = fetch } = {}) {
  const sessions = new Map();
  const allowedHosts = new Set([new URL(config.origin).host, `localhost:${config.port}`, `127.0.0.1:${config.port}`]);
  const origins = new Set([config.origin, `http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`]);
  const cookie = (id, maxAge = SESSION_AGE / 1000) => `tesla_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${config.secure ? '; Secure' : ''}`;
  const destroy = (id) => {
    const session = sessions.get(id);
    if (session) { session.destroyed = true; session.tokens = null; session.cache.clear(); }
    sessions.delete(id);
  };
  const cleanup = setInterval(() => {
    for (const [id, session] of sessions) if (session.expiresAt < Date.now()) destroy(id);
  }, 60_000);
  cleanup.unref();

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const redirect = (location) => { res.writeHead(303, { Location: location }); res.end(); };
    try {
      if (!allowedHosts.has(req.headers.host)) throw new AppError(403, 'Unrecognized application host.');
      const url = new URL(req.url, config.origin);
      const id = req.headers.cookie?.match(/(?:^|;\s*)tesla_session=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
      let session = sessions.get(id);
      if (session && session.expiresAt < Date.now()) { destroy(id); session = undefined; }
      if (req.method === 'POST' && (!origins.has(req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site')) {
        throw new AppError(403, 'This request must come from the app.');
      }
      if (req.method === 'GET' && url.pathname === '/api/session') {
        const publicKeyReady = await access(config.publicKeyFile).then(() => true, () => false);
        return json(200, {
          connected: Boolean(session?.tokens), credentialsConfigured: Boolean(config.clientId && config.clientSecret),
          appUrlConfigured: config.appUrlConfigured, publicKeyReady,
          callbackUrl: config.redirectUri, appUrl: config.origin, region: config.region,
          loginUrl: `${config.origin}/auth/login`, scopes: scopesFor(session || {}), commandsAvailable: false,
        });
      }
      if (req.method === 'GET' && url.pathname === '/auth/login') {
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, 'Start sign-in from the app.');
        if (!config.clientId || !config.clientSecret || !config.appUrlConfigured) return redirect('/?error=setup');
        // Begin and finish on the same host so the state cookie survives the callback.
        if (req.headers.host !== new URL(config.origin).host) return redirect(`${config.origin}/auth/login`);
        if (sessions.size >= 1000) throw new AppError(429, 'Too many sign-in attempts. Please try later.');
        const scope = loginScopes(url.searchParams.get('features'), scopesFor(session || {}));
        if (id) destroy(id);
        const newId = random();
        session = { expiresAt: Date.now() + SESSION_AGE, oauth: { state: random(), expiresAt: Date.now() + 600_000 }, tokens: null, cache: new Map(), pending: new Map() };
        sessions.set(newId, session);
        res.setHeader('Set-Cookie', cookie(newId));
        const authorize = new URL(AUTHORIZE_URL);
        authorize.search = new URLSearchParams({ client_id: config.clientId, response_type: 'code', redirect_uri: config.redirectUri, scope, state: session.oauth.state, prompt_missing_scopes: 'true' }).toString();
        return redirect(authorize.toString());
      }
      if (req.method === 'GET' && url.pathname === '/auth/callback') {
        const oauth = session?.oauth;
        if (!oauth || oauth.expiresAt < Date.now() || !equal(oauth.state, url.searchParams.get('state'))) return redirect('/?error=state');
        session.oauth = null;
        if (url.searchParams.has('error')) return redirect('/?error=denied');
        const code = url.searchParams.get('code');
        if (!code || code.length > 8192) return redirect('/?error=authorization');
        try {
          const tokens = await tokenRequest(config, { grant_type: 'authorization_code', code, client_secret: config.clientSecret, audience: config.audience, redirect_uri: config.redirectUri }, fetchImpl);
          if (session.destroyed) return redirect('/?error=state');
          // Rotate the session identifier after authentication.
          const newId = random();
          sessions.delete(id);
          session.tokens = tokens;
          session.expiresAt = Date.now() + SESSION_AGE;
          sessions.set(newId, session);
          res.setHeader('Set-Cookie', cookie(newId));
          return redirect('/');
        } catch (error) { return redirect(`/?error=${oauthCallbackCode(error)}`); }
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        if (id) destroy(id);
        res.setHeader('Set-Cookie', cookie('', 0));
        return json(200, { ok: true });
      }
      if (url.pathname.startsWith('/api/')) {
        if (!session?.tokens) throw new AppError(401, 'Connect your Tesla account to continue.');
        // Coalesce requests and cache results so repeat clicks do not issue duplicate paid calls.
        const cached = async (key, operation) => {
          const previous = session.cache.get(key);
          if (previous && Date.now() - previous.time < CACHE_AGE) return previous.value;
          if (!session.pending.has(key)) {
            session.pending.set(key, (async () => {
              const value = await operation();
              if (!session.destroyed) session.cache.set(key, { value, time: Date.now() });
              return value;
            })());
          }
          const pending = session.pending.get(key);
          try { return await pending; }
          finally { if (session.pending.get(key) === pending) session.pending.delete(key); }
        };
        if (req.method === 'GET' && url.pathname === '/api/vehicles') {
          const vehicles = await cached('vehicles', async () => {
            const response = await fleetGet(session, config, '/api/1/vehicles', fetchImpl);
            if (!Array.isArray(response)) throw new AppError(502, 'Tesla returned an invalid vehicle list.');
            return response.map(vehicleSummary);
          });
          return json(200, { vehicles });
        }
        let input = {};
        if (req.method === 'POST') {
          let body = '';
          for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 4096) throw new AppError(413, 'Request is too large.'); }
          try { input = JSON.parse(body || '{}'); if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(); } catch { throw new AppError(400, 'Invalid request.'); }
        }
        return json(200, await garageApi({ session, config, path: url.pathname, method: req.method, input, fetchImpl, cached, forget: (key) => session.cache.delete(key) }));
      }
      if (req.method === 'GET' && FILES.has(url.pathname)) {
        const [file, contentType] = FILES.get(url.pathname);
        const content = await readFile(join(ROOT, 'public', file)).catch(() => null);
        if (!content) throw new AppError(404, 'File not found.');
        res.writeHead(200, { 'Content-Type': contentType });
        return res.end(content);
      }
      throw new AppError(404, 'Page not found.');
    } catch (error) {
      // Never serialize provider responses, tokens, request URLs, or raw exceptions.
      const known = error instanceof AppError;
      json(known ? error.status : 500, { error: known ? error.message : 'Something went wrong. Please try again.', code: known ? error.code : 'internal_error' });
    }
  });
  server.on('close', () => { clearInterval(cleanup); for (const id of sessions.keys()) destroy(id); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    loadEnvironment();
    const config = readConfig();
    const server = createApp(config);
    server.on('error', (error) => {
      console.error(error.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Set a different PORT in .env.` : 'Unable to start the server. Check HOST and PORT.');
      process.exitCode = 1;
      server.close();
    });
    server.listen(config.port, config.host, () => {
      console.log(`Tesla Garage is running at http://localhost:${config.port}`);
      console.log(`Credentials: ${config.clientId && config.clientSecret ? 'configured' : 'missing'}. App URL: ${config.appUrlConfigured ? 'configured' : 'needs setup'}.`);
    });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
