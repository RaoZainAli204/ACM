import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
const name = 'grand-prix-load-' + Date.now();
const dir = resolve('artifacts', name);
const reports = resolve(dir, 'reports');
mkdirSync(reports, { recursive: true });
const password = randomBytes(24).toString('hex');
const envPath = resolve(dir, 'docker.env');
writeFileSync(envPath, `NODE_ENV=production\nPORT=3000\nAPP_BASE_URL=https://race.example.test\nDB_PATH=/data/race.sqlite\nADMIN_PASSWORD=${password}\nSESSION_SECRET=${randomBytes(32).toString('hex')}\nENABLE_LOAD_TEST=true\nLOAD_ADMIN_PASSWORD=${password}\n`);
const participants = process.env.PARTICIPANTS ?? '200';
const cpu = process.env.LOAD_SERVER_CPUS ?? '1';
const memory = process.env.LOAD_SERVER_MEMORY ?? '512m';
const hostClient = process.env.LOAD_DOCKER_CLIENT === 'host';
const transport = process.env.LOAD_ANSWER_TRANSPORT ?? 'mixed';
const docker = (...args) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'Docker command failed.');
  return r.stdout.trim();
};
let running = false;
let network = false;
try {
  if (!hostClient) docker('build', '--target', 'load-test', '--tag', '404-grand-prix:load-test', '.');
  docker('network', 'create', name); network = true;
  docker('run', '--detach', '--name', name, '--network', name, '--network-alias', 'race',
    '--cpus', cpu, '--memory', memory, '--env-file', envPath, '--publish', '127.0.0.1:3130:3000',
    '--mount', `type=volume,source=${name},target=/data`, '404-grand-prix:local');
  running = true;
  let healthy = false;
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch('http://127.0.0.1:3130/health', { signal: AbortSignal.timeout(2000) })).ok) { healthy = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  if (!healthy) throw new Error('Container health never passed.');
  const address = docker('inspect','--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',name);
  const started = Date.now();
  const child = hostClient
    ? spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/load-test.ts'], {
        stdio: 'inherit', windowsHide: true,
        env: { ...process.env, BASE_URL: 'http://127.0.0.1:3130', LOAD_ADMIN_PASSWORD: password, PARTICIPANTS: participants }
      })
    : spawn('docker', ['run', '--rm', '--name', name + '-client', '--network', name, '--cpus', '2', '--memory', '512m',
        '--env-file', envPath, '--env', `BASE_URL=http://${address}:3000`, '--env', 'PARTICIPANTS=' + participants, '--env', 'LOAD_ANSWER_TRANSPORT=' + transport,
        '--mount', `type=bind,source=${reports},target=/app/artifacts`, '404-grand-prix:load-test'],
      { stdio: 'inherit', windowsHide: true });
  const code = await new Promise((r, j) => { child.on('error', j); child.on('exit', r); });
  const diagnosticScript = `const base='http://127.0.0.1:3000'; const login=await fetch(base+'/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:process.env.ADMIN_PASSWORD})}); const cookie=login.headers.get('set-cookie')?.split(';')[0]; const result=await fetch(base+'/api/admin/diagnostics',{headers:{Cookie:cookie},signal:AbortSignal.timeout(5000)}); console.log(await result.text());`;
  writeFileSync(resolve(dir,'diagnostics.json'),docker('exec',name,'node','--input-type=module','-e',diagnosticScript));
  const source = hostClient ? resolve('artifacts/load-report-remote.json') : resolve(reports, 'load-report-remote.json');
  if (existsSync(source) && statSync(source).mtimeMs >= started) {
    const report = JSON.parse(readFileSync(source, 'utf8'));
    writeFileSync('artifacts/load-report-docker.json', JSON.stringify({ ...report,
      environment: 'Local Linux Docker server with persistent named volume',
      clientEnvironment: hostClient ? 'Windows host through Docker published port' : 'Separate Linux container over isolated Docker network',
      serverLimits: { cpus: cpu, memory }, publicHostTested: false, volume: name
    }, null, 2));
  } else {
    writeFileSync('artifacts/load-report-docker.json', JSON.stringify({
      error: 'Load test stopped before final verification; see console output.', publicHostTested: false, volume: name
    }, null, 2));
  }
  process.exitCode = code ?? 1;
} finally {
  if (running) {
    writeFileSync(resolve(dir, 'server.log'), docker('logs', name));
    writeFileSync(resolve(dir, 'resources.json'), docker('stats', '--no-stream', '--format', '{{json .}}', name));
    docker('rm', '--force', name);
  }
  if (network) docker('network', 'rm', name);
  console.log('Isolated test database preserved in Docker volume: ' + name);
}
