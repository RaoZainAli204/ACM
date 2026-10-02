import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
mkdirSync('data', { recursive: true });
if (existsSync('.env')) console.log('Existing .env preserved.');
else {
  writeFileSync('.env', `PORT=3000\nAPP_BASE_URL=http://localhost:5173\nDB_PATH=./data/race.sqlite\nADMIN_PASSWORD=${randomBytes(18).toString('base64url')}\nSESSION_SECRET=${randomBytes(32).toString('hex')}\nNODE_ENV=development\nENABLE_LOAD_TEST=false\n`, { mode: 0o600 });
  console.log('Created private .env with random credentials. Read ADMIN_PASSWORD there for /admin.');
}
