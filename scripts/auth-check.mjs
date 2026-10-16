// Test the deployed callback's connection to Tesla without a real user code or
// vehicle access. Tesla must reject this intentionally invalid code explicitly.
import assert from 'node:assert/strict';
const origin = 'https://tesla.dangerously-skipped-permissions.com';
const request = (url, options = {}) => fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
const start = await request(`${origin}/auth/login`);
assert.equal(start.status, 303);
const state = new URL(start.headers.get('location')).searchParams.get('state');
const cookie = start.headers.get('set-cookie').split(';')[0];
try {
  const callback = new URL('/auth/callback', origin);
  callback.search = new URLSearchParams({ state, code: 'garage-diagnostic-invalid-code' }).toString();
  const result = await request(callback, { headers: { Cookie: cookie } });
  assert.equal(result.status, 303);
  const returned = new URL(result.headers.get('location'), origin);
  // Report only a known diagnostic outcome; never print a provider response.
  assert.equal(returned.searchParams.get('error'), 'authorization_code', 'The live app must reach Tesla and receive its invalid-code rejection.');
  console.log('Live Tesla connection passed: the deployed callback reached Tesla and received the expected invalid-code rejection. No user token or vehicle access was requested.');
} finally {
  await request(`${origin}/api/logout`, { method: 'POST', headers: { Origin: origin, Cookie: cookie } });
}
