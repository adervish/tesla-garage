import { AppError, AUTHORIZE_URL, tokenRequest, fleetGet, vehicleSummary, vehicleDetails, oauthCallbackCode } from '../lib/tesla.mjs';
import { PUBLIC_KEY_PATH, REGIONS, SCOPES } from '../lib/settings.mjs';
import { loginScopes } from '../lib/settings.mjs';
import { garageApi, scopesFor } from '../lib/garage.mjs';

const SESSION_AGE = 7 * 24 * 60 * 60 * 1000;
const LOGIN_AGE = 10 * 60 * 1000;
const CACHE_AGE = 60_000;
const COOKIE = '__Host-tesla_session';
const ASSETS = new Set(['/', '/app.js', '/styles.css', '/car.svg', '/favicon.svg', PUBLIC_KEY_PATH]);
const encoder = new TextEncoder();
const base64 = (bytes) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
const unbase64 = (text) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
const random = () => base64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const digest = async (text) => base64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
const json = (status, body) => Response.json(body, { status });
const cookie = (value, age = SESSION_AGE / 1000) => `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${age}`;
const redirect = (location, setCookie) => new Response(null, { status: 303, headers: { Location: location, ...(setCookie ? { 'Set-Cookie': setCookie } : {}) } });

function configuration(env) {
  const origin = new URL(env.APP_URL).origin;
  const region = env.TESLA_REGION || 'na';
  if (!REGIONS[region]) throw new AppError(503, 'The application region needs configuration.');
  return {
    origin, region, redirectUri: `${origin}/auth/callback`,
    clientId: env.CLIENTID || '', clientSecret: env.CLIENTSECRET || '', audience: REGIONS[region],
  };
}

function sessionCookie(request) {
  const match = request.headers.get('Cookie')?.match(/(?:^|;\s*)__Host-tesla_session=([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})(?:;|$)/);
  return match ? { id: match[1], proof: match[2] } : null;
}

function secure(response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store, no-transform');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  headers.set('Strict-Transport-Security', 'max-age=31536000');
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  return new Response(response.body, { status: response.status, headers });
}

function failure(error) {
  return json(error instanceof AppError ? error.status : 500, {
    error: error instanceof AppError ? error.message : 'Something went wrong. Please try again.',
    code: error instanceof AppError ? error.code : 'internal_error',
  });
}

function sessionRequest(env, session, path, method = 'GET', body) {
  const id = env.SESSIONS.idFromName(session.id);
  return env.SESSIONS.get(id).fetch(new Request(`https://session.internal${path}`, {
    method, redirect: 'manual', body, headers: { 'X-Session-Proof': session.proof, 'X-Session-Id': session.id, 'Content-Type': 'application/json' },
  }));
}

async function handle(request, env) {
  const config = configuration(env);
  const url = new URL(request.url);
  if (url.host !== new URL(config.origin).host) throw new AppError(403, 'Unrecognized application host.');
  if (url.protocol !== 'https:') return redirect(`${config.origin}${url.pathname}${url.search}`);
  if (request.method === 'POST' && (request.headers.get('Origin') !== config.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site')) {
    throw new AppError(403, 'This request must come from the app.');
  }
  if (['GET', 'HEAD'].includes(request.method) && ASSETS.has(url.pathname)) {
    const result = await env.ASSETS.fetch(request);
    if (url.pathname === PUBLIC_KEY_PATH && result.ok) {
      const headers = new Headers(result.headers);
      headers.set('Content-Type', 'application/x-pem-file');
      return new Response(result.body, { status: result.status, headers });
    }
    return result;
  }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    const key = `tesla-garage:${request.headers.get('CF-Connecting-IP') || 'local'}`;
    if (env.API_RATE_LIMITER && !(await env.API_RATE_LIMITER.limit({ key })).success) throw new AppError(429, 'Too many requests. Please wait a minute and try again.');
  }
  const session = sessionCookie(request);
  const configured = Boolean(config.clientId && config.clientSecret && env.SESSION_ENCRYPTION_KEY);
  if (request.method === 'GET' && url.pathname === '/api/session') {
    const result = session && configured ? await sessionRequest(env, session, '/status') : null;
    const status = result?.ok ? await result.json() : {};
    return json(200, {
      connected: Boolean(status.connected), credentialsConfigured: Boolean(config.clientId && config.clientSecret),
      appUrlConfigured: true, publicKeyReady: true, callbackUrl: config.redirectUri, appUrl: config.origin,
      region: config.region, loginUrl: `${config.origin}/auth/login`, runtime: 'cloudflare',
      scopes: status.scopes || [], commandsAvailable: Boolean(env.COMMANDS),
    });
  }
  if (request.method === 'GET' && url.pathname === '/auth/login') {
    if (request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new AppError(403, 'Start sign-in from the app.');
    if (!configured) return redirect('/?error=setup');
    let existing = [];
    if (session) {
      const status = await sessionRequest(env, session, '/status');
      if (status.ok) existing = (await status.json()).scopes || [];
      const previous = await sessionRequest(env, session, '/logout', 'POST');
      if (!previous.ok && previous.status !== 401) return previous;
    }
    const scope = loginScopes(url.searchParams.get('features'), existing);
    return sessionRequest(env, { id: random(), proof: random() }, `/start?scope=${encodeURIComponent(scope)}`, 'POST');
  }
  if (request.method === 'GET' && url.pathname === '/auth/callback') {
    if (!session || !configured) return redirect('/?error=state');
    return sessionRequest(env, session, `/callback${url.search}`);
  }
  if (request.method === 'POST' && url.pathname === '/api/logout') {
    if (session && configured) {
      const result = await sessionRequest(env, session, '/logout', 'POST');
      if (!result.ok && result.status !== 401) return result;
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie('', 0) } });
  }
  if (['GET', 'POST'].includes(request.method) && (url.pathname === '/api/vehicles' || /^\/api\/vehicles\/[A-HJ-NPR-Z0-9]{17}\/(refresh|snapshot|history|wake|command|status|alerts|releases)$/.test(url.pathname) || /^\/api\/energy(?:\/\d+)?$/.test(url.pathname))) {
    if (!session || !configured) throw new AppError(401, 'Connect your Tesla account to continue.');
    let body;
    if (request.method === 'POST') {
      const reader = request.body?.getReader();
      const chunks = []; let length = 0;
      if (reader) while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 4096) { await reader.cancel(); throw new AppError(413, 'Request is too large.'); } chunks.push(value); }
      const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      body = new TextDecoder().decode(bytes) || '{}';
      try { const parsed = JSON.parse(body); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); } catch { throw new AppError(400, 'Invalid request.'); }
    }
    return sessionRequest(env, session, url.pathname, request.method, body);
  }
  throw new AppError(404, 'Page not found.');
}

export default {
  async fetch(request, env) {
    try { return secure(await handle(request, env)); }
    catch (error) { return secure(failure(error)); }
  },
};

// Each browser session has its own Durable Object. Serializing operations protects
// Tesla's rotating refresh tokens; encrypted storage survives isolate eviction.
export class TeslaSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = Promise.resolve();
    this.fetchTesla = fetch;
  }

  enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async key() {
    this.encryptionKey ||= crypto.subtle.importKey('raw', unbase64(this.env.SESSION_ENCRYPTION_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
    return this.encryptionKey;
  }

  async load() {
    const encrypted = await this.ctx.storage.get('session');
    if (!encrypted) return null;
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(encrypted.iv) }, await this.key(), unbase64(encrypted.data));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  async save(session) {
    // Durable KV values are bounded. Keep recent history and discard expired
    // cache entries before encrypting the session as one storage record.
    for (const [name, entry] of Object.entries(session.cache || {})) if (Date.now() - entry.time >= CACHE_AGE) delete session.cache[name];
    if (encoder.encode(JSON.stringify(session)).length > 80_000) {
      session.cache = {};
      const histories = Object.values(session.garage?.history || {});
      while (encoder.encode(JSON.stringify(session)).length > 80_000) {
        const oldest = histories.filter((items) => items.length).sort((a, b) => a[0].fetchedAt.localeCompare(b[0].fetchedAt))[0];
        if (!oldest) break;
        oldest.shift();
      }
    }
    const { tokens, oauth, proofHash, expiresAt, cache, garage } = session;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.key(), encoder.encode(JSON.stringify({ tokens, oauth, proofHash, expiresAt, cache, garage })));
    await this.ctx.storage.put('session', { iv: base64(iv), data: base64(new Uint8Array(bytes)) });
  }

  async erase() {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  fetch(request) {
    return this.enqueue(async () => {
      try { return await this.route(request); }
      catch (error) { return failure(error); }
    });
  }

  async route(request) {
    const config = configuration(this.env);
    const url = new URL(request.url);
    const proof = request.headers.get('X-Session-Proof');
    const id = request.headers.get('X-Session-Id');
    if (!/^[A-Za-z0-9_-]{43}$/.test(proof || '') || !/^[A-Za-z0-9_-]{43}$/.test(id || '')) throw new AppError(401, 'Invalid session.');
    let session = await this.load();
    if (session && session.expiresAt <= Date.now()) { await this.erase(); session = null; }
    if (url.pathname === '/start' && request.method === 'POST') {
      if (session) throw new AppError(409, 'This sign-in session has already been started.');
      session = { tokens: null, proofHash: await digest(proof), expiresAt: Date.now() + LOGIN_AGE, oauth: { state: random() }, cache: {} };
      await this.save(session);
      await this.ctx.storage.setAlarm(session.expiresAt);
      const authorize = new URL(AUTHORIZE_URL);
      authorize.search = new URLSearchParams({ client_id: config.clientId, response_type: 'code', redirect_uri: config.redirectUri, scope: url.searchParams.get('scope') || SCOPES, state: session.oauth.state, prompt_missing_scopes: 'true' }).toString();
      return redirect(authorize.toString(), cookie(`${id}.${proof}`, LOGIN_AGE / 1000));
    }
    if (!session || session.proofHash !== await digest(proof)) {
      if (url.pathname === '/status') return json(200, { connected: false });
      if (url.pathname === '/callback') return redirect('/?error=state');
      throw new AppError(401, 'Connect your Tesla account to continue.');
    }
    if (url.pathname === '/status') return json(200, { connected: Boolean(session.tokens), scopes: scopesFor(session) });
    if (url.pathname === '/logout' && request.method === 'POST') {
      await this.erase();
      return json(200, { ok: true });
    }
    if (url.pathname === '/callback') {
      if (!session.oauth || session.oauth.state !== url.searchParams.get('state')) return redirect('/?error=state');
      session.oauth = null;
      await this.save(session); // Consume the one-time state before the network call.
      if (url.searchParams.has('error')) return redirect('/?error=denied');
      const code = url.searchParams.get('code');
      if (!code || code.length > 8192) return redirect('/?error=authorization');
      try {
        session.tokens = await tokenRequest(config, { grant_type: 'authorization_code', code, client_secret: config.clientSecret, audience: config.audience, redirect_uri: config.redirectUri }, this.fetchTesla);
      } catch (error) { return redirect(`/?error=${oauthCallbackCode(error)}`); }
      const nextProof = random();
      session.proofHash = await digest(nextProof);
      session.expiresAt = Date.now() + SESSION_AGE;
      await this.save(session);
      await this.ctx.storage.setAlarm(session.expiresAt);
      return redirect('/', cookie(`${id}.${nextProof}`));
    }
    if (!session.tokens) throw new AppError(401, 'Connect your Tesla account to continue.');
    for (const [key, entry] of Object.entries(session.cache)) if (/^[A-HJ-NPR-Z0-9]{17}$/.test(key) && entry.value?.fetchedAt) {
      session.garage ||= { readings: {}, history: {}, statuses: {} };
      session.garage.readings[key] = entry.value; delete session.cache[key];
    }
    const cached = async (key, operation) => {
      const previous = session.cache[key];
      if (previous && Date.now() - previous.time < CACHE_AGE) return previous.value;
      const value = await operation();
      // Retain only recent readings, avoiding unbounded per-session storage.
      for (const [name, entry] of Object.entries(session.cache)) if (Date.now() - entry.time >= CACHE_AGE) delete session.cache[name];
      session.cache[key] = { time: Date.now(), value };
      return value;
    };
    try {
      if (url.pathname === '/api/vehicles' && request.method === 'GET') {
        const vehicles = await cached('vehicles', async () => {
          const result = await fleetGet(session, config, '/api/1/vehicles', this.fetchTesla);
          if (!Array.isArray(result)) throw new AppError(502, 'Tesla returned an invalid vehicle list.');
          return result.map(vehicleSummary);
        });
        return json(200, { vehicles });
      }
      const input = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
      return json(200, await garageApi({ session, config, path: url.pathname, method: request.method, input, fetchImpl: this.fetchTesla,
        proxyFetch: this.env.COMMANDS ? (url, options) => this.env.COMMANDS.fetch(new Request(url, options)) : undefined,
        cached, forget: (key) => { delete session.cache[key]; },
      }));
    } finally {
      // Persist token rotations even if the subsequent vehicle request failed.
      await this.save(session);
    }
  }

  alarm() {
    return this.enqueue(async () => {
      const session = await this.load();
      if (!session || session.expiresAt <= Date.now()) await this.erase();
      else await this.ctx.storage.setAlarm(session.expiresAt);
    });
  }
}
