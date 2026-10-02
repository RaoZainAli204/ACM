import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { parse, serialize } from 'cookie';
import QRCode from 'qrcode';
import { Server } from 'socket.io';
import { Engine, GameError, sessionHash } from './engine.js';
import type { AnswerInput, Receipt } from '../shared/types.js';

export interface Config { dbPath: string; baseUrl: string; password: string; secret: string; production: boolean; enableLoadTest?: boolean; now?: () => number; scheduler?: boolean }
export function createApp(config: Config) {
  const engine = new Engine(config.dbPath, config.baseUrl, config.now);
  const app = express(); const http = createServer(app);
  const loop = config.enableLoadTest ? monitorEventLoopDelay({resolution:20}) : undefined;
  loop?.enable();
  const activeHttp = new Map<number,{path:string;at:number}>();
  let requestSequence = 0; let maxHttpMs = 0; let answerBatches = 0; let maxBatchMs = 0; let maxBatchSize = 0;
  if (config.enableLoadTest) app.use((req,res,next) => {
    const id = ++requestSequence; const at = performance.now(); activeHttp.set(id,{path:req.path,at});
    const done = () => { if (activeHttp.delete(id)) maxHttpMs = Math.max(maxHttpMs,performance.now()-at); };
    res.once('finish',done); res.once('close',done); next();
  });
  app.disable('x-powered-by'); app.set('trust proxy', 1);
  const origins = new Set([new URL(config.baseUrl).origin]);
  if (!config.production) { origins.add('http://localhost:5173'); origins.add('http://127.0.0.1:5173'); origins.add('http://localhost:3000'); origins.add('http://127.0.0.1:3000'); }
  const io = new Server(http, { maxHttpBufferSize: 8192, serveClient: false, allowRequest: (req, cb) => cb(null, !req.headers.origin || origins.has(req.headers.origin)), cors: { origin: [...origins], credentials: true } });
  const cookieOptions = { httpOnly: true, secure: config.production, sameSite: 'strict' as const, path: '/', maxAge: 60 * 60 * 24 * 7 };
  const cookies = (req: { headers: { cookie?: string } }) => parse(req.headers.cookie ?? '');
  const sign = (s: string) => createHmac('sha256', config.secret).update(s).digest('base64url');
  const equal = (a: string, b: string) => { const aa = Buffer.from(a); const bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); };
  const isAdmin = (req: { headers: { cookie?: string } }) => {
    const token = cookies(req).race_admin; if (!token || token.length > 256) return false;
    const [exp, nonce, sig] = token.split('.'); return !!sig && Number(exp) > Date.now() && equal(sign(exp + '.' + nonce), sig);
  };
  const requireAdmin = (req: Request, _res: Response, next: NextFunction) => isAdmin(req) ? next() : next(new GameError(401, 'Organizer login required.'));
  const player = (req: Request) => { const p = engine.playerForToken(cookies(req).race_player); if (!p) throw new GameError(401, 'Join the race in this browser first.'); return p; };
  let closing = false;
  let answerFlush: NodeJS.Immediate | undefined;
  const answerQueue: { id:string; input:AnswerInput; resolve:(receipt:Receipt)=>void; reject:(error:unknown)=>void }[] = [];
  function flushAnswers() {
    if (answerFlush) { clearImmediate(answerFlush); answerFlush = undefined; }
    if (!answerQueue.length) return;
    const batch = answerQueue.splice(0);
    const before = performance.now();
    const outcomes: ({receipt:Receipt} | {error:unknown})[] = [];
    try {
      // A burst shares one durable commit. Each answer retains its own savepoint and unique key.
      engine.db.transaction(() => { for (const job of batch) { try { outcomes.push({receipt:engine.answer(job.id,job.input)}); } catch(error) { outcomes.push({error}); } } })();
      // Resolve only after the outer transaction has committed to disk.
      batch.forEach((job,i) => { const result = outcomes[i]; if ('receipt' in result) job.resolve(result.receipt); else job.reject(result.error); });
    } catch(error) { for (const job of batch) job.reject(error); }
    finally { if (config.enableLoadTest) { answerBatches++; maxBatchSize = Math.max(maxBatchSize,batch.length); maxBatchMs = Math.max(maxBatchMs,performance.now()-before); } }
  }
  function queueAnswer(id:string,input:AnswerInput) {
    if (closing || answerQueue.length >= 1000) return Promise.reject(new GameError(503,'Server busy. Retry your saved answer shortly.'));
    return new Promise<Receipt>((resolve,reject) => { answerQueue.push({id,input,resolve,reject}); if (!answerFlush) answerFlush = setImmediate(flushAnswers); });
  }
  const limits = new Map<string, { count: number; until: number }>();
  function limit(key: string, max: number, windowMs: number) {
    const now = Date.now(); let entry = limits.get(key); if (!entry || now >= entry.until) { entry = { count: 0, until: now + windowMs }; limits.set(key, entry); }
    if (++entry.count > max) throw new GameError(429, 'Too many requests. Please wait a moment.');
    if (limits.size > 5000) for (const [k, v] of limits) if (v.until < now) limits.delete(k);
  }
  function publicEventId(value: unknown) {
    if (!value) return engine.currentId();
    if (typeof value !== 'string') throw new GameError(400, 'Invalid event.');
    if (value === engine.currentId()) return value;
    if (!config.enableLoadTest || !engine.event(value).is_test) throw new GameError(404, 'Event not available.');
    return value;
  }
  function visibleSnapshot(id:string) {
    const snapshot = engine.publicSnapshot(id);
    return {...snapshot,standings:snapshot.standings.slice(0,15)};
  }
  app.use((_req, res, next) => { res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','same-origin'); res.setHeader('X-Frame-Options','DENY'); next(); });
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control','no-store'); next(); });
  app.use('/api', (req, _res, next) => {
    if (req.method !== 'GET' && req.headers.origin && !origins.has(req.headers.origin)) return next(new GameError(403, 'Origin not allowed.'));
    next();
  });
  app.use(express.json({ limit: '8kb' }));
  app.get('/health', (_req, res) => { engine.sql('SELECT 1').get(); res.json({ ok: true }); });
  app.get('/api/public', (req, res) => res.json(visibleSnapshot(publicEventId(req.query.eventId))));
  app.get('/api/player', (req, res) => res.json(engine.snapshot(player(req).id)));
  app.post('/api/join', (req, res) => {
    limit('join:' + req.ip, 400, 60000);
    const eventId = publicEventId(req.body.eventId); const existing = engine.playerForToken(cookies(req).race_player);
    if (existing?.event_id === eventId) return res.json(engine.snapshot(existing.id));
    const joined = engine.join(req.body.name, req.body.registration, eventId);
    res.setHeader('Set-Cookie', serialize('race_player', joined.token, cookieOptions));
    res.status(201).json(engine.snapshot(joined.participantId));
  });
  app.post('/api/answer', async (req, res) => {
    const p = player(req); limit('answer:' + p.id, 100, 60000);
    const receipt = await queueAnswer(p.id, req.body as AnswerInput);
    res.json({ receipt, snapshot: engine.snapshot(p.id) });
  });
  app.post('/api/admin/login', (req, res) => {
    limit('login:' + req.ip, 20, 15 * 60000);
    if (typeof req.body.password !== 'string' || !equal(req.body.password, config.password)) throw new GameError(401, 'Incorrect organizer password.');
    const value = (Date.now() + 12 * 3600000) + '.' + randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', serialize('race_admin', value + '.' + sign(value), { ...cookieOptions, maxAge: 12 * 3600 })); res.json({ ok: true });
  });
  app.use('/api/admin', requireAdmin);
  app.get('/api/admin/diagnostics', (_req,res) => {
    if (!config.enableLoadTest) throw new GameError(404,'Not found.');
    res.json({requestsSeen:requestSequence,maxHttpMs,activeHttp:[...activeHttp.values()].map(r => ({path:r.path,ageMs:performance.now()-r.at})),answerBatches,maxBatchSize,maxBatchMs,queuedAnswers:answerQueue.length,eventLoopMaxMs:loop ? loop.max/1e6 : null,rssBytes:process.memoryUsage().rss,sockets:io.sockets.sockets.size});
  });
  app.post('/api/admin/logout', (_req, res) => { res.setHeader('Set-Cookie',serialize('race_admin','',{ ...cookieOptions, maxAge: 0 })); res.json({ ok: true }); });
  app.get('/api/admin/events', (_req, res) => res.json({ currentId: engine.currentId(), events: engine.history() }));
  app.post('/api/admin/events', (req, res) => {
    const test = req.body.test === true;
    if (test && !config.enableLoadTest) throw new GameError(403, 'Load testing is disabled. Set ENABLE_LOAD_TEST=true temporarily.');
    const event = engine.createEvent(req.body.name, req.body.confirm === true, test, test ? { durations: [20000,20000,20000,20000], countdown: 1000, global: 600000 } : undefined);
    res.status(201).json(event);
  });
  app.get('/api/admin/state', (req, res) => {
    const id = typeof req.query.eventId === 'string' ? req.query.eventId : engine.currentId();
    const counts = engine.sql('SELECT COUNT(*) AS answers, SUM(earned) AS totalPoints FROM answers WHERE event_id = ?').get(id);
    res.json({ ...engine.publicSnapshot(id), counts });
  });
  for (const action of ['open','start','freeze'] as const) app.post('/api/admin/' + action, (req, res) => {
    const id = typeof req.body.eventId === 'string' ? req.body.eventId : engine.currentId(); flushAnswers(); engine[action](id); res.json(engine.publicSnapshot(id));
  });
  app.get('/api/admin/export.csv', (req, res) => {
    const id = typeof req.query.eventId === 'string' ? req.query.eventId : engine.currentId();
    res.setHeader('Content-Disposition', 'attachment; filename="404-grand-prix-' + engine.event(id).id + '.csv"'); res.type('text/csv').send(engine.exportCsv(id));
  });
  app.get('/api/admin/qr.png', async (_req, res) => {
    const png = await QRCode.toBuffer(config.baseUrl.replace(/\/$/u,'') + '/join', { type: 'png', width: 800, margin: 4, errorCorrectionLevel: 'M', color: { dark:'#000000',light:'#ffffff' } });
    res.setHeader('Content-Disposition','attachment; filename="404-grand-prix-join.png"'); res.type('png').send(png);
  });
  app.get('/api/qr', async (_req, res) => res.type('svg').send(await QRCode.toString(config.baseUrl.replace(/\/$/u,'') + '/join',{ type:'svg',margin:4,errorCorrectionLevel:'M',color:{dark:'#000000',light:'#ffffff'} })));

  io.use((socket, next) => {
    try {
      limit('socket:' + socket.handshake.address, 1000, 60000);
      publicEventId(socket.handshake.auth.eventId);
      next();
    } catch { next(new Error('Connection not allowed.')); }
  });
  io.on('connection', socket => {
    const eventId = publicEventId(socket.handshake.auth.eventId); socket.join('public:' + eventId);
    socket.emit('standings', visibleSnapshot(eventId));
    const p = engine.playerForToken(cookies(socket.request).race_player);
    if (p) { socket.data.participantId = p.id; socket.data.playerEventId = p.event_id; socket.join('player:' + p.session_hash); socket.emit('snapshot', engine.snapshot(p.id)); }
    socket.on('resume', (ack) => {
      try { limit('resume:' + (p?.id ?? socket.handshake.address), 120, 60000); if (typeof ack === 'function') ack(p ? { snapshot: engine.snapshot(p.id) } : { error:'Join first.' }); } catch (err) { if (typeof ack === 'function') ack({ error: (err as Error).message }); }
    });
    socket.on('answer', async (input, ack) => {
      try {
        if (!p) throw new GameError(401,'Join first.'); limit('answer:' + p.id,100,60000);
        const receipt = await queueAnswer(p.id,input); if (typeof ack === 'function') ack({ receipt, snapshot: engine.snapshot(p.id) });
      } catch (err) { if (typeof ack === 'function') ack({ error: (err as Error).message, status: err instanceof GameError ? err.status : 500 }); }
    });
    // There are deliberately no organizer socket mutations. All organizer actions use authenticated HTTP.
  });
  let lastPublic = 0; const previousRanks = new Map<string, number>(); const currentRanks = new Map<string,number|null>(); const privateVersions = new Map<string,string>();
  const scheduler = config.scheduler === false ? undefined : setInterval(() => {
    try {
      flushAnswers(); engine.tick();
      if (Date.now() - lastPublic >= 1000) {
        lastPublic = Date.now();
        const events = new Set([engine.currentId(), ...(config.enableLoadTest ? engine.history().filter(e => e.test && e.state !== 'closed').map(e => e.id) : [])]);
        for (const id of events) {
          const snapshot = engine.publicSnapshot(id);
          for (const row of snapshot.standings) { const old = previousRanks.get(row.publicId); row.movement = old !== undefined ? old - row.rank! : 0; previousRanks.set(row.publicId,row.rank!); currentRanks.set(row.publicId,row.rank); }
          for (const row of snapshot.unfinished) currentRanks.set(row.publicId,null);
          io.to('public:' + id).emit('standings', {...snapshot,standings:snapshot.standings.slice(0,15)});
        }
      }
      const activeEventIds = new Set<string>();
      for (const socket of io.sockets.sockets.values()) if (socket.data.playerEventId) activeEventIds.add(socket.data.playerEventId as string);
      const versions = new Map<string,string>();
      for (const id of activeEventIds) for (const row of engine.sql('SELECT p.id, p.public_id, p.progress, p.score, e.state FROM participants p JOIN events e ON e.id = p.event_id WHERE p.event_id = ?').all(id) as {id:string;public_id:string;progress:number;score:number;state:string}[]) versions.set(row.id,[row.progress,row.score,row.state,currentRanks.get(row.public_id) ?? ''].join(':'));
      for (const socket of io.sockets.sockets.values()) {
        const id = socket.data.participantId as string | undefined; if (!id) continue;
        const version = versions.get(id); if (version && privateVersions.get(socket.id) !== version) { privateVersions.set(socket.id,version); socket.emit('snapshot',engine.snapshot(id)); }
      }
    } catch (error) { console.error('Scheduler failed:', (error as Error).message); }
  }, 100);
  io.on('connection', socket => socket.on('disconnect',() => privateVersions.delete(socket.id)));
  const client = resolve('dist/client');
  if (existsSync(resolve(client,'index.html'))) {
    app.use(express.static(client, { index: false }));
    app.get(['/', '/join', '/display', '/admin'], (_req,res) => res.sendFile(resolve(client,'index.html')));
  }
  app.use((_req,_res,next) => next(new GameError(404,'Not found.')));
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof GameError ? err.status : (err as Error & { status?: number }).status ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Server error. Retry shortly.' : err.message });
  });
  async function close() {
    closing = true; flushAnswers(); if (scheduler) clearInterval(scheduler); loop?.disable();
    // Browsers can retain HTTP keep-alive requests during a restart. Bound the drain time.
    const drain = setTimeout(() => http.closeAllConnections(),2000);
    try { await new Promise<void>(r => io.close(() => r())); } finally { clearTimeout(drain); engine.close(); }
  }
  return { app, http, io, engine, close };
}
