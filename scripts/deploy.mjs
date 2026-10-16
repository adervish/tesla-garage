import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, loadEnvironment, readConfig } from '../lib/config.mjs';

// The file is private and ignored by Git. Preserve its encryption key across
// deployments so existing Cloudflare sessions remain readable.
loadEnvironment();
const config = readConfig();
if (!config.clientId || !config.clientSecret) throw new Error('Add CLIENTID and CLIENTSECRET to .env before deploying.');
const path = join(ROOT, 'data', 'cloudflare-secrets.json');
await mkdir(join(ROOT, 'data'), { recursive: true, mode: 0o700 });
let previous;
try { previous = JSON.parse(await readFile(path, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read the saved Cloudflare secret file. It was not replaced.'); }
if (previous && Buffer.from(previous.SESSION_ENCRYPTION_KEY || '', 'base64').length !== 32) throw new Error('The saved session encryption key is invalid. Restore it instead of replacing it.');
const secrets = {
  CLIENTID: config.clientId,
  CLIENTSECRET: config.clientSecret,
  SESSION_ENCRYPTION_KEY: previous?.SESSION_ENCRYPTION_KEY || randomBytes(32).toString('base64'),
};
await writeFile(path, JSON.stringify(secrets), { mode: 0o600 });
await chmod(path, 0o600);
for (const args of [['deploy'], ['secret', 'bulk', path]]) {
  const result = spawnSync('wrangler', args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  if (result.error || result.status !== 0) {
    console.error('Cloudflare deployment did not finish. Correct the reported Wrangler error and run this script again.');
    process.exit(1);
  }
}
console.log('Deployed Tesla Garage and uploaded its secrets. Secret values were not printed.');
