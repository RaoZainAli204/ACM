import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const origin = new URL(process.argv[2] ?? 'https://pending.invalid');
if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password || ['localhost', '127.0.0.1'].includes(origin.hostname)) {
  throw new Error('Provide the public HTTPS origin only, such as https://your-service.up.railway.app.');
}
const path = '.env.production';
const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
const value = key => existing.match(new RegExp('^' + key + '=([^\\r\\n]*)', 'm'))?.[1];
const password = value('ADMIN_PASSWORD') ?? randomBytes(18).toString('base64url');
const secret = value('SESSION_SECRET') ?? randomBytes(32).toString('hex');
if (password.length < 12 || secret.length < 32 || password.startsWith('replace-') || secret.startsWith('replace-')) {
  throw new Error('The existing production credentials do not meet the 12-character password / 32-character secret requirement.');
}
writeFileSync(path, `NODE_ENV=production\nPORT=3000\nAPP_BASE_URL=${origin.origin}\nDB_PATH=/data/race.sqlite\nADMIN_PASSWORD=${password}\nSESSION_SECRET=${secret}\nENABLE_LOAD_TEST=false\n`, { mode: 0o600 });
console.log('Prepared private .env.production. Read ADMIN_PASSWORD there for the hosted organizer login.');
console.log('Local .env is preserved. Existing production credentials are preserved on subsequent runs.');
if (origin.hostname === 'pending.invalid') console.log('Run again with the Railway HTTPS URL before configuring the deployment.');
