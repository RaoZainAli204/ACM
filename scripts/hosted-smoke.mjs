import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { io } from 'socket.io-client';

const base = process.env.BASE_URL ?? process.env.APP_BASE_URL;
assert.ok(base?.startsWith('https://') && !base.includes('pending.invalid'),'Set the hosted HTTPS origin.');
mkdirSync('artifacts',{recursive:true});
async function request(path,body,cookie='',expected=200) {
  const result = await fetch(base + path,{method:body === undefined ? 'GET' : 'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:body === undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  assert.equal(result.status,expected,path); return result;
}
const login = await request('/api/admin/login',{password:process.env.ADMIN_PASSWORD});
const adminCookie = login.headers.get('set-cookie')?.split(';')[0];
assert.match(login.headers.get('set-cookie'),/Secure/u); assert.match(login.headers.get('set-cookie'),/HttpOnly/u);
if (process.argv.includes('--diagnostics')) {
  console.log(await (await request('/api/admin/diagnostics',undefined,adminCookie)).text());
  process.exit(0);
}
if (process.argv.includes('--verify-restart')) {
  const saved = JSON.parse(readFileSync('artifacts/hosted-restart-session.json','utf8'));
  assert.equal(saved.base,base);
  const player = await (await request('/api/player',undefined,saved.cookie)).json();
  assert.equal(player.player.publicId,saved.publicId); assert.equal(player.player.score,saved.score); assert.equal(player.player.progress,1);
  const report = JSON.parse(readFileSync('artifacts/hosted-smoke-report.json','utf8'));
  report.persistentRestart = true; writeFileSync('artifacts/hosted-smoke-report.json',JSON.stringify(report,null,2));
  console.log('Hosted database and player session survived the service restart.'); process.exit(0);
}
if (process.argv.includes('--verify-release')) {
  assert.equal((await (await request('/health')).json()).ok,true);
  const html = await (await request('/join')).text();
  const localHtml = readFileSync('dist/client/index.html','utf8');
  const script = localHtml.match(/src="(\/assets\/[^"]+\.js)"/u)?.[1];
  assert.ok(script && html.includes(script),'Hosted client must match the verified local build.');
  await request('/api/admin/events',{name:'DISABLED TEST CHECK',test:true,confirm:true},adminCookie,403);
  await request('/api/admin/diagnostics',undefined,adminCookie,404);
  const state = await (await request('/api/public')).json();
  assert.equal(state.event.state,'closed'); assert.equal(state.count,0); assert.equal(state.joinUrl,base+'/join');
  const report = JSON.parse(readFileSync('artifacts/hosted-smoke-report.json','utf8'));
  Object.assign(report,{releaseCheckedAt:new Date().toISOString(),verifiedClientDeployed:true,loadTestDisabled:true,diagnosticsDisabled:true,registrationClosed:true,realParticipants:0});
  writeFileSync('artifacts/hosted-smoke-report.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2)); process.exit(0);
}
assert.equal((await (await request('/health')).json()).ok,true);
for (const route of ['/join','/display','/admin']) assert.match(await (await request(route)).text(),/404 Grand Prix/u);
await request('/api/admin/state',undefined,'',401);
const original = await (await request('/api/public')).json(); assert.equal(original.joinUrl,base+'/join');
const event = await (await request('/api/admin/events',{name:'HOSTED SMOKE '+new Date().toISOString(),test:true,confirm:true},adminCookie,201)).json();
let socket;
try {
  await request('/api/admin/open',{eventId:event.id},adminCookie);
  const joined = await request('/api/join',{name:'Hosted Rehearsal',registration:'SMOKE-'+randomUUID().slice(0,8),eventId:event.id},'',201);
  const cookie = joined.headers.get('set-cookie')?.split(';')[0]; assert.match(joined.headers.get('set-cookie'),/Secure/u);
  socket = io(base,{auth:{eventId:event.id},extraHeaders:{Cookie:cookie},transports:['websocket']});
  await new Promise((r,j) => { const timer=setTimeout(()=>j(new Error('Hosted WebSocket connect timeout.')),10000); socket.once('connect',()=>{clearTimeout(timer);r();}); socket.once('connect_error',j); });
  await request('/api/admin/start',{eventId:event.id},adminCookie); await new Promise(r=>setTimeout(r,1300));
  const before = await socket.timeout(10000).emitWithAck('resume'); assert.ok(before.snapshot.question);
  const input = {questionId:before.snapshot.question.id,optionId:before.snapshot.question.options[0].id,requestId:randomUUID()};
  const answered = await (await request('/api/answer',input,cookie)).json();
  const repeated = await (await request('/api/answer',input,cookie)).json();
  assert.deepEqual(repeated.receipt,answered.receipt); assert.equal(repeated.snapshot.player.progress,1);
  await request('/api/admin/freeze',{eventId:event.id},adminCookie);
  const csv = await (await request('/api/admin/export.csv?eventId='+event.id,undefined,adminCookie)).text(); assert.match(csv,/Hosted Rehearsal/u);
  const png = await request('/api/admin/qr.png',undefined,adminCookie); assert.equal(png.headers.get('content-type'),'image/png');
  const bytes = Buffer.from(await png.arrayBuffer()); assert.equal(bytes.subarray(1,4).toString(),'PNG');
  writeFileSync('artifacts/public-join-qr.png',bytes);
  writeFileSync('artifacts/hosted-restart-session.json',JSON.stringify({base,cookie,publicId:answered.snapshot.player.publicId,score:answered.snapshot.player.score}),{mode:0o600});
  const unchanged = await (await request('/api/public')).json(); assert.equal(unchanged.event.id,original.event.id); assert.equal(unchanged.event.state,original.event.state);
  const report={base,checkedAt:new Date().toISOString(),https:true,health:true,spaRoutes:true,organizerAuth:true,secureCookies:true,websocket:true,exactlyOnce:true,qrPng:true,joinUrl:unchanged.joinUrl,currentEventPreserved:true,persistentRestart:false};
  writeFileSync('artifacts/hosted-smoke-report.json',JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
} finally { socket?.disconnect(); await request('/api/admin/freeze',{eventId:event.id},adminCookie); }
