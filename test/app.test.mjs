import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server.mjs';
import { readConfig } from '../lib/config.mjs';
import { accessToken, vehicleDetails, TOKEN_URL } from '../lib/tesla.mjs';

const vin = '5YJ3E1EA7KF000001';
const config = () => readConfig({ CLIENTID: 'test-client', CLIENTSECRET: 'test-secret', APP_URL: 'http://localhost:3000' });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const tokens = (access = 'test-access', refresh = 'test-refresh') => ({ access_token: access, refresh_token: refresh, expires_in: 3600 });

async function fixture(t, handler, overrides = {}) {
  const calls = [];
  const app = createApp({ ...config(), ...overrides }, { fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options);
  } });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.closeAllConnections(); await new Promise((resolve) => app.close(resolve)); });
  const base = `http://127.0.0.1:${app.address().port}`;
  async function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(`${base}${path}`, { method: options.method || 'GET', headers: { Host: 'localhost:3000', ...options.headers } }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])) })));
      });
      req.on('error', reject);
      req.end();
    });
  }
  async function login() {
    const start = await request('/auth/login');
    assert.equal(start.status, 303);
    const location = new URL(start.headers.get('location'));
    const firstCookie = start.headers.get('set-cookie').split(';')[0];
    const finish = await request(`/auth/callback?code=test-code&state=${location.searchParams.get('state')}`, { headers: { Cookie: firstCookie } });
    assert.equal(finish.headers.get('location'), '/');
    const cookie = finish.headers.get('set-cookie').split(';')[0];
    assert.notEqual(cookie, firstCookie);
    return { cookie, firstCookie, location };
  }
  return { request, login, calls };
}

test('public pages never expose secrets, source files, or private keys', async (t) => {
  const f = await fixture(t, () => { throw new Error('No Tesla requests expected'); });
  const page = await f.request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /Tesla Garage/);
  const session = await f.request('/api/session');
  const body = await session.text();
  assert.doesNotMatch(body, /test-client|test-secret|test-access/);
  assert.equal(JSON.parse(body).connected, false);
  for (const path of ['/.env', '/.env.example', '/server.mjs', '/lib/config.mjs', '/data/private-key.pem', '/public/../.env']) assert.equal((await f.request(path)).status, 404);
  assert.equal((await f.request('/api/vehicles')).status, 401);
  assert.equal(f.calls.length, 0);
});

test('OAuth requires matching state, rotates the session, and consumes callbacks only once', async (t) => {
  const f = await fixture(t, (url, options) => {
    assert.equal(url, TOKEN_URL);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.body.get('redirect_uri'), 'http://localhost:3000/auth/callback');
    assert.equal(options.body.get('client_secret'), 'test-secret');
    return response(tokens());
  });
  const start = await f.request('/auth/login');
  const location = new URL(start.headers.get('location'));
  assert.equal(location.origin, 'https://auth.tesla.com');
  assert.equal(location.searchParams.get('scope'), 'openid offline_access vehicle_device_data');
  assert.equal(location.searchParams.has('client_secret'), false);
  const cookieHeader = start.headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly; SameSite=Lax/);
  const firstCookie = cookieHeader.split(';')[0];
  const wrong = await f.request('/auth/callback?code=test-code&state=wrong', { headers: { Cookie: firstCookie } });
  assert.equal(wrong.headers.get('location'), '/?error=state');
  const noCookie = await f.request(`/auth/callback?code=test-code&state=${location.searchParams.get('state')}`);
  assert.equal(noCookie.headers.get('location'), '/?error=state');
  assert.equal(f.calls.length, 0);
  const path = `/auth/callback?code=test-code&state=${location.searchParams.get('state')}`;
  const valid = await f.request(path, { headers: { Cookie: firstCookie } });
  assert.equal(valid.headers.get('location'), '/');
  const cookie = valid.headers.get('set-cookie').split(';')[0];
  assert.notEqual(cookie, firstCookie);
  const connected = await f.request('/api/session', { headers: { Cookie: cookie } });
  assert.equal((await connected.json()).connected, true);
  const oldSession = await f.request('/api/session', { headers: { Cookie: firstCookie } });
  assert.equal((await oldSession.json()).connected, false);
  const replay = await f.request(path, { headers: { Cookie: cookie } });
  assert.equal(replay.headers.get('location'), '/?error=state');
  assert.equal(f.calls.length, 1);
});

test('cross-origin mutations and unrecognized hosts are rejected; logout destroys the session', async (t) => {
  const f = await fixture(t, () => response(tokens()));
  const { cookie } = await f.login();
  const crossOrigin = await f.request('/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://attacker.example' } });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await (await f.request('/api/session', { headers: { Cookie: cookie } })).json()).connected, true);
  assert.equal((await f.request('/api/session', { headers: { Host: 'attacker.example' } })).status, 403);
  const logout = await f.request('/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: 'http://localhost:3000' } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await f.request('/api/vehicles', { headers: { Cookie: cookie } })).status, 401);
});

test('vehicle reads are cached and isolated by session; concurrent refreshes issue one data request', async (t) => {
  let dataCalls = 0;
  const vehicle = { vin, display_name: '<script>test</script>', state: 'online' };
  const f = await fixture(t, async (url) => {
    if (url === TOKEN_URL) return response(tokens());
    if (url.endsWith('/api/1/vehicles')) return response({ response: [vehicle] });
    if (url.includes('vehicle_data')) {
      dataCalls++;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return response({ response: { ...vehicle, charge_state: { battery_level: 0, battery_range: 0 }, climate_state: { inside_temp: 0, is_climate_on: false }, vehicle_state: { locked: false, sentry_mode: false }, drive_state: { latitude: 12, longitude: 34 } } });
    }
    return response({ response: vehicle });
  });
  const { cookie } = await f.login();
  const headers = { Cookie: cookie, Origin: 'http://localhost:3000' };
  const list = await f.request('/api/vehicles', { headers });
  assert.equal((await list.json()).vehicles[0].vin, vin);
  await f.request('/api/vehicles', { headers });
  assert.equal(f.calls.filter((call) => call.url.endsWith('/api/1/vehicles')).length, 1);
  const path = `/api/vehicles/${vin}/refresh`;
  const results = await Promise.all([f.request(path, { method: 'POST', headers }), f.request(path, { method: 'POST', headers })]);
  assert.equal(results[0].status, 200);
  const first = await results[0].json();
  assert.equal(first.vehicle.battery, 0);
  assert.equal(first.vehicle.insideCelsius, 0);
  assert.equal(first.vehicle.locked, false);
  assert.equal(first.vehicle.climateOn, false);
  assert.doesNotMatch(JSON.stringify(first), /latitude|longitude|test-access/);
  assert.equal(dataCalls, 1);
  await f.request(path, { method: 'POST', headers });
  assert.equal(dataCalls, 1);
  const other = await f.login();
  await f.request('/api/vehicles', { headers: { Cookie: other.cookie } });
  assert.equal(f.calls.filter((call) => call.url.endsWith('/api/1/vehicles')).length, 2);
});

test('sleeping vehicles do not trigger a data request or wake command', async (t) => {
  const f = await fixture(t, (url) => url === TOKEN_URL ? response(tokens()) : response({ response: { vin, state: 'asleep' } }));
  const { cookie } = await f.login();
  const result = await f.request(`/api/vehicles/${vin}/refresh`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://localhost:3000' } });
  assert.equal(result.status, 200);
  const offline = await result.json();
  assert.equal(offline.status.state, 'asleep');
  assert.equal(offline.vehicle, null);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls.some((call) => /wake_up|vehicle_data/.test(call.url)), false);
});

test('concurrent expired-token reads rotate the refresh token only once', async () => {
  const session = { tokens: { accessToken: 'expired', refreshToken: 'old-refresh', expiresAt: 0 } };
  let calls = 0;
  const mock = async (url, options) => {
    calls++;
    assert.equal(options.body.get('refresh_token'), 'old-refresh');
    await new Promise((resolve) => setTimeout(resolve, 25));
    return response(tokens('new-access', 'new-refresh'));
  };
  const result = await Promise.all([accessToken(session, config(), mock), accessToken(session, config(), mock)]);
  assert.deepEqual(result, ['new-access', 'new-access']);
  assert.equal(calls, 1);
  assert.equal(session.tokens.refreshToken, 'new-refresh');
});

test('refresh failures preserve the session on transient errors and clear it on revoked authorization', async () => {
  const session = { tokens: { accessToken: 'expired', refreshToken: 'refresh', expiresAt: 0 } };
  await assert.rejects(accessToken(session, config(), async () => response({ error: 'server_error' }, 503)), { status: 502 });
  assert.equal(session.tokens.refreshToken, 'refresh');
  await assert.rejects(accessToken(session, config(), async () => response({ error: 'login_required' }, 401)), { status: 401 });
  assert.equal(session.tokens, null);
});

test('upstream error bodies are never exposed to the browser', async (t) => {
  const f = await fixture(t, (url) => url === TOKEN_URL ? response(tokens()) : response({ error_description: 'test-secret test-access private provider details' }, 412));
  const { cookie } = await f.login();
  const result = await f.request('/api/vehicles', { headers: { Cookie: cookie } });
  assert.equal(result.status, 412);
  const body = await result.text();
  assert.match(body, /Register your app domain/);
  assert.doesNotMatch(body, /test-secret|test-access|private provider details/);
});

test('missing readings stay unknown and metric units are preserved', () => {
  const empty = vehicleDetails({});
  assert.equal(empty.battery, null);
  assert.equal(empty.locked, null);
  const metric = vehicleDetails({ gui_settings: { gui_distance_units: 'km/hr', gui_temperature_units: 'C' } });
  assert.equal(metric.distanceUnit, 'km');
  assert.equal(metric.temperatureUnit, 'C');
});
