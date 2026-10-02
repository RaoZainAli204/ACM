import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import type { AnswerInput, PlayerSnapshot, PublicEvent, PublicSnapshot, Standing } from '../../shared/types';
import './style.css';

const socket = io({ autoConnect: false, reconnection: true });
async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch('/api/' + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json(); if (!r.ok) throw Object.assign(new Error(data.error ?? 'Request failed.'), { status:r.status }); return data;
}
function Brand() { return <a className="brand" href="/join"><img src="/brand/flag.svg" alt=""/><span>404<span className="brand-sub">GRAND PRIX</span></span></a>; }
function Lights({ start, now }: { start:number; now:number }) { const count = Math.max(0,Math.ceil((start - now) / 1000)); return <div className="starting"><div className="lights" aria-label={`${count} seconds to start`}>{[5,4,3,2,1].map(n => <i key={n} className={count <= n ? 'lit' : ''}/>)}</div><p>ENGINES READY</p><h1>{count > 0 ? count : 'GO!'}</h1><p>Everyone starts together. Your race is your own.</p></div>; }
function Status({ connected }: { connected:boolean }) { return <span className={'connection ' + (connected ? 'online' : '')}><i/>{connected ? 'Connected' : 'Reconnecting'}</span>; }
function Table({ rows, limit=15 }: { rows:Standing[]; limit?:number }) {
  return <div className="standings-table"><div className="table-head"><span>POS</span><span>DRIVER</span><span>POINTS</span><span>LAPS</span><span>CHANGE</span></div>{rows.slice(0,limit).map(r => <div className={'standing ' + (r.rank !== null && r.rank <= 10 ? 'prize' : '')} key={r.publicId}><strong className="position">{r.rank ?? '—'}</strong><span className="driver">{r.name}{r.finished && <small className="finished">FINISHED</small>}</span><strong>{r.score.toLocaleString()}</strong><span className="progress-cell">{r.progress}<small> / 20</small></span><span className={r.movement > 0 ? 'up' : r.movement < 0 ? 'down' : 'muted'}>{r.movement > 0 ? '↑ ' + r.movement : r.movement < 0 ? '↓ ' + Math.abs(r.movement) : '—'}</span></div>)}{!rows.length && <p className="empty">The grid is waiting for its first driver.</p>}</div>;
}
function Tie({ state }: { state:PublicSnapshot }) { return state.cutoffTie ? <p className="notice">Exact tie across prize position 10. Organizer tie-break required before awarding gifts.</p> : null; }
function Winners({ state }: { state:PublicSnapshot }) { return <><div className="podium">{state.standings.slice(0,3).map(r => <div key={r.publicId} className={'podium-card p' + r.rank}><span>POSITION {r.rank}</span><h2>{r.name}</h2><strong>{r.score} <small>PTS</small></strong></div>)}</div><Tie state={state}/><h3>Prize positions · Top 10</h3><Table rows={state.standings.filter(r => r.rank! <= 10)} limit={200}/></>; }

function App() {
  const path = location.pathname; const admin = path === '/admin'; const display = path === '/display';
  const [publicState,setPublic] = useState<PublicSnapshot | null>(null); const [player,setPlayer] = useState<PlayerSnapshot | null>(null);
  const [connected,setConnected] = useState(false); const [error,setError] = useState(''); const [tick,setTick] = useState(0);
  const anchor = useRef({ server:Date.now(), local:performance.now() }); const newest = useRef(0);
  const [pending,setPending] = useState<AnswerInput | null>(() => { try { return JSON.parse(localStorage.getItem('gp-pending') ?? 'null'); } catch { return null; } });
  const pendingRef = useRef(pending); const sending = useRef(false); const currentPlayer = useRef<PlayerSnapshot | null>(null);
  function time(server:number) { if (server >= newest.current) { newest.current = server; anchor.current = { server, local:performance.now() }; } }
  function accept(s:PlayerSnapshot) {
    if (currentPlayer.current && s.serverNow < currentPlayer.current.serverNow) return;
    time(s.serverNow); currentPlayer.current = s; setPlayer(s);
    if (pendingRef.current && (s.question?.id !== pendingRef.current.questionId || s.event.state === 'frozen')) { pendingRef.current = null; setPending(null); localStorage.removeItem('gp-pending'); }
  }
  async function refresh() {
    const tasks: Promise<unknown>[] = [api<PublicSnapshot>('public').then(s => { time(s.serverNow); setPublic(s); })];
    if (!display && !admin) tasks.push(api<PlayerSnapshot>('player').then(accept).catch(e => { if (e.status !== 401) throw e; }));
    const results = await Promise.allSettled(tasks); const failed = results.find(r => r.status === 'rejected'); if (failed?.status === 'rejected') setError(failed.reason.message);
  }
  useEffect(() => {
    for (const file of ['shapes','squares','arrow','equations','rectangles','routes']) { const image = new Image(); image.src = '/visuals/' + file + '.svg'; }
    const onPublic = (s:PublicSnapshot) => { time(s.serverNow); setPublic(s); };
    const onConnect = () => { setConnected(true); setError(''); void refresh(); };
    const onDisconnect = () => setConnected(false);
    socket.on('standings',onPublic); socket.on('snapshot',accept); socket.on('connect',onConnect); socket.on('disconnect',onDisconnect); socket.on('connect_error',onDisconnect); socket.connect();
    void refresh(); const refreshTimer = setInterval(() => {
      if (!socket.connected || performance.now() - anchor.current.local > 5000) void refresh();
    }, 2500); const clockTimer = setInterval(() => setTick(t => t + 1),100);
    const visibility = () => { if (!document.hidden) void refresh(); }; const online = () => { socket.connect(); void refresh(); }; const offline = () => { setConnected(false); socket.disconnect(); };
    document.addEventListener('visibilitychange',visibility); window.addEventListener('online',online); window.addEventListener('offline',offline);
    return () => { clearInterval(refreshTimer); clearInterval(clockTimer); socket.off('standings',onPublic); socket.off('snapshot',accept); socket.off('connect',onConnect); socket.off('disconnect',onDisconnect); socket.off('connect_error',onDisconnect); socket.disconnect(); document.removeEventListener('visibilitychange',visibility); window.removeEventListener('online',online); window.removeEventListener('offline',offline); };
  },[]);
  async function send(input:AnswerInput) {
    if (sending.current) return; sending.current = true;
    try {
      let result:{snapshot:PlayerSnapshot};
      if (socket.connected) {
        try {
          const ack = await socket.timeout(2000).emitWithAck('answer',input) as {snapshot?:PlayerSnapshot;error?:string;status?:number};
          if (ack.error) throw Object.assign(new Error(ack.error),{status:ack.status});
          if (!ack.snapshot) throw new Error('Answer acknowledgment missing.');
          result = {snapshot:ack.snapshot};
        } catch(error) {
          const status = (error as Error & {status?:number}).status;
          if (status && status !== 401) throw error;
          result = await api<{snapshot:PlayerSnapshot}>('answer',input);
        }
      } else result = await api<{snapshot:PlayerSnapshot}>('answer',input);
      accept(result.snapshot); setError('');
      if (pendingRef.current?.requestId === input.requestId) { pendingRef.current = null; setPending(null); localStorage.removeItem('gp-pending'); }
    } catch (e) {
      const err = e as Error & { status?:number }; setError(err.status ? err.message : 'Connection interrupted. Retrying your saved answer…');
      if (err.status && err.status !== 429 && err.status < 500) { pendingRef.current = null; setPending(null); localStorage.removeItem('gp-pending'); void refresh(); }
    } finally { sending.current = false; }
  }
  useEffect(() => { if (!pending) return; void send(pending); const retry = setInterval(() => { if (pendingRef.current) void send(pendingRef.current); },1000); return () => clearInterval(retry); },[pending]);
  function answer(optionId:string) {
    if (!player?.question || pendingRef.current) return;
    const input = { questionId:player.question.id, optionId, requestId:crypto.randomUUID() };
    pendingRef.current = input; localStorage.setItem('gp-pending',JSON.stringify(input)); setPending(input);
  }
  const now = anchor.current.server + performance.now() - anchor.current.local; void tick;
  return <div className={display ? 'app projector' : 'app'}><header><Brand/><div className="header-right"><span className="event-tag">ACM ORIENTATION <b>2026</b></span><Status connected={connected}/></div></header>{error && <div className="error" role="alert">{error}</div>}{admin ? <Admin state={publicState} refresh={refresh} now={now}/> : display ? <Display state={publicState} now={now}/> : <Player state={publicState} player={player} now={now} pending={pending} onAnswer={answer} onJoin={accept} onError={setError}/>}<footer><span>ACM · THE START OF SOMETHING GREAT</span><span>02 OCT 2026 <span className="footer-sep">/</span> 404 GRAND PRIX</span></footer></div>;
}

function Player({ state, player, now, pending, onAnswer, onJoin, onError }: { state:PublicSnapshot|null; player:PlayerSnapshot|null; now:number; pending:AnswerInput|null; onAnswer:(id:string)=>void; onJoin:(s:PlayerSnapshot)=>void; onError:(s:string)=>void }) {
  const [form,setForm] = useState(false); const [busy,setBusy] = useState(false);
  if (!state) return <main className="loading">Connecting to the starting grid…</main>;
  if (!player || (player.event.id !== state.event.id && ['closed','lobby'].includes(state.event.state))) return <main className="landing"><div className="hero-copy"><p className="eyebrow"><i/> FIRST SEMESTER. FULL THROTTLE.</p><h1>YOUR FIRST<br/>RACE STARTS<br/><em>RIGHT HERE.</em></h1><p className="lead">A little logic. A little speed. A whole lot of bragging rights. Welcome to the 404 Grand Prix.</p><div className="hero-stats"><div><strong>20</strong><span>CHALLENGES</span></div><div><strong>10</strong><span>PRIZE POSITIONS</span></div><div><strong>01</strong><span>STARTING GRID</span></div></div>{form ? <form className="join-form" onSubmit={async e => { e.preventDefault(); if (busy) return; setBusy(true); const data = new FormData(e.currentTarget); try { onJoin(await api<PlayerSnapshot>('join',{ name:data.get('name'),registration:data.get('registration') })); onError(''); socket.disconnect().connect(); } catch(e) { onError((e as Error).message); } finally { setBusy(false); } }}><label>Your name<input name="name" autoComplete="name" minLength={2} maxLength={60} placeholder="Name on the leaderboard" required/></label><label>Registration number<input name="registration" autoComplete="off" minLength={3} maxLength={40} placeholder="Your student registration" required/></label><button className="primary" disabled={busy || !['lobby','countdown'].includes(state.event.state)}>{busy ? 'Joining…' : 'Join the starting grid →'}</button><p className="muted">Your registration is private. Winners must show their student ID.</p></form> : <><button className="primary start" onClick={() => setForm(true)}>Start Game <span>↗</span></button><p className="small-note">{state.event.state === 'lobby' ? `${state.count} drivers on the grid · Registration open` : state.event.state === 'closed' ? 'Registration opens when the organizer is ready.' : 'Registration is closed for this race.'}</p></>}</div><div className="hero-art"><div className="art-top"><span>404 / GRAND PRIX</span><span>EST. 2026</span></div><div className="track"><div className="track-line"/><img className="racer" src="/brand/racer.svg" alt="Top view of a lime green racing car on a circuit"/><span className="track-label">THE NEXT GENERATION<br/>IS ON THE GRID.</span><span className="art-number">404</span></div><div className="art-bottom"><span>LIGHTS OUT. MINDS ON.</span><span>↗</span></div></div><Rules/></main>;
  const event = player.event;
  if (event.state === 'countdown') return <main><Lights start={event.startAt!} now={now}/><Rules/></main>;
  if (event.state === 'closed' || event.state === 'lobby') return <main className="lobby"><p className="eyebrow">YOU’RE ON THE GRID</p><h1>Ready, <em>{player.player.name}?</em></h1><p className="lead">Stay on this screen. The organizer will start everyone together.</p><div className="lobby-count"><strong>{state.count}</strong><span>drivers warming up</span></div><div className="lights idle">{[1,2,3,4,5].map(n => <i key={n}/>)}</div><Rules/></main>;
  if (event.state === 'frozen' || player.player.finished) return <main className="results"><p className="eyebrow">{event.state === 'frozen' ? 'THE CHEQUERED FLAG' : 'RACE COMPLETE'}</p><h1>{player.player.finished ? 'Across the finish line.' : 'The race was ended early.'}</h1><div className="result-stats"><div><strong>{player.player.score}</strong><span>POINTS / 2000</span></div><div><strong>{state.standings.find(s => s.publicId === player.player.publicId)?.rank ?? player.player.rank ?? '—'}</strong><span>{event.state === 'frozen' ? 'FINAL RANK' : 'PROVISIONAL RANK'}</span></div><div><strong>{player.player.progress}/20</strong><span>{player.player.finished ? 'FINISHED · PRIZE ELIGIBLE' : 'UNFINISHED · NOT PRIZE ELIGIBLE'}</span></div></div><p className="muted">{event.state === 'frozen' ? 'Results are final. Winners: bring your student ID for registration verification.' : 'Standings remain provisional until the organizer freezes the race.'}</p><Tie state={state}/><Table rows={state.standings}/>{player.review && <details className="review"><summary>See answers & explanations</summary>{player.review.map(r => <article key={r.number}><h3>{r.number}. {r.text}</h3><p>Your answer: {r.selected ?? 'No answer'} · {r.earned} points</p><p><strong>{r.correct}</strong> — {r.explanation}</p></article>)}</details>}</main>;
  const q = player.question;
  if (!q) return <main className="loading">Waiting for the race snapshot…</main>;
  const seconds = Math.max(0,(q.deadline - now)/1000); const rank = state.standings.find(s => s.publicId === player.player.publicId)?.rank ?? player.player.rank;
  return <main className="question-page"><div className="race-meta"><span>DRIVER <b>{player.player.name}</b></span><span>SCORE <b>{player.player.score}</b></span><span>RANK <b>{rank ?? '—'}</b></span></div><div className="question-top"><span className="eyebrow">CHALLENGE {String(q.number).padStart(2,'0')} <span className="muted">/ 20</span></span><span className={'timer ' + (seconds < 5 ? 'urgent' : '')}>{Math.ceil(seconds)}<small> SEC</small></span></div><div className="timer-track"><i style={{ width: Math.min(100,seconds * 100000 / q.allowanceMs) + '%' }}/></div><section className="question-card" key={q.id}><h1>{q.text}</h1>{q.image && <img className="puzzle" src={q.image} alt={q.imageAlt ?? 'Visual puzzle'}/>}<div className="options">{q.options.map((o,i) => <button className={'option ' + (pending?.optionId === o.id ? 'selected' : '')} key={o.id} disabled={!!pending || seconds <= 0} onClick={() => onAnswer(o.id)}><span>{'ABCD'[i]}</span>{o.text}<span className="option-arrow">↗</span></button>)}</div><p className="question-note" aria-live="polite">{pending ? 'Answer locked. Saving…' : seconds <= 0 ? 'Time’s up. Loading the next challenge…' : 'One answer. Make it count. Your next challenge starts automatically.'}</p></section><div className="laps">{Array.from({length:20},(_,i) => <i key={i} className={i < player.player.progress ? 'done' : i === player.player.progress ? 'current' : ''}/>)}</div></main>;
}
function Rules() { return <section className="rules"><div><span>01 / THE POINTS</span><h3>Right answer. +100.</h3><p>Wrong or timed out: zero. Maximum 2,000 points.</p></div><div><span>02 / THE CLOCK</span><h3>Quick thinking wins ties.</h3><p>Correct answers use your answer time. Wrong answers use the full allowance.</p></div><div><span>03 / THE FINISH</span><h3>Finish all 20.</h3><p>Questions allow 15, 20, 25, then 30 seconds. Top 10 compete for prizes.</p></div></section>; }
function Display({ state, now }: { state:PublicSnapshot|null; now:number }) {
  if (!state) return <main className="loading">Loading the circuit…</main>;
  if (state.event.state === 'countdown') return <main><Lights start={state.event.startAt!} now={now}/></main>;
  if (['lobby','closed'].includes(state.event.state)) return <main className="display-lobby"><div><p className="eyebrow">SCAN IN. STRAP IN.</p><h1>YOUR PLACE<br/>ON THE <em>GRID.</em></h1><p className="lead">20 challenges. Top 10 prizes.<br/>One race to remember.</p><div className="display-count"><strong>{state.count}</strong><span>DRIVERS READY</span></div><p>{state.event.state === 'lobby' ? 'Registration is open. Join on your phone.' : 'Registration will open shortly.'}</p></div><div className="qr-card"><img src="/api/qr" alt="QR code to join 404 Grand Prix"/><strong>SCAN TO JOIN THE RACE</strong><p>{state.joinUrl}</p></div></main>;
  const final = state.event.state === 'frozen';
  return <main className="display-race"><div className="display-title"><div><p className="eyebrow">{final ? 'FINAL CLASSIFICATION' : 'LIVE TIMING · PROVISIONAL'}</p><h1>{final ? 'THE WINNERS’ CIRCLE.' : 'THE RACE IS ON.'}</h1></div><div className="display-count"><strong>{state.count}</strong><span>DRIVERS</span></div></div>{final ? <Winners state={state}/> : <><Tie state={state}/><p className="muted">Highlighted ranks compete for top 10 prizes · Finish all 20 to qualify</p><Table rows={state.standings}/></>}{final && state.unfinished.length > 0 && <details><summary>{state.unfinished.length} unfinished drivers · Not prize eligible</summary><Table rows={state.unfinished} limit={200}/></details>}<p className="small-note">{final ? 'Verify student IDs. Resolve flagged cutoff ties before awarding prizes.' : `Global finish in ${Math.max(0,Math.ceil((state.event.endAt! - now)/1000))} seconds · Rankings update every second`}</p></main>;
}
function Admin({ state, refresh, now }: { state:PublicSnapshot|null; refresh:()=>Promise<void>; now:number }) {
  const [logged,setLogged] = useState(false); const [error,setError] = useState(''); const [busy,setBusy] = useState(false); const [events,setEvents] = useState<(PublicEvent & { count:number })[]>([]);
  async function history() { const h = await api<{events:(PublicEvent & {count:number})[]}>('admin/events'); setEvents(h.events); setLogged(true); }
  useEffect(() => { void history().catch(() => {}); },[]);
  async function action(name:string) { setBusy(true); try { await api('admin/' + name,{}); setError(''); await refresh(); await history(); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }
  if (!logged) return <main className="admin-login"><p className="eyebrow">RACE CONTROL</p><h1>Organizer access.</h1><form onSubmit={async e => { e.preventDefault(); setBusy(true); try { await api('admin/login',{password:new FormData(e.currentTarget).get('password')}); await history(); setError(''); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }}><label>Organizer password<input name="password" type="password" autoComplete="current-password" required/></label><button className="primary" disabled={busy}>Enter race control →</button></form>{error && <p className="error" role="alert">{error}</p>}</main>;
  if (!state) return <main className="loading">Loading race control…</main>;
  return <main className="admin"><div className="display-title"><div><p className="eyebrow">RACE CONTROL</p><h1>Make it a great race.</h1></div><button onClick={async () => { await api('admin/logout',{}); setLogged(false); }}>Log out</button></div>{error && <p className="error" role="alert">{error}</p>}<div className="admin-stats"><div><span>PARTICIPANTS</span><strong>{state.count}</strong></div><div><span>EVENT STATUS</span><strong className="state-text">{state.event.state}</strong></div><div><span>FINISHED</span><strong>{state.standings.filter(r => r.finished).length}</strong></div></div><div className="admin-controls"><button className="primary" disabled={busy || state.event.state !== 'closed'} onClick={() => void action('open')}>Open registration</button><button className="primary" disabled={busy || state.event.state !== 'lobby'} onClick={() => { if (confirm(`Start the five-second countdown for ${state.count} participants?`)) void action('start'); }}>Start race →</button><button className="danger" disabled={busy || state.event.state === 'frozen' || state.event.state === 'closed'} onClick={() => { if (confirm('End the race and freeze results now? Unfinished players will not be prize eligible.')) void action('freeze'); }}>End & freeze results</button></div>{state.event.state === 'countdown' && <Lights start={state.event.startAt!} now={now}/>}<div className="admin-links"><a className="button" href="/display" target="_blank" rel="noreferrer">Open projector ↗</a><a className="button" href="/api/admin/qr.png" download>Download QR PNG ↓</a><a className="button" href="/api/admin/export.csv" download>Export CSV ↓</a></div><p className="muted">QR destination: {state.joinUrl}</p><Tie state={state}/>{state.event.state === 'frozen' ? <Winners state={state}/> : <Table rows={state.standings}/>}<section className="event-history"><h2>Events & saved results</h2><form onSubmit={async e => { e.preventDefault(); const name = new FormData(e.currentTarget).get('name'); if (!confirm('Create a fresh event? Earlier participants and results will remain saved.')) return; setBusy(true); try { await api('admin/events',{name,confirm:true}); await refresh(); await history(); setError(''); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }}><label>New event name<input name="name" maxLength={100} defaultValue="404 Grand Prix · Orientation 2026" required/></label><button disabled={busy || !['closed','frozen'].includes(state.event.state)}>Create fresh event</button></form>{events.map(e => <div className="history-row" key={e.id}><span>{e.name} {e.test && <small>TEST</small>}</span><span>{e.state} · {e.count} drivers</span><a href={'/api/admin/export.csv?eventId=' + e.id}>CSV ↓</a></div>)}</section></main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
