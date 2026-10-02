import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { bank } from '../server/seed.js';
import type { PlayerSnapshot } from '../shared/types.js';

mkdirSync('artifacts',{recursive:true});
const base = 'http://localhost:3123'; const password = randomBytes(24).toString('hex'); const secret = randomBytes(32).toString('hex');
const dbPath = `artifacts/rehearsal-${Date.now()}.sqlite`; let offset = 0;
const start = async () => { const service = createApp({dbPath,baseUrl:base,password,secret,production:false,now:() => Date.now()+offset}); await new Promise<void>(r => service.http.listen(3123,'0.0.0.0',r)); return service; };
let service = await start();
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({headless:true,...(existsSync(edge) ? {executablePath:edge} : {})});
const issues:string[] = []; const checks:string[] = [];
try {
  const aContext = await browser.newContext({viewport:{width:360,height:780}}); const bContext = await browser.newContext({viewport:{width:390,height:844}}); const adminContext = await browser.newContext({viewport:{width:1440,height:1000}});
  const a = await aContext.newPage(); const b = await bContext.newPage(); const admin = await adminContext.newPage(); const display = await adminContext.newPage();
  for (const page of [a,b,admin,display]) page.on('pageerror',e => issues.push(e.message));
  await a.goto(base + '/join'); await a.getByRole('button',{name:'Start Game'}).waitFor();
  assert.equal(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth),false); await a.screenshot({path:'artifacts/phone-landing.png',fullPage:true}); checks.push('360 px landing has no horizontal overflow');
  await admin.goto(base + '/admin'); await admin.getByLabel('Organizer password').fill(password); await admin.getByRole('button',{name:'Enter race control'}).click(); await admin.getByRole('button',{name:'Open registration',exact:true}).click();
  async function join(page:Page,name:string,reg:string) { await page.goto(base + '/join'); await page.getByRole('button',{name:'Start Game'}).click(); await page.getByLabel('Your name').fill(name); await page.getByLabel('Registration number').fill(reg); await page.getByRole('button',{name:'Join the starting grid'}).click(); await page.getByText('YOU’RE ON THE GRID',{exact:true}).waitFor(); }
  await join(a,'=SUM(A1)','BROWSER-001'); await join(b,'Driver Two','BROWSER-002');
  await display.goto(base + '/display'); await display.getByAltText('QR code to join 404 Grand Prix').waitFor(); await display.screenshot({path:'artifacts/projector-lobby.png',fullPage:true}); checks.push('two independent browsers join; projector shows QR');
  admin.on('dialog',d => d.accept()); await admin.getByRole('button',{name:'Start race',exact:false}).click(); await a.getByText('ENGINES READY',{exact:true}).waitFor();
  await a.locator('.option').first().waitFor({timeout:10000}); await b.locator('.option').first().waitFor({timeout:10000}); checks.push('shared five-light countdown starts gameplay');
  async function snapshot(page:Page) { return await (await page.request.get(base + '/api/player')).json() as PlayerSnapshot; }
  function correctText(s:PlayerSnapshot) { const row = service.engine.sql('SELECT seed_id FROM player_questions WHERE instance_id = ?').get(s.question!.id) as {seed_id:number}; const q = bank.find(q => q.id === row.seed_id)!; return q.options[q.correct]; }
  const first = await snapshot(a); const right = correctText(first); const choice = first.question!.options.findIndex(o => o.text === right);
  let firstHttpAnswers = 0;
  a.on('request',r=>{if(r.url().endsWith('/api/answer'))firstHttpAnswers++;});
  await a.evaluate(index => { const button = document.querySelectorAll<HTMLButtonElement>('.option')[index]; button.click(); button.click(); },choice);
  await a.getByText('CHALLENGE 02',{exact:false}).waitFor(); const answered = await snapshot(a); assert.equal(answered.player.score,100); assert.equal(answered.player.progress,1); checks.push('double tap scores once');
  assert.equal(firstHttpAnswers,0); checks.push('connected player answers over Socket.IO');
  const bToken = (await bContext.cookies()).find(c=>c.name==='race_player')!.value;
  const bId = service.engine.playerForToken(bToken)!.id;
  const bSocket = [...service.io.sockets.sockets.values()].find(s=>s.data.participantId===bId)!;
  const answerHandler = bSocket.listeners('answer')[0]; let droppedAck = false;
  bSocket.removeListener('answer',answerHandler);
  bSocket.on('answer',(input:unknown,ack:(reply:unknown)=>void)=>{
    void answerHandler(input,(reply:unknown)=>{if(!droppedAck)droppedAck=true;else ack(reply);});
  });
  const fallback = b.waitForResponse(r=>r.url().endsWith('/api/answer') && r.request().method()==='POST');
  const second = await snapshot(b); const wrong = second.question!.options.findIndex(o => o.text !== correctText(second)); await b.locator('.option').nth(wrong).click(); await b.getByText('CHALLENGE 02',{exact:false}).waitFor();
  assert.equal((await fallback).status(),200); const retried = await snapshot(b); assert.equal(retried.player.score,0); assert.equal(retried.player.progress,1); assert.ok(droppedAck);
  checks.push('lost Socket.IO acknowledgment falls back to HTTP without duplicate scoring'); checks.push('wrong answer records zero');
  const beforeReload = await snapshot(a); await a.reload(); await a.locator('.option').first().waitFor(); assert.deepEqual((await snapshot(a)).question,beforeReload.question); checks.push('reload preserves cookie, order, options and deadline');
  await a.screenshot({path:'artifacts/phone-question.png',fullPage:true}); assert.equal(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
  await aContext.setOffline(true); await a.getByText('Reconnecting',{exact:true}).waitFor(); offset += 31000; service.engine.tick(); await aContext.setOffline(false); await a.getByText('CHALLENGE 04',{exact:false}).waitFor({timeout:12000}); assert.equal((await snapshot(a)).player.progress,3); checks.push('network loss consumes expired allowances and resumes authoritatively');
  const beforeRestart = await snapshot(a); await service.close(); offset += 16000; service = await start(); await a.reload(); await a.locator('.option').first().waitFor(); const restored = await snapshot(a); assert.equal(restored.player.score,100); assert.equal(restored.player.progress,beforeRestart.player.progress + 1); checks.push('backend restart restores persisted scores and catches up deadlines');
  for (let i = restored.player.progress; i < 20; i++) { const s = await snapshot(a); const text = correctText(s); const index = s.question!.options.findIndex(o => o.text === text); await a.locator('.option').nth(index).click(); if (i < 19) await a.getByText('CHALLENGE ' + String(i+2).padStart(2,'0'),{exact:false}).waitFor(); }
  await a.getByText('Across the finish line.',{exact:true}).waitFor(); const finished = await snapshot(a); assert.equal(finished.player.progress,20); assert.equal(finished.player.score,1700); checks.push('all 20 finish automatically with verified score');
  await admin.getByRole('button',{name:'End & freeze results',exact:true}).click(); await a.getByText('See answers & explanations',{exact:true}).waitFor(); await display.getByText('FINAL CLASSIFICATION',{exact:true}).waitFor(); const final = service.engine.publicSnapshot(); assert.equal(final.standings.length,1); assert.equal(final.unfinished.length,1); checks.push('freeze distinguishes finished prize eligibility and unfinished players');
  const csv = await (await admin.request.get(base + '/api/admin/export.csv')).text(); assert.ok(csv.includes('"\'=SUM(A1)"')); assert.ok(csv.includes('BROWSER-001')); checks.push('authenticated CSV export neutralizes formula name');
  const png = await admin.request.get(base + '/api/admin/qr.png'); assert.equal(png.status(),200); assert.equal(png.headers()['content-type'],'image/png'); writeFileSync('artifacts/rehearsal-qr.png',await png.body());
  await display.screenshot({path:'artifacts/projector-final.png',fullPage:true});
  const js = await a.evaluate(() => Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]')).map(s => s.src));
  for (const url of js) { const source = await (await a.request.get(url)).text(); assert.ok(!source.includes('Iron oxide on the surface')); assert.ok(!source.includes('server/seed')); assert.ok(!source.includes('session_hash')); }
  checks.push('client bundle contains no private seed, explanation or session data');
  assert.deepEqual(issues,[]); const report = {checks,issues,score:finished.player.score,phoneWidths:[360,390],backendRestart:true,publicHostTested:false}; writeFileSync('artifacts/rehearsal-report.json',JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
} finally { await browser.close(); await service.close(); }
