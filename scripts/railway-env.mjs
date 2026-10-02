import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const cli = process.argv[2];
if (!cli || !existsSync(cli)) throw new Error('Pass the installed Railway executable path.');
const entries = readFileSync('.env.production', 'utf8').split(/\r?\n/u).filter(Boolean).map(line => {
  const split = line.indexOf('='); return [line.slice(0,split),line.slice(split+1)];
});
const vars = new Map(entries);
if (vars.get('APP_BASE_URL') === 'https://pending.invalid') throw new Error('Set the real Railway HTTPS URL using setup:production first.');
vars.set('ENABLE_LOAD_TEST',process.argv.includes('--enable-load-test') ? 'true' : 'false');
for (const [key,value] of vars) {
  if (!/^[A-Z_]+$/u.test(key)) throw new Error('Invalid environment key.');
  const result = spawnSync(cli,['variable','set',key,'--stdin','--skip-deploys','--service','race'],{
    input:value,encoding:'utf8',windowsHide:true
  });
  if (result.status !== 0) throw new Error(`Railway configuration failed for ${key}; secret values were suppressed.`);
  console.log('Configured ' + key + ' (value hidden).');
}
console.log('Configuration saved without triggering deployments.');
