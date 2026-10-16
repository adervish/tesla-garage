import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenRequest, oauthCallbackCode } from '../lib/tesla.mjs';

test('OAuth errors distinguish credentials, callback, permissions, and expired authorization without exposing responses', async () => {
  const cases = [
    ['unauthorized_client', 'credentials'], ['invalid_client', 'credentials'],
    ['invalid_auth_code', 'authorization_code'], ['invalid_grant', 'authorization_code'],
    ['invalid_redirect_url', 'redirect_uri'], ['invalid_redirect_uri', 'redirect_uri'],
    ['invalid_scope', 'permissions'], ['login_required', 'login_required'],
    ['unknown-private-provider-error', 'authorization'],
  ];
  for (const [providerError, expected] of cases) {
    try {
      await tokenRequest({ clientId: 'fake-client' }, { grant_type: 'authorization_code' }, async () => Response.json({ error: providerError, error_description: 'private-description fake-secret' }, { status: 400 }));
      assert.fail('The token request should fail.');
    } catch (error) {
      assert.equal(error.status, 401);
      assert.equal(oauthCallbackCode(error), expected);
      assert.doesNotMatch(error.message, /private-description|fake-secret|unknown-private-provider-error/);
    }
  }
  assert.equal(oauthCallbackCode(new Error('arbitrary internal details')), 'authorization');
});

test('token requests reject redirects without forwarding credentials to the destination', async () => {
  const calls = [];
  await assert.rejects(tokenRequest({ clientId: 'fake-client' }, { grant_type: 'authorization_code', client_secret: 'fake-secret' }, async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'manual');
    return new Response('private provider response', { status: 302, headers: { Location: 'https://untrusted.example/token' } });
  }), (error) => {
    assert.equal(error.code, 'tesla_unavailable');
    assert.doesNotMatch(error.message, /private provider response|fake-secret|untrusted/);
    return true;
  });
  assert.equal(calls.length, 1);
});
