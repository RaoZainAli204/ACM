import { readFileSync, copyFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const base = readFileSync('.env.production','utf8').match(/^APP_BASE_URL=([^\r\n]+)/mu)?.[1];
if (!base?.startsWith('https://') || base.includes('pending.invalid')) throw new Error('Set the real hosted origin using setup:production.');
const mode = process.argv.includes('--http') ? 'http' : process.argv.includes('--socket') ? 'socket' : 'mixed';
if (existsSync('artifacts/load-report-remote.json')) copyFileSync('artifacts/load-report-remote.json','artifacts/load-report-hosted-previous.json');
const child = spawn(process.execPath,['--env-file=.env.production','--import','tsx','scripts/load-test.ts'],{
  stdio:'inherit',windowsHide:true,env:{...process.env,BASE_URL:base,PARTICIPANTS:process.env.PARTICIPANTS ?? '200',LOAD_ANSWER_TRANSPORT:mode}
});
const code = await new Promise((r,j)=>{child.on('error',j);child.on('exit',r);});
if (code === 0) copyFileSync('artifacts/load-report-remote.json','artifacts/load-report-hosted-'+mode+'.json');
process.exitCode = code ?? 1;
