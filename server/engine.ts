import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { bank, type SeedQuestion } from './seed.js';
import type { AnswerInput, EventState, PlayerSnapshot, PublicEvent, PublicSnapshot, Receipt, Standing } from '../shared/types.js';

export class GameError extends Error { constructor(public status: number, message: string) { super(message); } }
interface EventRow { id: string; name: string; state: EventState; start_at: number | null; end_at: number | null; bank_json: string; durations_json: string; countdown_ms: number; global_ms: number; is_test: number }
interface PlayerRow { id: string; event_id: string; public_id: string; name: string; registration: string; session_hash: string; score: number; progress: number; adjusted_ms: number }
interface QuestionRow { instance_id: string; event_id: string; participant_id: string; slot: number; seed_id: number; options_json: string; allowance_ms: number; issued_at: number | null; deadline: number | null }
interface Option { id: string; source: number; text: string }
interface AnswerRow { question_id: string; request_id: string | null; option_id: string | null; earned: number; adjusted_ms: number; timed_out: number; accepted_at: number }
const shuffle = <T>(items: T[]) => { const copy = [...items]; for (let i = copy.length - 1; i > 0; i--) { const j = randomInt(i + 1); [copy[i], copy[j]] = [copy[j], copy[i]]; } return copy; };
export const sessionHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const csvCell = (value: unknown) => { let s = String(value ?? ''); if (/^[\s\u0000-\u001f]*[=+@-]/u.test(s) || /^[\t\r\n]/u.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; };

export class Engine {
  readonly db: Database.Database;
  private statements = new Map<string, Database.Statement>();
  private banks = new Map<string, SeedQuestion[]>();
  constructor(path: string, readonly baseUrl: string, readonly now: () => number = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON'); this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL,
        start_at INTEGER, end_at INTEGER, bank_json TEXT NOT NULL,
        durations_json TEXT NOT NULL, countdown_ms INTEGER NOT NULL,
        global_ms INTEGER NOT NULL, is_test INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), public_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL, registration TEXT NOT NULL, session_hash TEXT NOT NULL UNIQUE,
        score INTEGER NOT NULL DEFAULT 0, progress INTEGER NOT NULL DEFAULT 0,
        adjusted_ms INTEGER NOT NULL DEFAULT 0, UNIQUE(event_id, registration)
      );
      CREATE INDEX IF NOT EXISTS participants_event ON participants(event_id);
      CREATE INDEX IF NOT EXISTS participants_ranking ON participants(event_id, score DESC, adjusted_ms ASC);
      CREATE TABLE IF NOT EXISTS player_questions (
        instance_id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id),
        participant_id TEXT NOT NULL REFERENCES participants(id), slot INTEGER NOT NULL,
        seed_id INTEGER NOT NULL, options_json TEXT NOT NULL, allowance_ms INTEGER NOT NULL,
        issued_at INTEGER, deadline INTEGER, UNIQUE(event_id, participant_id, slot)
      );
      CREATE TABLE IF NOT EXISTS answers (
        event_id TEXT NOT NULL REFERENCES events(id), participant_id TEXT NOT NULL REFERENCES participants(id),
        question_id TEXT NOT NULL REFERENCES player_questions(instance_id), request_id TEXT,
        option_id TEXT, earned INTEGER NOT NULL, adjusted_ms INTEGER NOT NULL,
        timed_out INTEGER NOT NULL, accepted_at INTEGER NOT NULL,
        PRIMARY KEY(event_id, participant_id, question_id), UNIQUE(participant_id, request_id)
      );
      PRAGMA user_version = 1;
    `);
    if (!this.sql('SELECT value FROM meta WHERE key = ?').get('current_event')) this.createEvent('404 Grand Prix · Orientation 2026', true);
    this.tick();
  }
  sql(query: string) { let stmt = this.statements.get(query); if (!stmt) { stmt = this.db.prepare(query); this.statements.set(query, stmt); } return stmt; }
  currentId() { return (this.sql('SELECT value FROM meta WHERE key = ?').get('current_event') as { value: string }).value; }
  event(id = this.currentId()) { const e = this.sql('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined; if (!e) throw new GameError(404, 'Event not found.'); return e; }
  private bankFor(e: EventRow) { let questions = this.banks.get(e.id); if (!questions) { questions = JSON.parse(e.bank_json) as SeedQuestion[]; this.banks.set(e.id, questions); } return questions; }
  publicEvent(e: EventRow): PublicEvent { return { id: e.id, name: e.name, state: e.state, startAt: e.start_at, endAt: e.end_at, test: !!e.is_test }; }
  createEvent(name: string, confirmed: boolean, test = false, timing?: { durations: number[]; countdown: number; global: number }) {
    if (!confirmed) throw new GameError(400, 'Confirm creation of a fresh event.');
    if (typeof name !== 'string' || name.trim().length < 1 || name.length > 100) throw new GameError(400, 'Use an event name of 1–100 characters.');
    const existing = this.sql('SELECT value FROM meta WHERE key = ?').get('current_event') as { value: string } | undefined;
    if (!test && existing && !['closed','frozen'].includes(this.event(existing.value).state)) throw new GameError(409, 'Freeze the current event before creating another.');
    const id = randomUUID();
    this.db.transaction(() => {
      this.sql('INSERT INTO events VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)').run(id, name.trim(), 'closed', JSON.stringify(bank), JSON.stringify(timing?.durations ?? [15000,20000,25000,30000]), timing?.countdown ?? 5000, timing?.global ?? 540000, test ? 1 : 0, this.now());
      if (!test) this.sql('INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('current_event', id);
    })();
    return this.publicEvent(this.event(id));
  }
  open(id: string) { const e = this.event(id); if (!['closed','lobby'].includes(e.state)) throw new GameError(409, 'This event has already started.'); this.sql('UPDATE events SET state = ? WHERE id = ?').run('lobby', id); }
  join(name: unknown, registration: unknown, eventId = this.currentId()) {
    if (typeof name !== 'string' || typeof registration !== 'string') throw new GameError(400, 'Enter your name and registration number.');
    name = name.trim().replace(/\s+/gu, ' ');
    registration = registration.trim().toUpperCase();
    if ((name as string).length < 2 || (name as string).length > 60 || /[\u0000-\u001f\u007f]/u.test(name as string)) throw new GameError(400, 'Use a name of 2–60 characters without control characters.');
    if (!/^[A-Z0-9][A-Z0-9/_.-]{2,39}$/u.test(registration as string)) throw new GameError(400, 'Registration must be 3–40 letters, numbers, hyphens, dots, underscores or slashes.');
    const token = randomBytes(32).toString('base64url'); const id = randomUUID();
    this.db.transaction(() => {
      const e = this.event(eventId);
      if (!['lobby','countdown'].includes(e.state) || (e.start_at !== null && this.now() >= e.start_at)) throw new GameError(409, 'Registration is closed.');
      if (this.sql('SELECT id FROM participants WHERE event_id = ? AND registration = ?').get(eventId, registration)) throw new GameError(409, 'This registration is already entered. Resume in the original browser or ask an organizer.');
      this.sql('INSERT INTO participants (id,event_id,public_id,name,registration,session_hash) VALUES (?,?,?,?,?,?)').run(id, eventId, randomUUID(), name, registration, sessionHash(token));
      const questions = this.bankFor(e); const durations = JSON.parse(e.durations_json) as number[];
      const order = [0,1,2,3].flatMap(group => shuffle(questions.slice(group * 5, group * 5 + 5)));
      order.forEach((q, slot) => {
        const options = shuffle(q.options.map((text, source) => ({ id: randomUUID(), source, text })));
        this.sql('INSERT INTO player_questions VALUES (?,?,?,?,?,?,?,NULL,NULL)').run(randomUUID(), eventId, id, slot, q.id, JSON.stringify(options), durations[Math.floor(slot / 5)]);
      });
    })();
    return { token, participantId: id };
  }
  playerForToken(token: string | undefined) { if (!token || token.length > 128) return undefined; return this.sql('SELECT * FROM participants WHERE session_hash = ?').get(sessionHash(token)) as PlayerRow | undefined; }
  player(id: string) { const p = this.sql('SELECT * FROM participants WHERE id = ?').get(id) as PlayerRow | undefined; if (!p) throw new GameError(401, 'Join the race in this browser first.'); return p; }
  start(id: string) {
    this.db.transaction(() => {
      const e = this.event(id); if (e.state !== 'lobby') throw new GameError(409, 'Open registration before starting.');
      const start = this.now() + e.countdown_ms;
      this.sql('UPDATE events SET state = ?, start_at = ?, end_at = ? WHERE id = ?').run('countdown', start, start + e.global_ms, id);
    })();
  }
  private currentQuestion(p: PlayerRow) { return this.sql('SELECT * FROM player_questions WHERE participant_id = ? AND slot = ?').get(p.id, p.progress) as QuestionRow | undefined; }
  private record(p: PlayerRow, q: QuestionRow, optionId: string | null, requestId: string | null, earned: number, adjustedMs: number, at: number) {
    this.sql('INSERT INTO answers VALUES (?,?,?,?,?,?,?,?,?)').run(p.event_id, p.id, q.instance_id, requestId, optionId, earned, adjustedMs, optionId === null ? 1 : 0, at);
    this.sql('UPDATE participants SET score = score + ?, adjusted_ms = adjusted_ms + ?, progress = progress + 1 WHERE id = ?').run(earned, adjustedMs, p.id);
    const next = this.sql('SELECT * FROM player_questions WHERE participant_id = ? AND slot = ?').get(p.id, p.progress + 1) as QuestionRow | undefined;
    if (next) this.sql('UPDATE player_questions SET issued_at = ?, deadline = ? WHERE instance_id = ?').run(at, at + next.allowance_ms, next.instance_id);
  }
  private catchUp(p: PlayerRow, at: number) {
    while (p.progress < 20) {
      const q = this.currentQuestion(p)!;
      if (q.deadline === null || at < q.deadline) break;
      this.record(p, q, null, null, 0, q.allowance_ms, q.deadline);
      p = this.player(p.id);
    }
  }
  sync(id: string, participantId?: string) {
    this.db.transaction(() => {
      let e = this.event(id); const now = this.now();
      if (e.state === 'countdown' && now >= e.start_at!) {
        this.sql('UPDATE events SET state = ? WHERE id = ?').run('racing', id);
        this.sql('UPDATE player_questions SET issued_at = ?, deadline = ? + allowance_ms WHERE event_id = ? AND slot = 0').run(e.start_at, e.start_at, id);
        e = this.event(id);
      }
      if (e.state !== 'racing') return;
      const all = !participantId || now >= e.end_at!;
      const dueQuery = 'SELECT p.* FROM participants p JOIN player_questions q ON q.event_id = p.event_id AND q.participant_id = p.id AND q.slot = p.progress WHERE p.event_id = ? AND q.deadline <= ?' + (all ? '' : ' AND p.id = ?');
      const at = Math.min(now, e.end_at!);
      const players = (all ? this.sql(dueQuery).all(id, at) : this.sql(dueQuery).all(id, at, participantId!)) as PlayerRow[];
      for (const p of players) this.catchUp(p, Math.min(now, e.end_at!));
      if (now >= e.end_at!) this.sql('UPDATE events SET state = ? WHERE id = ?').run('frozen', id);
    })();
  }
  tick() { for (const row of this.sql("SELECT id FROM events WHERE state IN ('countdown','racing')").all() as { id: string }[]) this.sync(row.id); }
  freeze(id: string) {
    this.db.transaction(() => { this.sync(id); this.sql('UPDATE events SET state = ? WHERE id = ?').run('frozen', id); })();
  }
  answer(id: string, input: AnswerInput) {
    if (!input || typeof input.questionId !== 'string' || typeof input.optionId !== 'string' || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/u.test(input.requestId) || input.questionId.length > 80 || input.optionId.length > 80) throw new GameError(400, 'Invalid answer request.');
    return this.db.transaction(() => {
      let p = this.player(id); this.sync(p.event_id, p.id); p = this.player(id);
      const saved = this.sql('SELECT * FROM answers WHERE participant_id = ? AND question_id = ?').get(id, input.questionId) as AnswerRow | undefined;
      if (saved && saved.request_id === input.requestId && saved.option_id === input.optionId) return this.receipt(saved);
      if (this.event(p.event_id).state !== 'racing') throw new GameError(409, 'The race is not accepting answers.');
      const q = this.currentQuestion(p);
      if (!q || q.instance_id !== input.questionId) throw new GameError(409, 'That question is no longer current. Refresh your race state.');
      const now = this.now(); if (q.issued_at === null || now < q.issued_at || now >= q.deadline!) throw new GameError(409, 'The answer deadline has passed.');
      const options = JSON.parse(q.options_json) as Option[]; const chosen = options.find(o => o.id === input.optionId);
      if (!chosen) throw new GameError(400, 'This option does not belong to your question.');
      if (this.sql('SELECT question_id FROM answers WHERE participant_id = ? AND request_id = ?').get(id, input.requestId)) throw new GameError(409, 'Request ID was already used.');
      const question = this.bankFor(this.event(p.event_id)).find(qn => qn.id === q.seed_id)!;
      const earned = chosen.source === question.correct ? 100 : 0;
      this.record(p, q, input.optionId, input.requestId, earned, earned ? now - q.issued_at : q.allowance_ms, now);
      return this.receipt(this.sql('SELECT * FROM answers WHERE participant_id = ? AND question_id = ?').get(id, input.questionId) as AnswerRow);
    })();
  }
  private receipt(a: AnswerRow): Receipt { return { questionId: a.question_id, requestId: a.request_id, earned: a.earned, adjustedMs: a.adjusted_ms, timedOut: !!a.timed_out, acceptedAt: a.accepted_at }; }
  private ranked(id: string) {
    const e = this.event(id); const all = this.sql('SELECT public_id, name, score, progress, adjusted_ms FROM participants WHERE event_id = ? ORDER BY score DESC, adjusted_ms ASC, public_id ASC').all(id) as PlayerRow[];
    const eligible = e.state === 'frozen' ? all.filter(p => p.progress === 20) : all;
    let previous: PlayerRow | undefined; let rank = 0;
    const standings = eligible.map((p, i): Standing => {
      if (!previous || previous.score !== p.score || previous.adjusted_ms !== p.adjusted_ms) rank = i + 1;
      previous = p;
      return { publicId: p.public_id, name: p.name, score: p.score, progress: p.progress, rank, movement: 0, finished: p.progress === 20 };
    });
    const unfinished = e.state === 'frozen' ? all.filter(p => p.progress < 20).map((p): Standing => ({ publicId: p.public_id, name: p.name, score: p.score, progress: p.progress, rank: null, movement: 0, finished: false })) : [];
    const cutoffTie = standings.length > 10 && standings[9].rank === standings[10].rank;
    return { standings, unfinished, cutoffTie, count: all.length };
  }
  publicSnapshot(id = this.currentId()): PublicSnapshot {
    this.sync(id);
    return { serverNow: this.now(), event: this.publicEvent(this.event(id)), ...this.ranked(id), joinUrl: this.baseUrl.replace(/\/$/u, '') + '/join' };
  }
  snapshot(id: string): PlayerSnapshot {
    let p = this.player(id); this.sync(p.event_id, p.id); p = this.player(id); const e = this.event(p.event_id);
    const eligible = e.state !== 'frozen' || p.progress === 20;
    const query = 'SELECT COUNT(*) AS n FROM participants WHERE event_id = ? AND (score > ? OR (score = ? AND adjusted_ms < ?))' + (e.state === 'frozen' ? ' AND progress = 20' : '');
    const rank = eligible ? (this.sql(query).get(p.event_id, p.score, p.score, p.adjusted_ms) as {n: number}).n + 1 : null;
    const q = e.state === 'racing' ? this.currentQuestion(p) : undefined;
    const bank = this.bankFor(e);
    const seed = q ? bank.find(x => x.id === q.seed_id)! : undefined;
    const out: PlayerSnapshot = {
      serverNow: this.now(), event: this.publicEvent(e),
      player: { publicId: p.public_id, name: p.name, score: p.score, progress: p.progress, rank, finished: p.progress === 20, adjustedMs: p.adjusted_ms },
      question: q && seed ? { id: q.instance_id, number: q.slot + 1, text: seed.text, image: seed.image ?? null, imageAlt: seed.imageAlt ?? null, options: (JSON.parse(q.options_json) as Option[]).map(({ id, text }) => ({ id, text })), issuedAt: q.issued_at!, deadline: q.deadline!, allowanceMs: q.allowance_ms } : null
    };
    if (e.state === 'frozen') out.review = (this.sql('SELECT q.*, a.option_id, a.earned FROM player_questions q LEFT JOIN answers a ON a.question_id = q.instance_id WHERE q.participant_id = ? ORDER BY q.slot').all(id) as (QuestionRow & { option_id: string | null; earned: number | null })[]).map(q => {
      const seed = bank.find(s => s.id === q.seed_id)!;
      return { number: q.slot + 1, text: seed.text, selected: (JSON.parse(q.options_json) as Option[]).find(o => o.id === q.option_id)?.text ?? null, correct: seed.options[seed.correct], explanation: seed.explanation, earned: q.earned ?? 0 };
    });
    return out;
  }
  history() { return (this.sql('SELECT * FROM events ORDER BY created_at DESC').all() as EventRow[]).map(e => ({ ...this.publicEvent(e), count: (this.sql('SELECT COUNT(*) AS n FROM participants WHERE event_id = ?').get(e.id) as { n: number }).n })); }
  exportCsv(id: string) {
    this.sync(id); const e = this.event(id); const ranks = this.ranked(id);
    const rows = this.sql('SELECT * FROM participants WHERE event_id = ? ORDER BY score DESC, adjusted_ms ASC, public_id ASC').all(id) as PlayerRow[];
    const header = ['Event','Status','Rank','Name','Registration','Score','Completed','Adjusted milliseconds','Eligible','Cutoff tie'];
    return '\uFEFF' + [header, ...rows.map(p => [e.name, e.state === 'frozen' ? 'FINAL' : 'PROVISIONAL', ranks.standings.find(s => s.publicId === p.public_id)?.rank ?? '', p.name, p.registration, p.score, p.progress, p.adjusted_ms, p.progress === 20 ? 'YES' : 'NO', ranks.cutoffTie ? 'ORGANIZER TIE-BREAK REQUIRED' : ''])].map(r => r.map(csvCell).join(',')).join('\r\n');
  }
  close() { this.db.close(); }
}
