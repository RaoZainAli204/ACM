import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

const name = 'grand-prix-smoke-' + Date.now();
const path = resolve('artifacts',name); mkdirSync(path,{recursive:true});
const password = randomBytes(24).toString('hex'); const envPath = resolve(path,'docker.env');
writeFileSync(envPath,`NODE_ENV=production\nPORT=3000\nAPP_BASE_URL=https://race.example.test\nDB_PATH=/data/race.sqlite\nADMIN_PASSWORD=${password}\nSESSION_SECRET=${randomBytes(32).toString('hex')}\n`);
const docker = (...args) => { const r = spawnSync('docker',args,{encoding:'utf8',windowsHide:true}); if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'Docker command failed.'); return r.stdout.trim(); };
const base = 'http://127.0.0.1:3130'; let running = false; let socket;
const sleep = ms => new Promise(r => setTimeout(r,ms));
async function request(path,body,cookie='') {
  const r = await fetch(base + path,{method:body === undefined ? 'GET' : 'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:body === undefined ? undefined : JSON.stringify(body)});
  assert.equal(r.status,200); return r;
}
async function healthy() { for (let i=0;i<40;i++) { try { const r = await fetch(base + '/health'); if (r.ok) return; } catch {} await sleep(500); } throw new Error('Container health never passed.'); }
try {
  docker('run','--detach','--name',name,'--env-file',envPath,'--publish','127.0.0.1:3130:3000','--mount',`type=bind,source=${path},target=/data`,'404-grand-prix:local'); running = true;
  await healthy();
  for (const route of ['/join','/display','/admin']) { const r = await request(route); assert.match(await r.text(),/404 Grand Prix/u); }
  const login = await request('/api/admin/login',{password}); const cookie = login.headers.get('set-cookie').split(';')[0]; assert.match(login.headers.get('set-cookie'),/Secure/u); assert.match(login.headers.get('set-cookie'),/HttpOnly/u);
  await request('/api/admin/open',{},cookie);
  const join = await fetch(base + '/api/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Container Driver',registration:'DOCKER-001'})}); assert.equal(join.status,201);
  const playerCookie = join.headers.get('set-cookie').split(';')[0]; assert.match(join.headers.get('set-cookie'),/Secure/u); const before = await join.json();
  socket = io(base,{extraHeaders:{Cookie:playerCookie},transports:['websocket']}); await new Promise((r,j) => { socket.once('connect',r); socket.once('connect_error',j); });
  const saved = await socket.timeout(3000).emitWithAck('resume'); assert.equal(saved.snapshot.player.name,'Container Driver'); socket.disconnect();
  docker('restart',name); await healthy();
  const resumed = await (await request('/api/player',undefined,playerCookie)).json(); assert.equal(resumed.player.publicId,before.player.publicId); assert.equal(resumed.player.progress,0);
  const png = await request('/api/admin/qr.png',undefined,cookie); assert.equal(png.headers.get('content-type'),'image/png');
  const report = {health:true,spaRoutes:true,productionSecureCookies:true,websocket:true,persistentMountRestart:true,qrPng:true,realHttpsHostTested:false};
  writeFileSync('artifacts/docker-smoke-report.json',JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
} finally { if (socket) socket.disconnect(); if (running) docker('rm','--force',name); }
