// Run the actual Worker and Durable Object in workerd, with simulated Tesla
// responses. Wrangler supplies Miniflare, so no runtime dependency is added.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib/config.mjs';
import { TOKEN_URL } from '../lib/tesla.mjs';

let miniflarePath;
try { miniflarePath = createRequire(import.meta.url).resolve('miniflare'); }
catch {
  const command = spawnSync('which', ['wrangler'], { encoding: 'utf8' });
  if (command.status !== 0 || !command.stdout.trim()) throw new Error('Install Wrangler to run the Workers runtime check.');
  const require = createRequire(pathToFileURL(realpathSync(command.stdout.trim())));
  miniflarePath = require.resolve('miniflare');
}
const { Miniflare } = await import(pathToFileURL(miniflarePath).href);
const config = JSON.parse(await readFile(join(ROOT, 'wrangler.jsonc'), 'utf8'));
const origin = 'https://garage.test';
const vin = '5YJ3E1EA7KF000001';
const calls = [];
let redirectTokens = false;
let commandCalls = 0;
const mf = new Miniflare({
  modules: true,
  scriptPath: join(ROOT, 'cloudflare', 'worker.mjs'),
  compatibilityDate: config.compatibility_date,
  bindings: {
    APP_URL: origin, TESLA_REGION: 'na', CLIENTID: 'runtime-client', CLIENTSECRET: 'runtime-secret',
    SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'),
  },
  durableObjects: { SESSIONS: { className: 'TeslaSession', useSQLite: true } },
  serviceBindings: { ASSETS: () => new Response('test asset'), COMMANDS: async (request) => {
    commandCalls++;
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('Authorization'), 'Bearer runtime-access');
    assert.deepEqual(await request.json(), { percent: 80 });
    return Response.json({ response: { result: true } });
  } },
  outboundService: async (request) => {
    const url = new URL(request.url);
    calls.push({ origin: url.origin, path: url.pathname });
    if (request.url === TOKEN_URL) {
      const form = new URLSearchParams(await request.text());
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('client_secret'), 'runtime-secret');
      assert.equal(form.get('redirect_uri'), `${origin}/auth/callback`);
      if (redirectTokens) return new Response(null, { status: 302, headers: { Location: 'https://untrusted.test/token' } });
      return Response.json({ access_token: 'runtime-access', refresh_token: 'runtime-refresh', expires_in: 3600, scope: 'openid vehicle_device_data vehicle_cmds vehicle_charging_cmds' });
    }
    assert.equal(url.origin, 'https://fleet-api.prd.na.vn.cloud.tesla.com');
    assert.equal(request.headers.get('Authorization'), 'Bearer runtime-access');
    const vehicle = { vin, display_name: 'Runtime car', state: 'online' };
    if (url.pathname === '/api/1/vehicles') return Response.json({ response: [vehicle] });
    if (url.pathname.endsWith('/vehicle_data')) return Response.json({ response: { ...vehicle, charge_state: { battery_level: 78 }, vehicle_state: { locked: true } } });
    return Response.json({ response: vehicle });
  },
});

const request = (path, options = {}) => mf.dispatchFetch(`${origin}${path}`, { ...options, redirect: 'manual' });
async function callback() {
  const start = await request('/auth/login');
  assert.equal(start.status, 303);
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  return request(`/auth/callback?code=runtime-code&state=${state}`, { headers: { Cookie: cookie } });
}

try {
  const finish = await callback();
  assert.equal(finish.headers.get('location'), '/', 'The real Workers runtime must exchange the authorization code successfully.');
  const cookie = finish.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, Origin: origin };
  assert.equal((await (await request('/api/session', { headers })).json()).connected, true);
  const vehicles = await request('/api/vehicles', { headers });
  assert.equal(vehicles.status, 200);
  assert.equal((await vehicles.json()).vehicles[0].vin, vin);
  const reading = await request(`/api/vehicles/${vin}/refresh`, { method: 'POST', headers });
  assert.equal(reading.status, 200);
  assert.equal((await reading.json()).vehicle.battery, 78);
  assert.equal(calls.length, 4);
  assert.equal((await (await request(`/api/vehicles/${vin}/snapshot`, { headers })).json()).vehicle.battery, 78);
  const command = await request(`/api/vehicles/${vin}/command`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'set_charge_limit', percent: 80 }) });
  assert.equal(command.status, 200);
  assert.equal(commandCalls, 1);
  redirectTokens = true;
  const refused = await callback();
  assert.equal(refused.headers.get('location'), '/?error=tesla_unavailable');
  assert.equal(calls.length, 5);
  assert.equal(calls.some((call) => call.origin === 'https://untrusted.test'), false);
  await request('/api/logout', { method: 'POST', headers });
  assert.equal((await (await request('/api/session', { headers })).json()).connected, false);
  console.log('Workers runtime checks passed: OAuth exchange, authenticated vehicle data, retained snapshot, signed-command binding, redirect protection, and logout.');
} finally {
  await mf.dispose();
}
