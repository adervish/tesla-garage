import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PUBLIC_KEY_PATH, REGIONS } from './settings.mjs';
export { PUBLIC_KEY_PATH, SCOPES, REGIONS } from './settings.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));

export function loadEnvironment() {
  const path = join(ROOT, '.env');
  if (existsSync(path)) process.loadEnvFile(path);
}

export function readConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const region = env.TESLA_REGION || 'na';
  if (!REGIONS[region]) throw new Error('TESLA_REGION must be na or eu.');
  let url;
  try { url = new URL(env.APP_URL || `http://localhost:${port}`); }
  catch { throw new Error('APP_URL must be a valid URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('APP_URL must be an HTTPS origin, or an HTTP localhost origin, without a path or credentials.');
  }
  return {
    port, host: env.HOST || '127.0.0.1', region,
    origin: url.origin, redirectUri: `${url.origin}/auth/callback`,
    appUrlConfigured: Boolean(env.APP_URL), secure: url.protocol === 'https:',
    clientId: env.CLIENTID || env.TESLA_CLIENT_ID || '',
    clientSecret: env.CLIENTSECRET || env.TESLA_CLIENT_SECRET || '',
    audience: REGIONS[region], publicKeyFile: join(ROOT, 'public', PUBLIC_KEY_PATH),
  };
}
