import { io, type Socket } from 'socket.io-client';
import { randomBytes, randomUUID } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { createApp } from '../server/app.js';
import type { PlayerSnapshot, PublicSnapshot, Receipt } from '../shared/types.js';

const abort = new AbortController(); let stopping = false;
const clientLoop = monitorEventLoopDelay({resolution:20}); clientLoop.enable();
const sleep = (ms:number) => new Promise<void>((resolve,reject) => {
  if (abort.signal.aborted) return reject(new Error('Test stopped.'));
  const cancel = () => { clearTimeout(timer); reject(new Error('Test stopped.')); };
  const timer = setTimeout(() => { abort.signal.removeEventListener('abort',cancel); resolve(); },ms);
  abort.signal.addEventListener('abort',cancel,{once:true});
});
setMaxListeners(0,abort.signal);
// Independent expected answers, deliberately separate from the server seed module.
const answers: [string,string][] = [
  ['Which planet','Mars'],['How many months','12'],['Which weighs more','Equal'],['What day','Thursday'],['Count only','3'],
  ['You overtake','Second'],['An electric train','No smoke'],['What is 8','10'],['A farmer','9'],['How many squares','5'],
  ['Two fathers','3'],['Find the next','30'],['An arrow','Down'],['A bat','Rs. 5'],['Use these visual','16'],
  ['A snail','8'],['How many rectangles','18'],['Three boxes','Mixed'],['Cards show','E and 7'],['On a grid','20']
];
interface Driver { cookie:string; socket:Socket; snapshot:PlayerSnapshot; expected:number; receipts:number; index:number }
interface ScoreUpdate {score:number;at:number;acceptedAt:number}
const samples:number[] = []; const propagation:number[] = []; const playerPropagation:number[] = [];
const pendingPropagation = new Map<string,ScoreUpdate[]>(); const pendingPlayers = new Map<string,ScoreUpdate[]>(); const errors:string[] = [];
let lastProjector:{snapshot:PublicSnapshot;at:number}|undefined;
const lastPlayers = new Map<string,{snapshot:PlayerSnapshot;at:number}>();
function observePlayer(s:PlayerSnapshot,at=performance.now()) {
  lastPlayers.set(s.player.publicId,{snapshot:s,at});
  const pending = pendingPlayers.get(s.player.publicId); if (!pending) return;
  const remaining = pending.filter(p => { if (s.player.score >= p.score) { playerPropagation.push(Math.max(0,at-p.at)); return false; } return true; });
  if (remaining.length) pendingPlayers.set(s.player.publicId,remaining); else pendingPlayers.delete(s.player.publicId);
}
const httpSamples:number[] = []; const socketSamples:number[] = [];
let activeSubmissions = 0; let peakConcurrentSubmissions = 0;
const remote = process.env.BASE_URL;
const answerTransport = process.env.LOAD_ANSWER_TRANSPORT ?? 'mixed';
if (!['mixed','http','socket'].includes(answerTransport)) throw new Error('LOAD_ANSWER_TRANSPORT must be mixed, http or socket.');
const freshHttp = process.env.LOAD_FRESH_HTTP === 'true';
// Explicit bounded pools keep the load generator's HTTP reuse independent of fetch's global pool.
const httpAgent = new HttpAgent({keepAlive:!freshHttp,maxSockets:512,maxFreeSockets:256});
const httpsAgent = new HttpsAgent({keepAlive:!freshHttp,maxSockets:512,maxFreeSockets:256});
let local: ReturnType<typeof createApp> | undefined; let base = remote ?? ''; let adminCookie = ''; const drivers:Driver[] = [];
const allSockets = new Set<Socket>();
const count = Number(process.env.PARTICIPANTS ?? 150); const joinMs = Number(process.env.JOIN_WINDOW_MS ?? 15000);
if (!Number.isInteger(count) || count < 1 || count > 500 || !Number.isFinite(joinMs) || joinMs < 0) throw new Error('Invalid load-test parameters.');
let password = process.env.LOAD_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD;
function request<T>(path:string,body?:unknown,cookie=''):Promise<{data:T;cookie:string}> {
  const headers: Record<string,string> = {'Content-Type':'application/json',Cookie:cookie};
  if (freshHttp) headers.Connection = 'close';
  const content = body === undefined ? undefined : JSON.stringify(body);
  if (content !== undefined) headers['Content-Length'] = String(Buffer.byteLength(content));
  const url = new URL(base + '/api/' + path);
  const secure = url.protocol === 'https:';
  return new Promise((resolve,reject) => {
    let phase = 'created';
    const fail = (error:Error) => reject(new Error(`${path}: ${error.message}`));
    const req = (secure ? httpsRequest : httpRequest)(url, {
      method:body === undefined ? 'GET' : 'POST',headers,agent:secure ? httpsAgent : httpAgent,
      signal:AbortSignal.any([AbortSignal.timeout(10000),abort.signal])
    },res => {
      phase = 'response';
      res.setEncoding('utf8'); let raw = '';
      res.on('data',(chunk:string) => { raw += chunk; });
      res.on('error',fail);
      res.on('end',() => {
        try {
          const data = JSON.parse(raw);
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) throw new Error(`${res.statusCode} ${data.error ?? 'Request failed.'}`);
          resolve({data,cookie:res.headers['set-cookie']?.[0]?.split(';')[0] ?? cookie});
        } catch(error) { fail(error as Error); }
      });
    });
    req.on('socket',socket => {
      phase = socket.connecting ? 'connecting' : 'connected';
      if (socket.connecting) { socket.once('lookup',() => { phase = 'DNS resolved'; }); socket.once('connect',() => { phase = 'connected'; }); }
    });
    req.on('finish',() => { phase = 'request sent'; });
    req.on('error',error => fail(new Error(`${error.message} (phase: ${phase}; reused socket: ${req.reusedSocket})`))); req.end(content);
  });
}
const percentile = (values:number[],p:number) => { const sorted = [...values].sort((a,b) => a-b); return sorted.length ? Number(sorted[Math.min(sorted.length - 1,Math.floor(sorted.length*p))].toFixed(2)) : null; };
try {
  mkdirSync('artifacts',{recursive:true});
  if (!remote) {
    password = randomBytes(24).toString('hex');
    local = createApp({dbPath:`artifacts/load-${Date.now()}.sqlite`,baseUrl:'http://localhost:3000',password,secret:randomBytes(32).toString('hex'),production:false,enableLoadTest:true});
    await new Promise<void>(r => local!.http.listen(0,'127.0.0.1',r)); base = 'http://127.0.0.1:' + (local.http.address() as {port:number}).port;
  }
  if (!password) throw new Error('For remote testing set LOAD_ADMIN_PASSWORD and temporarily enable ENABLE_LOAD_TEST on the server.');
  adminCookie = (await request('admin/login',{password})).cookie;
  const original = (await request<PublicSnapshot>('public')).data.event.id;
  const event = (await request<{id:string}>('admin/events',{name:'LOAD TEST · ' + new Date().toISOString(),test:true,confirm:true},adminCookie)).data;
  await request('admin/open',{eventId:event.id},adminCookie);
  const observe = (s:PublicSnapshot,at=performance.now()) => {
    lastProjector = {snapshot:s,at};
    for (const [id,pending] of pendingPropagation) {
      const row = s.standings.find(r => r.publicId === id);
      const remaining = pending.filter(p => {
        if (row && row.score >= p.score) { propagation.push(Math.max(0,at-p.at)); return false; }
        // A player outside the displayed top 15 has no score row to publish.
        return row || s.serverNow < p.acceptedAt;
      });
      if (remaining.length) pendingPropagation.set(id,remaining); else pendingPropagation.delete(id);
    }
  };
  // Measure delivery to one projector, rather than the first of hundreds of player connections.
  const projector = io(base,{auth:{eventId:event.id},transports:['websocket'],reconnection:true});
  allSockets.add(projector); projector.on('standings',observe);
  await new Promise<void>((r,j) => {
    const timer = setTimeout(() => j(new Error('Projector connection timeout.')),10000);
    projector.once('connect',() => { clearTimeout(timer); r(); });
    projector.once('connect_error',error => { clearTimeout(timer); j(error); });
  });
  const wave = performance.now();
  await Promise.all(Array.from({length:count},async (_,i) => {
    await sleep(i * joinMs/count);
    const joined = await request<PlayerSnapshot>('join',{name:`Load Driver ${i + 1}`,registration:`LOAD-${event.id.slice(0,8)}-${i}`,eventId:event.id});
    const socket = io(base,{auth:{eventId:event.id},extraHeaders:{Cookie:joined.cookie},transports:['websocket'],reconnection:true});
    allSockets.add(socket);
    socket.on('snapshot',(s:PlayerSnapshot) => observePlayer(s));
    await new Promise<void>((r,j) => { const timeout = setTimeout(() => j(new Error('Socket connection timeout.')),10000); socket.once('connect',() => { clearTimeout(timeout); r(); }); socket.once('connect_error',j); });
    drivers.push({cookie:joined.cookie,socket,snapshot:joined.data,expected:0,receipts:0,index:i});
  }));
  console.log(`Joined ${drivers.length} players in ${Math.round(performance.now()-wave)} ms; isolated event ${event.id}.`);
  await request('admin/start',{eventId:event.id},adminCookie);
  await sleep(1100);
  const initialAt = performance.now();
  await Promise.all(drivers.map(async d => { const result = await d.socket.timeout(5000).emitWithAck('resume') as {snapshot:PlayerSnapshot;error?:string}; if (result.error) throw new Error(result.error); d.snapshot = result.snapshot; }));
  console.log(`Initial race snapshots loaded in ${Math.round(performance.now()-initialAt)} ms.`);
  const completedRounds = Array.from({length:20},() => 0);
  await Promise.all(drivers.map(async d => {
    for (let round = 0; round < 20; round++) {
      if (stopping) throw new Error('Test stopped.');
      const q = d.snapshot.question; if (!q) throw new Error(`Driver ${d.index}: missing question at ${round + 1}.`);
      const correct = answers.find(([prefix]) => q.text.startsWith(prefix))?.[1]; if (!correct) throw new Error('Missing independent answer mapping.');
      if (round === 5 && d.index % 50 === 0) {
        await sleep(Math.max(0,q.deadline - d.snapshot.serverNow) + 80);
        d.snapshot = (await request<PlayerSnapshot>('player',undefined,d.cookie)).data; d.receipts++;
        if (d.snapshot.player.progress !== round + 1) throw new Error('Timeout did not advance.'); completedRounds[round]++; continue;
      }
      const chooseCorrect = (round + d.index) % 4 !== 0;
      const selected = q.options.find(o => chooseCorrect ? o.text === correct : o.text !== correct)!;
      const input = {questionId:q.id,optionId:selected.id,requestId:randomUUID(),score:9999,time:0};
      const throughSocket = answerTransport === 'socket' || (answerTransport === 'mixed' && d.index % 2 === 0);
      const before = performance.now();
      peakConcurrentSubmissions = Math.max(peakConcurrentSubmissions,++activeSubmissions);
      const ack = await (async () => {
        try { return throughSocket
          ? await d.socket.timeout(5000).emitWithAck('answer',input) as {receipt?:Receipt;snapshot:PlayerSnapshot;error?:string}
          : (await request<{receipt:Receipt;snapshot:PlayerSnapshot;error?:string}>('answer',input,d.cookie)).data;
        } finally { activeSubmissions--; }
      })();
      const elapsed = performance.now()-before; samples.push(elapsed); (throughSocket ? socketSamples : httpSamples).push(elapsed);
      if (ack.error || !ack.receipt) throw new Error(`Driver ${d.index}, round ${round+1}: ${ack.error ?? 'No saved receipt.'}`);
      const expectedEarned = chooseCorrect ? 100 : 0; if (ack.receipt.earned !== expectedEarned) throw new Error('Receipt disagrees with independent answer.');
      d.expected += expectedEarned; d.receipts++; d.snapshot = ack.snapshot;
      if (chooseCorrect) {
        const id = d.snapshot.player.publicId; const update = {score:d.expected,at:before,acceptedAt:ack.receipt.acceptedAt};
        for (const pending of [pendingPropagation,pendingPlayers]) { const list = pending.get(id) ?? []; list.push(update); pending.set(id,list); }
        const latest = lastPlayers.get(id); if (latest) observePlayer(latest.snapshot,latest.at);
        // The UI immediately renders the private snapshot returned with the saved answer receipt.
        observePlayer(d.snapshot);
        if (lastProjector) observe(lastProjector.snapshot,lastProjector.at);
      }
      if (d.index % 5 === 0) {
        const duplicate = (await request<{receipt:Receipt;snapshot:PlayerSnapshot}>('answer',input,d.cookie)).data;
        if (JSON.stringify(duplicate.receipt) !== JSON.stringify(ack.receipt) || duplicate.snapshot.player.score !== d.expected) throw new Error('Duplicate submission mutated scoring.');
        if (duplicate.snapshot.player.progress !== d.snapshot.player.progress) throw new Error('A question expired during the retry check; the saved receipt is unchanged.');
      }
      if (round % 5 === 2 && d.index % 10 === 0) {
        const previous = d.snapshot.question; d.socket.disconnect(); await sleep(50);
        await new Promise<void>((r,j) => { const timer = setTimeout(() => j(new Error(`Driver ${d.index}, round ${round+1}: reconnect timeout.`)),8000); d.socket.once('connect',() => { clearTimeout(timer); r(); }); d.socket.once('connect_error',error => { clearTimeout(timer); j(error); }); d.socket.connect(); });
        d.snapshot = (await request<PlayerSnapshot>('player',undefined,d.cookie)).data;
        if (JSON.stringify(previous) !== JSON.stringify(d.snapshot.question)) throw new Error('Reconnect changed question/order/deadline.');
      }
      if (d.snapshot.player.score !== d.expected || d.snapshot.player.progress !== round + 1) throw new Error(`Driver ${d.index}: duplicate or incorrect scoring.`);
      if (++completedRounds[round] === count && round % 5 === 4) console.log(`Verified ${round + 1}/20 questions for ${drivers.length} drivers.`);
      await sleep(100);
    }
  }));
  await sleep(1200); await request('admin/freeze',{eventId:event.id},adminCookie);
  const final = (await request<PublicSnapshot & {counts:{answers:number;totalPoints:number}}>('admin/state?eventId=' + event.id,undefined,adminCookie)).data;
  let verified = 0;
  for (const d of drivers) { const row = final.standings.find(s => s.publicId === d.snapshot.player.publicId); if (!row || row.score !== d.expected || row.progress !== 20 || !row.finished) errors.push(`Driver ${d.index}: final score mismatch.`); else verified++; }
  if (final.counts.answers !== count * 20) errors.push(`Expected ${count*20} stored answers, found ${final.counts.answers}.`);
  if ((await request<PublicSnapshot>('public')).data.event.id !== original) errors.push('Load test changed the real current event.');
  if (pendingPropagation.size) errors.push('Some score changes never reached the public standings.');
  if (pendingPlayers.size) errors.push('Some score changes never reached their private player connection.');
  if (!propagation.length) errors.push('No projector score updates were observed.');
  const report = {target:base,remote:!!remote,eventId:event.id,participants:count,joinWindowMs:joinMs,answerTransports:answerTransport === 'mixed' ? '50% HTTP, 50% Socket.IO' : answerTransport === 'http' ? '100% HTTP' : '100% Socket.IO',httpConnections:freshHttp ? 'fresh TCP per request' : 'HTTP keep-alive',peakConcurrentSubmissions,errors,storedAnswers:final.counts.answers,acknowledgedAnswers:samples.length,timeoutAnswers:count*20-samples.length,ackP50Ms:percentile(samples,.5),ackP95Ms:percentile(samples,.95),httpAckP95Ms:percentile(httpSamples,.95),socketAckP95Ms:percentile(socketSamples,.95),observedProjectorScoreChanges:propagation.length,leaderboardP95Ms:percentile(propagation,.95),leaderboardMaxMs:propagation.length ? Math.round(Math.max(...propagation)) : null,playerUpdateTransport:'private answer acknowledgments and pushed snapshots',playerUpdateP95Ms:percentile(playerPropagation,.95),playerUpdateMaxMs:playerPropagation.length ? Math.round(Math.max(...playerPropagation)) : null,verifiedScores:verified};
  writeFileSync(remote ? 'artifacts/load-report-remote.json' : 'artifacts/load-report-local.json',JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
  if (errors.length || verified !== count || (report.ackP95Ms ?? Infinity) >= 1000 || (report.leaderboardMaxMs ?? Infinity) >= 2000 || (report.playerUpdateMaxMs ?? Infinity) >= 2000) process.exitCode = 1;
} catch(error) {
  console.error('Load test failed:',(error as Error).message);
  console.error(JSON.stringify({acknowledged:samples.length,httpAcknowledged:httpSamples.length,socketAcknowledged:socketSamples.length,ackP50Ms:percentile(samples,.5),ackP95Ms:percentile(samples,.95),connected:drivers.filter(d => d.socket.connected).length,clientRssBytes:process.memoryUsage().rss,clientEventLoopMaxMs:clientLoop.max/1e6,httpPool:{busy:Object.values(httpAgent.sockets).reduce((n,s)=>n+(s?.length ?? 0),0),free:Object.values(httpAgent.freeSockets).reduce((n,s)=>n+(s?.length ?? 0),0),queued:Object.values(httpAgent.requests).reduce((n,s)=>n+(s?.length ?? 0),0)}},null,2));
  process.exitCode = 1;
}
finally { stopping = true; abort.abort(); clientLoop.disable(); for (const socket of allSockets) socket.disconnect(); httpAgent.destroy(); httpsAgent.destroy(); if (local) await local.close(); }
