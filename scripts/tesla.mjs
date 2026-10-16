import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { mkdir, readFile, writeFile, access, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { ROOT, PUBLIC_KEY_PATH, loadEnvironment, readConfig } from '../lib/config.mjs';
import { tokenRequest, requestJson } from '../lib/tesla.mjs';

async function keys(config) {
  const privateFile = join(ROOT, 'data', 'private-key.pem');
  await mkdir(dirname(privateFile), { recursive: true, mode: 0o700 });
  await mkdir(dirname(config.publicKeyFile), { recursive: true });
  const privateExists = await access(privateFile).then(() => true, () => false);
  const publicExists = await access(config.publicKeyFile).then(() => true, () => false);
  if (publicExists && !privateExists) throw new Error('A public key already exists without a local private key. Restore its matching private key; existing keys will not be replaced.');
  let publicKey;
  if (privateExists) {
    publicKey = createPublicKey(await readFile(privateFile));
    if (publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('The existing private key must use prime256v1.');
  } else {
    const generated = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    await writeFile(privateFile, generated.privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    publicKey = generated.publicKey;
  }
  await chmod(privateFile, 0o600);
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  if (publicExists) {
    const existing = createPublicKey(await readFile(config.publicKeyFile)).export({ type: 'spki', format: 'pem' });
    if (existing !== pem) throw new Error('The existing public and private keys do not match. No keys were overwritten.');
    console.log('Matching key pair already exists. No keys were replaced.');
  } else {
    await writeFile(config.publicKeyFile, pem, { flag: 'wx', mode: 0o644 });
    console.log('Key pair ready. Private key stored in data/private-key.pem; only the public key is served.');
  }
  console.log(`Public key path: ${PUBLIC_KEY_PATH}`);
}

async function partnerToken(config) {
  if (!config.clientId || !config.clientSecret) throw new Error('Add CLIENTID and CLIENTSECRET to .env first.');
  return tokenRequest(config, { grant_type: 'client_credentials', client_secret: config.clientSecret, audience: config.audience });
}

async function register(config) {
  if (!config.appUrlConfigured || !config.secure || ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.origin).hostname)) {
    throw new Error('Set APP_URL to the public HTTPS domain registered in the Tesla developer portal first.');
  }
  let local;
  try { local = await readFile(config.publicKeyFile, 'utf8'); }
  catch { throw new Error('Generate a key pair first: node scripts/tesla.mjs keys'); }
  let response;
  try { response = await fetch(`${config.origin}${PUBLIC_KEY_PATH}`, { redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
  catch { throw new Error('The public key is not reachable at APP_URL. Serve this app over HTTPS before registering.'); }
  if (!response.ok || (await response.text()).trim() !== local.trim()) throw new Error('The public key served by APP_URL does not match the local public key. Registration was not attempted.');
  const token = await partnerToken(config);
  const result = await requestJson(`${config.audience}/api/1/partner_accounts`, {
    method: 'POST', headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain: new URL(config.origin).hostname }),
  });
  if (!result.response.ok) throw new Error(`Tesla registration failed (HTTP ${result.response.status}). Check the domain allowed in your Tesla developer account and TESLA_REGION.`);
  console.log('Tesla accepted the domain registration. Open the app at APP_URL and connect your account.');
}

try {
  loadEnvironment();
  const config = readConfig();
  switch (process.argv[2]) {
    case 'keys': await keys(config); break;
    case 'check': await partnerToken(config); console.log('Tesla accepted the client credentials. No tokens were printed or saved.'); break;
    case 'register': await register(config); break;
    default: console.log('Usage: node scripts/tesla.mjs <check|keys|register>'); process.exitCode = 1;
  }
} catch (error) {
  // Provider response bodies and token values must never reach the terminal.
  console.error(error.message);
  process.exitCode = 1;
}
