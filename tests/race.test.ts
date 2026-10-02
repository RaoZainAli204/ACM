import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
import { Engine, GameError, csvCell } from '../server/engine.js';
import { bank } from '../server/seed.js';
import { createApp } from '../server/app.js';
import type { PlayerSnapshot } from '../shared/types.js';

function fixture(path = ':memory:') {
  let now = 1_800_000_000_000;
  const engine = new Engine(path,'http://localhost:3000',() => now); const event = engine.currentId();
  engine.open(event); const p = engine.join('Driver One',' 26-cs/001 '); engine.start(event);
  now += 5000; engine.tick();
  return { engine, event, p, get now() { return now; }, set now(n:number) { now = n; } };
}
function option(engine:Engine, p:string, correct=true) {
  const s = engine.snapshot(p); const q = s.question!;
  const stored = engine.sql('SELECT * FROM player_questions WHERE instance_id = ?').get(q.id) as { seed_id:number; options_json:string };
  const answer = bank.find(b => b.id === stored.seed_id)!;
  const choices = JSON.parse(stored.options_json) as { id:string; source:number }[];
  return { questionId:q.id,optionId:choices.find(o => correct ? o.source === answer.correct : o.source !== answer.correct)!.id,requestId:randomUUID() };
}
test('answers save exactly once; exact retries return the saved receipt', () => {
  const f = fixture(); const input = option(f.engine,f.p.participantId); f.now += 543;
  const first = f.engine.answer(f.p.participantId,input); const second = f.engine.answer(f.p.participantId,input);
  assert.deepEqual(second,first); assert.equal(first.earned,100); assert.equal(first.adjustedMs,543);
  assert.equal(f.engine.snapshot(f.p.participantId).player.progress,1); assert.equal(f.engine.snapshot(f.p.participantId).player.score,100);
  assert.equal((f.engine.sql('SELECT COUNT(*) AS n FROM answers').get() as {n:number}).n,1); f.engine.close();
});
test('wrong answers add full allowance and forged score/time/rank have no influence', () => {
  const f = fixture(); f.now += 31;
  const receipt = f.engine.answer(f.p.participantId,{...option(f.engine,f.p.participantId,false),score:2000,time:0,rank:1} as never);
  assert.equal(receipt.earned,0); assert.equal(receipt.adjustedMs,15000); assert.equal(f.engine.snapshot(f.p.participantId).player.score,0); f.engine.close();
});
test('out-of-order, foreign question and wrong option IDs are rejected', () => {
  const f = fixture(); const valid = option(f.engine,f.p.participantId);
  const future = f.engine.sql('SELECT instance_id FROM player_questions WHERE participant_id = ? AND slot = 1').get(f.p.participantId) as {instance_id:string};
  assert.throws(() => f.engine.answer(f.p.participantId,{...valid,questionId:future.instance_id}),GameError);
  assert.throws(() => f.engine.answer(f.p.participantId,{...valid,optionId:randomUUID()}),GameError);
  assert.throws(() => f.engine.answer(f.p.participantId,{...valid,questionId:randomUUID()}),GameError); assert.equal(f.engine.player(f.p.participantId).progress,0); f.engine.close();
});
test('late answers time out and next deadlines begin at expired deadlines', () => {
  const f = fixture(); const s = f.engine.snapshot(f.p.participantId); const input = option(f.engine,f.p.participantId);
  f.now = s.question!.deadline;
  assert.throws(() => f.engine.answer(f.p.participantId,input),GameError);
  const next = f.engine.snapshot(f.p.participantId); assert.equal(next.player.progress,1); assert.equal(next.question!.issuedAt,s.question!.deadline);
  f.now += 31000; const caught = f.engine.snapshot(f.p.participantId); assert.equal(caught.player.progress,3); assert.equal(caught.question!.issuedAt,s.question!.deadline + 30000); f.engine.close();
});
test('refresh and backend restart preserve shuffles, session, score and elapsed timers', () => {
  const dir = mkdtempSync(join(tmpdir(),'grand-prix-test-')); const path = join(dir,'race.sqlite'); const f = fixture(path);
  const first = f.engine.snapshot(f.p.participantId); assert.deepEqual(f.engine.snapshot(f.p.participantId).question,first.question);
  f.now += 1000; f.engine.answer(f.p.participantId,option(f.engine,f.p.participantId)); const current = f.engine.snapshot(f.p.participantId); f.engine.close();
  const restart = new Engine(path,'http://localhost:3000',() => f.now + 30000);
  const resumed = restart.snapshot(restart.playerForToken(f.p.token)!.id); assert.equal(resumed.player.score,100); assert.equal(resumed.player.progress,3);
  const saved = restart.sql('SELECT options_json FROM player_questions WHERE instance_id = ?').get(current.question!.id) as {options_json:string};
  assert.deepEqual(JSON.parse(saved.options_json).map(({id,text}:{id:string;text:string}) => ({id,text})),current.question!.options); restart.close();
});
test('registrations normalize, duplicate registrations reveal no session, duplicate names are allowed', () => {
  const e = new Engine(':memory:','http://localhost'); e.open(e.currentId()); e.join('Same Name','abc/123');
  assert.throws(() => e.join('Other',' ABC/123 '),(err:unknown) => err instanceof GameError && err.status === 409 && !err.message.includes('token'));
  e.join('Same Name','ABC/124'); assert.equal(e.publicSnapshot().count,2);
  assert.throws(() => e.join('OK','a;DROP TABLE')); assert.throws(() => e.join('x','ABC/125')); e.close();
});
test('all participants start together, joins close at scheduled start, groups and option order persist', () => {
  let now = 20000; const e = new Engine(':memory:','http://localhost',() => now); const id = e.currentId(); e.open(id);
  const a = e.join('Driver A','AA001'); e.start(id); now += 4999; const b = e.join('Driver B','AA002'); now++;
  const qa = e.snapshot(a.participantId).question!; const qb = e.snapshot(b.participantId).question!; assert.equal(qa.issuedAt,qb.issuedAt);
  assert.throws(() => e.join('Driver C','AA003'));
  const order = e.sql('SELECT seed_id,slot,allowance_ms FROM player_questions WHERE participant_id = ? ORDER BY slot').all(a.participantId) as {seed_id:number;slot:number;allowance_ms:number}[];
  assert.equal(order.reduce((n,q) => n+q.allowance_ms,0),450000); for (const q of order) assert.equal(Math.floor((q.seed_id - 1)/5),Math.floor(q.slot/5)); e.close();
});
test('global end freezes results, full timeouts count complete and exact cutoff ties share rank', () => {
  let now = 10000; const e = new Engine(':memory:','http://localhost',() => now); const id = e.currentId(); e.open(id);
  const players = Array.from({length:11},(_,i) => e.join('Driver ' + i,'REG' + i)); e.start(id); now += 5000 + 540000; e.tick();
  const state = e.publicSnapshot(); assert.equal(state.event.state,'frozen'); assert.equal(state.cutoffTie,true); assert.ok(state.standings.every(p => p.rank === 1 && p.finished && p.progress === 20));
  assert.equal(e.snapshot(players[0].participantId).player.adjustedMs,450000); assert.ok(players.every(p => e.snapshot(p.participantId).player.rank === 1));
  const before = e.exportCsv(id); e.freeze(id); assert.equal(e.exportCsv(id),before); e.close();
});
test('early freeze excludes unfinished players and prevents subsequent mutations', () => {
  const f = fixture(); const input = option(f.engine,f.p.participantId); f.engine.freeze(f.event); f.now += 1000000;
  assert.throws(() => f.engine.answer(f.p.participantId,input)); f.engine.tick();
  const state = f.engine.publicSnapshot(); assert.equal(state.standings.length,0); assert.equal(state.unfinished.length,1); assert.equal(state.unfinished[0].progress,0); f.engine.close();
});
test('a complete correct race reaches 2000 and exact retries remain readable after freezing', () => {
  const f = fixture(); let last = option(f.engine,f.p.participantId); let receipt;
  for (let i = 0; i < 20; i++) { f.now += 100; last = option(f.engine,f.p.participantId); receipt = f.engine.answer(f.p.participantId,last); }
  const complete = f.engine.snapshot(f.p.participantId); assert.equal(complete.player.score,2000); assert.equal(complete.player.adjustedMs,2000); assert.equal(complete.player.progress,20);
  f.engine.freeze(f.event); assert.deepEqual(f.engine.answer(f.p.participantId,last),receipt); assert.equal(f.engine.publicSnapshot().standings[0].finished,true); f.engine.close();
});
test('immutable event bank and history survive new events; fresh creation requires confirmation', () => {
  const f = fixture(); const original = f.engine.event().bank_json; assert.throws(() => f.engine.createEvent('Fresh',false)); assert.throws(() => f.engine.createEvent('Fresh',true)); f.engine.freeze(f.event);
  const next = f.engine.createEvent('Fresh',true); assert.notEqual(next.id,f.event); assert.equal(f.engine.event(f.event).bank_json,original); assert.equal(f.engine.history().length,2); f.engine.close();
});
test('private/public snapshots omit keys and public payloads omit registrations, sessions and question IDs', () => {
  const f = fixture(); const text = JSON.stringify(f.engine.publicSnapshot()); assert.ok(!/registration|session|seed_id|question|correct|explanation|participant_id/u.test(text)); assert.ok(!text.includes(f.p.token));
  const privateText = JSON.stringify(f.engine.snapshot(f.p.participantId)); assert.ok(!/correct|explanation|source|seed_id|session|registration/u.test(privateText));
  f.engine.freeze(f.event); assert.equal(f.engine.snapshot(f.p.participantId).review!.length,20); f.engine.close();
});
test('CSV neutralizes formula names and safely quotes commas and quotes', () => {
  for (const cell of ['=1+1','+SUM(A1)','-42','@test',' \t=1','\n=2']) assert.ok(csvCell(cell).startsWith('"\''));
  assert.equal(csvCell('A, "B"'),'"A, ""B"""'); const e = new Engine(':memory:','http://localhost'); e.open(e.currentId()); e.join('=SUM(A1)','REG123'); assert.ok(e.exportCsv(e.currentId()).includes('"\'=SUM(A1)"')); e.close();
});
test('six SVGs match grid geometry and shape counts; seed keys match the brief', () => {
  assert.equal(bank.length,20); assert.deepEqual(bank.map(q => q.options[q.correct]),['Mars','12','Equal','Thursday','3','Second','No smoke','10','9','5','3','30','Down','Rs. 5','16','8','18','Mixed','E and 7','20']);
  const shapes = readFileSync('client/public/visuals/shapes.svg','utf8'); assert.equal((shapes.match(/<polygon /g) ?? []).length,3); assert.equal((shapes.match(/<circle /g) ?? []).length,4); assert.equal((shapes.match(/<rect /g) ?? []).length - 1,2);
  for (const q of bank.filter(q => q.image)) { const image = readFileSync('client/public' + q.image,'utf8'); assert.match(image,/<title/u); assert.ok(q.imageAlt); }
  assert.ok(!readFileSync('client/src/main.tsx','utf8').includes('server/seed'));
});
test('organizer HTTP operations require login; wrong participant cookie and cross-origin mutations are rejected', async () => {
  let now = 30000; const app = createApp({ dbPath:':memory:',baseUrl:'http://localhost:3000',password:'organizer-test-password',secret:'s'.repeat(64),production:false,now:() => now,scheduler:false });
  await new Promise<void>(r => app.http.listen(0,'127.0.0.1',r)); const base = 'http://127.0.0.1:' + (app.http.address() as {port:number}).port;
  try {
    for (const path of ['events','state','export.csv','qr.png','diagnostics']) assert.equal((await fetch(base + '/api/admin/' + path)).status,401);
    for (const path of ['open','start','freeze','events','logout']) assert.equal((await fetch(base + '/api/admin/' + path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
    assert.equal((await fetch(base + '/api/player')).status,401);
    const login = await fetch(base + '/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'organizer-test-password'})}); const adminCookie = login.headers.get('set-cookie')!.split(';')[0]; assert.match(login.headers.get('set-cookie')!,/HttpOnly/u);
    assert.equal((await fetch(base + '/api/admin/diagnostics',{headers:{Cookie:adminCookie}})).status,404);
    const post = (path:string, body:unknown, cookie='') => fetch(base + '/api/' + path,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
    await post('admin/open',{},adminCookie);
    const a = await post('join',{name:'Driver A',registration:'REG001'}); const ca = a.headers.get('set-cookie')!.split(';')[0];
    const dup = await post('join',{name:'Driver X',registration:' reg001 '}); assert.equal(dup.status,409); assert.equal(dup.headers.get('set-cookie'),null);
    const b = await post('join',{name:'Driver B',registration:'REG002'}); const cb = b.headers.get('set-cookie')!.split(';')[0];
    await post('admin/start',{},adminCookie); now += 5000;
    const pa = app.engine.playerForToken(ca.split('=')[1])!; const input = option(app.engine,pa.id);
    assert.equal((await post('answer',input,cb)).status,409); assert.equal((await post('answer',input)).status,401);
    const answer = await post('answer',{...input,score:99999,elapsed:0},ca); assert.equal(answer.status,200); assert.equal((await answer.json()).snapshot.player.score,100);
    assert.equal((await fetch(base + '/api/admin/freeze',{method:'POST',headers:{'Content-Type':'application/json',Cookie:adminCookie,Origin:'https://attacker.example'},body:'{}'})).status,403);
    await post('admin/freeze',{},adminCookie); const current = app.engine.snapshot(pa.id); assert.equal(current.question,null); assert.equal(current.player.progress,1);
  } finally { await app.close(); }
});
test('unauthenticated socket cannot answer or mutate organizer state', async () => {
  const app = createApp({dbPath:':memory:',baseUrl:'http://localhost:3000',password:'password-testing',secret:'s'.repeat(64),production:false,scheduler:false});
  await new Promise<void>(r => app.http.listen(0,'127.0.0.1',r)); const base = 'http://127.0.0.1:' + (app.http.address() as {port:number}).port; const socket = io(base,{transports:['websocket']});
  try {
    await new Promise<void>((r,j) => { socket.on('connect',r); socket.on('connect_error',j); });
    const ack = await socket.timeout(2000).emitWithAck('answer',{questionId:randomUUID(),optionId:randomUUID(),requestId:randomUUID()}); assert.equal(ack.status,401);
    socket.emit('admin:start',{}); assert.equal(app.engine.event().state,'closed');
  } finally { socket.disconnect(); await app.close(); }
});
test('public leaderboard is bounded while players below position 15 receive private rank changes', async () => {
  let now = 30000;
  const app = createApp({dbPath:':memory:',baseUrl:'http://localhost:3000',password:'password-testing',secret:'s'.repeat(64),production:false,now:()=>now});
  await new Promise<void>(r=>app.http.listen(0,'127.0.0.1',r));
  const base = 'http://127.0.0.1:' + (app.http.address() as {port:number}).port;
  const event = app.engine.currentId(); app.engine.open(event);
  const players = Array.from({length:20},(_,i)=>app.engine.join('Rank Driver '+i,'RANK-'+i));
  players.forEach((p,i)=>app.engine.sql('UPDATE participants SET adjusted_ms = ? WHERE id = ?').run(i,p.participantId));
  app.engine.start(event); now+=5000; app.engine.tick();
  const outsider = players[15];
  const socket = io(base,{extraHeaders:{Cookie:'race_player='+outsider.token},transports:['websocket'],autoConnect:false});
  try {
    const initial = new Promise<PlayerSnapshot>((r,j)=>{ const timer=setTimeout(()=>j(new Error('Initial private snapshot missing.')),3000); socket.once('snapshot',s=>{clearTimeout(timer);r(s);}); });
    socket.connect(); assert.equal((await initial).player.rank,16);
    const changed = new Promise<PlayerSnapshot>((r,j)=>{
      const timer=setTimeout(()=>j(new Error('Private rank update missing.')),3000);
      socket.on('snapshot',s=>{if(s.player.rank===17){clearTimeout(timer);r(s);}});
    });
    app.engine.answer(players[19].participantId,option(app.engine,players[19].participantId));
    assert.equal((await changed).player.score,0);
    const publicState = await (await fetch(base+'/api/public')).json();
    assert.equal(publicState.count,20); assert.equal(publicState.standings.length,15);
    assert.ok(!publicState.standings.some((p:{publicId:string})=>p.publicId===app.engine.player(outsider.participantId).public_id));
    assert.equal(app.engine.publicSnapshot().standings.length,20);
  } finally {socket.disconnect();await app.close();}
});
test('concurrent HTTP retries and an invalid foreign answer commit once; freezing stays immutable', async () => {
  let now = 50000; const app = createApp({dbPath:':memory:',baseUrl:'http://localhost:3000',password:'password-testing',secret:'s'.repeat(64),production:false,now:() => now,scheduler:false});
  await new Promise<void>(r => app.http.listen(0,'127.0.0.1',r)); const base = 'http://127.0.0.1:' + (app.http.address() as {port:number}).port;
  try {
    const event = app.engine.currentId(); app.engine.open(event); const a = app.engine.join('Driver A','BATCH001'); const b = app.engine.join('Driver B','BATCH002'); app.engine.start(event); now += 5000;
    const input = option(app.engine,a.participantId); const post = (body:unknown,token:string) => fetch(base + '/api/answer',{method:'POST',headers:{'Content-Type':'application/json',Cookie:'race_player=' + token},body:JSON.stringify(body)});
    const results = await Promise.all([...Array.from({length:20},() => post(input,a.token)),post(input,b.token)]);
    assert.ok(results.slice(0,20).every(r => r.status === 200)); assert.equal(results[20].status,409);
    const receipts = await Promise.all(results.slice(0,20).map(r => r.json())); assert.ok(receipts.every(r => r.receipt.earned === 100 && r.snapshot.player.progress === 1));
    assert.equal((app.engine.sql('SELECT COUNT(*) AS n FROM answers').get() as {n:number}).n,1); assert.equal(app.engine.player(a.participantId).score,100);
    app.engine.freeze(event); const frozen = app.engine.exportCsv(event); assert.equal((await post({...input,requestId:randomUUID()},a.token)).status,409); app.engine.tick(); assert.equal(app.engine.exportCsv(event),frozen);
  } finally { await app.close(); }
});
