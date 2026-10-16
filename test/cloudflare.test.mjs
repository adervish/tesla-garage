import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { TeslaSession } from '../cloudflare/worker.mjs';
import { TOKEN_URL } from '../lib/tesla.mjs';

const origin = 'https://tesla.example.com';
const vin = '5YJ3E1EA7KF000001';
const json = (body, status = 200) => Response.json(body, { status });
const tokens = () => ({ access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600 });

function fixture(handler = async () => json(tokens())) {
  const objects = new Map();
  const stores = new Map();
  const calls = [];
  const env = {
    APP_URL: origin, CLIENTID: 'fake-client', CLIENTSECRET: 'fake-secret', TESLA_REGION: 'na',
    SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    ASSETS: { fetch: async () => new Response('Public asset') },
    API_RATE_LIMITER: { limit: async () => ({ success: true }) },
    SESSIONS: {
      idFromName: (name) => name,
      get(id) {
        if (!stores.has(id)) {
          const values = new Map();
          stores.set(id, {
            values, alarm: null,
            async get(key) { return structuredClone(values.get(key)); },
            async put(key, value) { values.set(key, structuredClone(value)); },
            async deleteAll() { values.clear(); },
            async setAlarm(time) { this.alarm = time; },
            async deleteAlarm() { this.alarm = null; },
          });
        }
        if (!objects.has(id)) {
          const object = new TeslaSession({ storage: stores.get(id) }, env);
          object.fetchTesla = async (url, options) => { calls.push({ url, options }); return handler(url, options); };
          objects.set(id, object);
        }
        return objects.get(id);
      },
    },
  };
  const request = (path, options = {}) => worker.fetch(new Request(`${origin}${path}`, options), env);
  async function login() {
    const start = await request('/auth/login');
    assert.equal(start.status, 303);
    const firstCookie = start.headers.get('set-cookie').split(';')[0];
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const finish = await request(`/auth/callback?code=fake-code&state=${state}`, { headers: { Cookie: firstCookie } });
    assert.equal(finish.headers.get('location'), '/');
    const cookie = finish.headers.get('set-cookie').split(';')[0];
    return { cookie, firstCookie, state };
  }
  return { request, login, env, objects, stores, calls };
}

test('Cloudflare sessions survive eviction, encrypt stored tokens, and rotate authentication proof', async () => {
  const f = fixture();
  const { cookie, firstCookie } = await f.login();
  assert.notEqual(cookie, firstCookie);
  const stored = JSON.stringify([...f.stores.values()].map((store) => [...store.values.values()]));
  assert.doesNotMatch(stored, /fake-access|fake-refresh|fake-secret/);
  f.objects.clear(); // Model a new isolate loading the same durable storage.
  const result = await f.request('/api/session', { headers: { Cookie: cookie } });
  assert.equal((await result.json()).connected, true);
  const old = await f.request('/api/session', { headers: { Cookie: firstCookie } });
  assert.equal((await old.json()).connected, false);
  const logout = await f.request('/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  f.objects.clear();
  assert.equal((await (await f.request('/api/session', { headers: { Cookie: cookie } })).json()).connected, false);
  assert.equal([...f.stores.values()][0].values.size, 0);
});

test('Cloudflare rejects callback replay, cross-origin mutation, and private file requests', async () => {
  const f = fixture();
  const { cookie, state } = await f.login();
  const replay = await f.request(`/auth/callback?code=fake-code&state=${state}`, { headers: { Cookie: cookie } });
  assert.equal(replay.headers.get('location'), '/?error=state');
  const cross = await f.request('/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://other.example.com' } });
  assert.equal(cross.status, 403);
  assert.equal((await (await f.request('/api/session', { headers: { Cookie: cookie } })).json()).connected, true);
  for (const path of ['/.env', '/data/private-key.pem', '/cloudflare/worker.mjs']) assert.equal((await f.request(path)).status, 404);
  const publicPage = await f.request('/');
  assert.match(publicPage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(publicPage.headers.get('cache-control'), /no-transform/);
});

test('Cloudflare keeps OAuth redirects in the browser instead of following them in the session binding', async () => {
  const f = fixture();
  const original = f.env.SESSIONS.get.bind(f.env.SESSIONS);
  f.env.SESSIONS.get = (id) => ({
    fetch(request) {
      assert.equal(request.redirect, 'manual');
      return original(id).fetch(request);
    },
  });
  const { cookie } = await f.login();
  assert.match(cookie, /^__Host-tesla_session=/);
});

test('Cloudflare serializes simultaneous refreshes, retains cache across eviction, and skips sleeping vehicles', async () => {
  let dataCalls = 0;
  let sleeping = false;
  const f = fixture(async (url) => {
    if (url === TOKEN_URL) return json(tokens());
    if (url.includes('/vehicle_data')) {
      dataCalls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return json({ response: { vin, state: 'online', charge_state: { battery_level: 78 } } });
    }
    return json({ response: { vin, state: sleeping ? 'asleep' : 'online' } });
  });
  const { cookie } = await f.login();
  const options = { method: 'POST', headers: { Cookie: cookie, Origin: origin } };
  const results = await Promise.all([f.request(`/api/vehicles/${vin}/refresh`, options), f.request(`/api/vehicles/${vin}/refresh`, options)]);
  assert.equal(results[0].status, 200);
  assert.equal(results[1].status, 200);
  assert.equal(dataCalls, 1);
  f.objects.clear();
  assert.equal((await f.request(`/api/vehicles/${vin}/refresh`, options)).status, 200);
  assert.equal(dataCalls, 1);
  const other = await f.login();
  sleeping = true;
  const result = await f.request(`/api/vehicles/${vin}/refresh`, { method: 'POST', headers: { Cookie: other.cookie, Origin: origin } });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).status.state, 'asleep');
  assert.equal(dataCalls, 1);
});

test('Cloudflare expires sessions and cleans encrypted storage using alarms', async () => {
  const f = fixture();
  const { cookie } = await f.login();
  const [object] = f.objects.values();
  const session = await object.load();
  session.expiresAt = Date.now() - 1;
  await object.save(session);
  await object.alarm();
  assert.equal((await (await f.request('/api/session', { headers: { Cookie: cookie } })).json()).connected, false);
  assert.equal([...f.stores.values()][0].alarm, null);
});

test('Cloudflare rate limits login before creating a session', async () => {
  const f = fixture();
  f.env.API_RATE_LIMITER.limit = async () => ({ success: false });
  assert.equal((await f.request('/auth/login')).status, 429);
  assert.equal(f.objects.size, 0);
});

test('Cloudflare reports a specific credential rejection without leaking provider details or allowing replay', async () => {
  const f = fixture(async () => json({ error: 'unauthorized_client', error_description: 'private provider details fake-secret' }, 400));
  const start = await f.request('/auth/login');
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const path = `/auth/callback?code=fake-code&state=${state}`;
  const result = await f.request(path, { headers: { Cookie: cookie } });
  assert.equal(result.headers.get('location'), '/?error=credentials');
  assert.doesNotMatch(await result.text(), /private provider details|fake-secret/);
  assert.equal((await (await f.request('/api/session', { headers: { Cookie: cookie } })).json()).connected, false);
  assert.equal((await f.request(path, { headers: { Cookie: cookie } })).headers.get('location'), '/?error=state');
  assert.equal(f.calls.length, 1);
});

test('Cloudflare persists retained readings/history, rejects missing command permissions, and forwards only validated commands', async () => {
  const f = fixture(async (url) => {
    if (url === TOKEN_URL) return json({ ...tokens(), scope: 'openid vehicle_device_data vehicle_cmds vehicle_charging_cmds' });
    if (url.includes('/vehicle_data')) return json({ response: {vin,state:'online',charge_state:{battery_level:66}} });
    return json({response:{vin,state:'online'}});
  });
  const {cookie} = await f.login();
  const headers = { Cookie:cookie, Origin:origin, 'Content-Type':'application/json' };
  await f.request(`/api/vehicles/${vin}/refresh`,{method:'POST',headers});
  f.objects.clear();
  assert.equal((await (await f.request(`/api/vehicles/${vin}/snapshot`,{headers})).json()).vehicle.battery,66);
  assert.equal((await (await f.request(`/api/vehicles/${vin}/history`,{headers})).json()).readings.length,1);
  let commands=0;
  f.env.COMMANDS = {async fetch(request) {commands++; assert.equal(request.headers.get('Authorization'),'Bearer fake-access');assert.deepEqual(await request.json(),{percent:80});return json({response:{result:true}});}};
  const result = await f.request(`/api/vehicles/${vin}/command`,{method:'POST',headers,body:JSON.stringify({command:'set_charge_limit',percent:80})});
  assert.equal(result.status,200);assert.equal(commands,1);
  assert.equal((await f.request(`/api/vehicles/${vin}/command`,{method:'POST',headers,body:JSON.stringify({command:'remote_start_drive'})})).status,400);
  assert.equal((await f.request(`/api/vehicles/${vin}/command`,{method:'POST',headers,body:'x'.repeat(5000)})).status,413);
  assert.equal(commands,1);
  const [object]=f.objects.values(); const saved=await object.load(); saved.tokens.scopes=['vehicle_device_data'];await object.save(saved);
  assert.equal((await f.request(`/api/vehicles/${vin}/wake`,{method:'POST',headers})).status,403);
  assert.equal((await (await f.request('/api/session',{headers})).json()).connected,true);
});
