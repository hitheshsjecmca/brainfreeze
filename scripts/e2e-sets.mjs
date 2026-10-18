// End-to-end (LOCAL DEMO MODE): quiz sets, join codes, per-team timers and ranking.
// Organizer creates a UG set, sets a 10-minute timer, publishes; two teams join with
// the code + section + their registered team (no PIN; one device per team), read the
// instructions, press Start, autosave and change answers, refresh, submit early (with a
// confirmation that can be cancelled) or keep going; pause/resume from the fallback
// section; results with times, attempt detail; end set; a 6-second set submits a team
// automatically at its deadline; one-set-per-section rule; registration desk lock.
//   npm run build:demo && npm run preview:demo     (serves http://localhost:4173)
//   node scripts/e2e-sets.mjs [baseUrl] [screenshotDir]
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:4173';
const SHOTS = process.argv[3] || 'e2e-screenshots';
mkdirSync(SHOTS, { recursive: true });
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => existsSync(p));

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
const browser = await chromium.launch({ executablePath: exe, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const errors = [];
const watch = (p, name) => {
  p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
};
const org = await ctx.newPage(); watch(org, 'organizer');
const nav = (name) => org.locator('aside nav').getByRole('link', { name, exact: true }).click();
// Round 1 pages live under Rounds → Round 1 (tabs).
const ROUND1_TABS = { 'Quiz Sets': 'Quiz sets', 'Set setup & Join': 'Set setup & join', 'Live Host': 'Live host', 'Question Bank': 'Question bank', Leaderboard: 'Leaderboard' };
const r1 = async (tab) => {
  if (!(await org.locator('.round-tabs').count())) {
    await nav('Rounds');
    await org.getByRole('link', { name: 'Open Round 1' }).click();
  }
  await org.locator('.round-tabs').getByRole('link', { name: ROUND1_TABS[tab], exact: true }).click();
};
const confirmDialog = async (label, { typed, reason } = {}) => {
  const dlg = org.getByRole('alertdialog');
  await dlg.waitFor();
  if (reason) await dlg.locator('textarea, input').first().fill(reason);
  if (typed) await dlg.locator('input').last().fill(typed);
  await dlg.getByRole('button', { name: label }).click();
  await dlg.waitFor({ state: 'detached' });
};
const stepTitle = () => org.locator('.wz-step-title').innerText();
const next = () => org.locator('.wizard-footer').getByRole('button', { name: 'Next' }).click();
// New quiz set → step 1 (title + section) → Next creates the draft and opens step 2.
const newSet = async (name) => {
  await r1('Quiz Sets');
  await org.getByRole('link', { name: 'New quiz set' }).click();
  await org.getByLabel('Quiz title').fill(name);
  await org.getByRole('radio', { name: /^UG/ }).click();
  await next();
  await org.getByRole('heading', { name }).waitFor();
};
const clockSeconds = (t) => { const [m, s] = t.trim().split(':').map(Number); return m * 60 + s; };

// --- organizer: create a UG set, timer 10 min, review, publish
await org.goto(`${BASE}/login`);
await org.getByRole('button', { name: 'Enter demo console' }).click();
await org.locator('.page').waitFor();
await r1('Quiz Sets');
await org.getByRole('link', { name: 'New quiz set' }).click();
await org.getByRole('heading', { name: 'New quiz set' }).waitFor();
check(await org.locator('.wizard-steps li').count() === 4 && /Step 1 · Basic details/.test(await stepTitle()), 'wizard shows four steps, starting at basic details');
await next();
check(await org.getByText('Enter a quiz title.').count() > 0 && /Step 1/.test(await stepTitle()), 'Next refused without a title');
await org.getByLabel('Quiz title').fill('UG Rehearsal Set A');
await org.getByRole('radio', { name: /^UG/ }).click();
await next();
await org.getByRole('heading', { name: 'UG Rehearsal Set A' }).waitFor();
await org.locator('.wz-qlist').waitFor();
check(/Step 2 · Questions/.test(await stepTitle()), 'draft created; wizard continues at the questions step');
check(await org.locator('.wizard-steps li').filter({ hasText: 'Basic details' }).locator('.wz-num svg').count() === 1, 'progress marks step 1 done');
// a new draft starts with the whole 60-question bank; any number of questions is allowed (no minimum or maximum)
for (let i = 0; i < 31; i++) await org.getByRole('button', { name: 'Remove question 1', exact: true }).click();
const meter = await org.locator('.count-meter').first().innerText();
check(/29\s*questions in this set/.test(meter) && !/30[–-]60|minimum|maximum/i.test(meter), 'current count shown without a minimum or maximum');
check(!(await org.locator('.wizard-steps').getByRole('button', { name: /Review & publish/ }).isDisabled()), 'review & publish step reachable with 29 questions');
await org.getByRole('button', { name: 'Preview question 1', exact: true }).click();
check(await org.getByRole('dialog').locator('.option-key').count() === 1, 'question preview highlights the answer for the organizer');
await org.getByRole('dialog').getByRole('button', { name: 'Close dialog' }).click();
await org.getByRole('button', { name: /Choose from bank/ }).click();
await org.getByRole('dialog').locator('.wz-bank input[type=checkbox]:not(:checked)').first().check();
await org.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
check(/30\s*questions in this set/.test(await org.locator('.count-meter').first().innerText()), '30 questions counted');
await next();
await org.getByLabel(/Time limit per team/).waitFor();
check(/Step 3 · Rules/.test(await stepTitle()), 'rules step');
check(await org.getByLabel(/Time limit per team/).inputValue() === '30' && await org.getByLabel('Marks for an incorrect answer').inputValue() === '-0.25', 'default rules: 30 min, −0.25');
await org.getByLabel(/Time limit per team/).fill('0');
check(await org.getByText('The time limit must be a positive number of minutes.').count() >= 1, 'invalid time limit explained');
await next();
check(/Step 3/.test(await stepTitle()), 'Next refused with an invalid time limit');
await org.getByLabel(/Time limit per team/).fill('10');
check(await org.getByText(/shorter elapsed completion time ranks higher/).count() > 0, 'ranking & timeout policy visible before publishing');
await next();
await org.getByText(/Ready to publish/).waitFor();
check(/10 minutes per team/.test(await org.locator('.wz-review').innerText()), 'review summarizes the saved rules');
await org.screenshot({ path: join(SHOTS, 's00-wizard-review.png') });
// the draft is saved on the set: a reload resumes at the review step
await org.reload();
await org.getByText(/Ready to publish/).waitFor();
check(/Step 4/.test(await stepTitle()) && /Selected\s+30\b/.test(await org.locator('.wz-review').innerText()), 'draft resumes after a reload with its questions and rules');
check(await org.locator('.join-code-big').count() === 0, 'no join code before publishing');
await org.getByRole('button', { name: 'Publish set' }).click();
await confirmDialog('Publish & generate code');
const code = (await org.locator('.join-code-big').textContent()).replace(/\s/g, '');
check(await org.getByRole('button', { name: 'Copy code' }).count() === 1, 'join code shown with a copy action');
await org.getByRole('button', { name: /Manage set/ }).click();
check(/^\d{6}$/.test(code), `published with a six-digit code (${code})`);
check(await org.getByText('Frozen questions (30)').count() === 1, 'published set shows its frozen 30 questions');
check(await org.getByLabel(/Time limit per team/).isDisabled(), 'timer frozen after publishing');
check(await org.getByText(/Show PINs|team PIN/i).count() === 0, 'no PINs on the set page');
check(await org.getByRole('button', { name: /UG team join slips/ }).count() === 1, 'join slips (code + registered team, no PIN) can be downloaded');
await org.screenshot({ path: join(SHOTS, 's01-set-published.png') });

// --- teams join with code → section → registered team; instructions before Start
const openJoin = async (p, c = code) => {
  await p.goto(`${BASE}/join`);
  await p.getByLabel('Six-digit join code').fill(c);
  await p.getByRole('button', { name: /^Join/ }).click();
};
const pickSection = async (p, label) => {
  await p.getByRole('radio', { name: label }).click();
};
const joinTeam = async (p, n) => {
  await openJoin(p);
  await pickSection(p, /^UG/);
  await p.getByLabel('Your registered team').selectOption(String(n));
  await p.getByRole('button', { name: 'Join quiz' }).click();
};
const a = await ctx.newPage(); watch(a, 'teamA');
await a.setViewportSize({ width: 390, height: 844 });
await openJoin(a);
check(await a.getByText(/PIN/).count() === 0, 'join page asks for no PIN');
await pickSection(a, /^PG/);
await a.getByText('This quiz is for UG teams').waitFor();
check(true, 'choosing the wrong section is refused by the server');
await pickSection(a, /^UG/);
const options = await a.getByLabel('Your registered team').locator('option').allTextContents();
check(options.some((o) => /^Team 1 · /.test(o)) && options.every((o) => !/PG/.test(o)), `dropdown lists the registered UG teams (${options.length - 1})`);
await a.getByLabel('Your registered team').selectOption('1');
await a.getByRole('button', { name: 'Join quiz' }).click();
await a.getByText('Waiting for the organizer to open the quiz').waitFor();
const aText = await a.locator('body').innerText();
check(/30 questions/.test(aText) && /10 minutes/.test(aText), 'instructions show question count and the configured duration');
check(/server/.test(aText) && /refresh/i.test(aText), 'instructions explain the server-kept deadline');
const overflow = await a.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check(overflow <= 1, `instructions fit a phone screen (overflow ${overflow}px)`);
await a.screenshot({ path: join(SHOTS, 's02-instructions-phone.png') });
// a second device cannot claim a team that already joined
const x = await ctx.newPage(); watch(x, 'second-device');
await openJoin(x);
await pickSection(x, /^UG/);
const team1Option = x.getByLabel('Your registered team').locator('option', { hasText: /^Team 1 · / });
const team1State = await team1Option.evaluate((o) => ({ text: o.textContent, disabled: o.disabled }));
check(/already joined/.test(team1State.text) && team1State.disabled, `a team that joined is marked and cannot be chosen on another device (${JSON.stringify(team1State)})`);
await x.close();
const b = await ctx.newPage(); watch(b, 'teamB');
await joinTeam(b, 2);
await b.getByText('Waiting for the organizer to open the quiz').waitFor();

// --- organizer goes live (no clock or timer controls on the main Live Host page); teams press Start
await r1('Live Host');
check(await org.locator('.control-bar .timer').count() === 0 && await org.getByRole('button', { name: /Reset set clock/ }).count() === 0, 'Live Host has no set clock or reset-timer control');
check(!(await org.locator('details.live-fallback').evaluate((d) => d.open)), 'pause and paper entry are folded away');
await org.getByRole('button', { name: 'Go live' }).click();
await confirmDialog('Go live');
await a.getByRole('button', { name: 'Start the quiz' }).click({ timeout: 10000 });
await a.locator('.play-q-text').waitFor();
check(true, 'team A started and sees its first question');
const t1 = clockSeconds(await a.locator('.play-timebar strong').textContent());
check(t1 > 590 && t1 <= 600, `team countdown on the quiz page starts from 10:00 (${t1}s)`);
check(/left of 10 min/.test(await a.locator('.play-timebar').innerText()), 'the quiz page shows the configured duration');
check((await a.locator('.option-key').count()) === 0 && !(await a.locator('body').innerText()).includes('SECRET'), 'no answer key on the team device');
await a.locator('.play-options button').first().click();
await a.getByText('Answer A saved').waitFor();
check(true, 'tapping an option saves it immediately');
await a.locator('.play-options button').nth(2).click();
await a.getByText('Answer C saved').waitFor();
check(true, 'the answer can be changed before submitting');
await a.waitForTimeout(2200);
await a.reload();
await a.locator('.play-q-text').waitFor();
await a.getByText('Answer C saved').waitFor();
const t2 = clockSeconds(await a.locator('.play-timebar strong').textContent());
check(t2 < t1 && t2 > t1 - 15, `refresh keeps the server deadline (${t1}s → ${t2}s, not restarted)`);
check((await a.locator('.play-palette .done').count()) === 1, 'saved answer kept after refresh (1 answered)');

await b.getByRole('button', { name: 'Start the quiz' }).click({ timeout: 10000 });
await b.locator('.play-q-text').waitFor();
await b.locator('.play-options button').nth(1).click();
await b.getByText('Answer B saved').waitFor().catch(async (e) => { console.log(await b.locator('body').innerText()); await b.screenshot({ path: join(SHOTS, 'debug-b.png') }); throw e; });
await b.waitForTimeout(2200); // next poll marks the question answered
await b.getByRole('button', { name: 'Submit Quiz' }).click();
const dlg = b.getByRole('dialog');
await dlg.waitFor();
const dlgText = await dlg.innerText();
check(/1\s*answered/i.test(dlgText) && /29\s*unanswered/i.test(dlgText), 'Submit Quiz confirmation shows answered and unanswered counts');
await b.screenshot({ path: join(SHOTS, 's02b-submit-confirm.png') });
await dlg.getByRole('button', { name: /Cancel/ }).click();
await dlg.waitFor({ state: 'detached' });
check(await b.locator('.play-q-text').count() === 1 && await b.getByText('Answer B saved').count() === 1, 'cancelling returns to the quiz with answers kept');
await b.getByRole('button', { name: 'Submit Quiz' }).click();
await b.getByRole('dialog').getByRole('button', { name: 'Submit now' }).click();
await b.getByRole('heading', { name: 'Quiz submitted' }).waitFor();
check(true, 'team B submitted early and sees the confirmation');

// --- organizer monitor shows attempt status and team progress
await org.waitForTimeout(800);
const monitor = await org.locator('#pm-title').locator('xpath=ancestor::section').innerText();
check(/Submitted early/.test(monitor) && /In progress/.test(monitor), 'organizer monitor shows attempt statuses');
check(!/PIN/.test(monitor), 'device monitor shows no PINs');
await org.screenshot({ path: join(SHOTS, 's03-live-monitor.png') });

// --- emergency pause (folded away) freezes the team timer; resume continues
await org.locator('details.live-fallback > summary').click();
await org.getByRole('button', { name: 'Pause all teams' }).click();
await a.getByRole('heading', { name: 'Paused' }).waitFor({ timeout: 8000 });
const p1 = await a.locator('.timer-text strong').textContent();
await a.waitForTimeout(2500);
const p2 = await a.locator('.timer-text strong').textContent();
check(p1 === p2, `team timer frozen while paused (${p1} = ${p2})`);
await org.getByRole('button', { name: 'Resume' }).click();
await a.locator('.play-q-text').waitFor({ timeout: 8000 });
check(true, 'resume returns the team to its question');

// --- results: times, statuses, attempt detail, exports
await nav('Results');
await org.locator('.results-table').waitFor();
check(await org.getByRole('status').filter({ hasText: 'Provisional' }).count() === 1, 'results marked provisional while the set is live');
const team2Row = await org.locator('.results-table tbody tr', { hasText: 'T2' }).first().innerText();
check(/Submitted early/.test(team2Row) && /\d\d:\d\d\.\d/.test(team2Row), 'results list the submitted team with its elapsed time and completion status');
check(await org.getByText('Time limit 10:00.0').count() === 1, 'results show the configured time limit');
await org.getByRole('button', { name: 'Attempt detail for team 2' }).click();
const detail = org.getByRole('dialog');
await detail.waitFor();
const detailText = await detail.innerText();
check(/Shown as/i.test(detailText) && /Accepted at \(server\)/i.test(detailText), 'attempt detail shows displayed letters and server timestamps');
await org.waitForTimeout(400); // let the dialog animation finish
await org.screenshot({ path: join(SHOTS, 's04-attempt-detail.png') });
await detail.getByRole('button', { name: 'Close dialog' }).click();
const [download] = await Promise.all([org.waitForEvent('download'), org.getByRole('button', { name: 'Submission audit' }).click()]);
check(/submission-audit/.test(download.suggestedFilename()), `submission audit CSV downloads (${download.suggestedFilename()})`);

// --- projector of this set has no keys
const proj = await ctx.newPage(); watch(proj, 'projector');
await proj.goto(`${BASE}/projector`);
await proj.locator('.proj-progress').waitFor();
check((await proj.locator('.option-key').count()) === 0, 'projector shows no answer key');

// --- end set: team A is finalized by the organizer
await r1('Live Host');
await org.getByRole('button', { name: 'End set' }).click();
await confirmDialog('End set', { typed: 'END' });
await nav('Dashboard');
const reviewBtn = org.getByRole('button', { name: /Review results/ });
await reviewBtn.first().waitFor();
check(await reviewBtn.count() === 1, 'dashboard: next step is to review the ended set');
check(/2\/2/.test(await org.locator('.mini-stat', { hasText: 'Finished submissions' }).innerText()), 'dashboard counts finished submissions from attempts');
await a.getByRole('heading', { name: 'Quiz closed' }).waitFor({ timeout: 8000 });
check(true, 'team still answering sees the organizer-finalized screen');

// --- a second UG set with a 6-second limit: its own code; a team that took set A is not offered;
//     a team that runs out of time is submitted automatically with its saved answer
await newSet('UG Rehearsal Set B');
await next(); // whole 60-question bank
await org.getByLabel(/Time limit per team/).fill('0.1');
await next();
await org.getByRole('button', { name: 'Publish set' }).click();
await confirmDialog('Publish & generate code');
const codeB = (await org.locator('.join-code-big').textContent()).replace(/\s/g, '');
check(codeB !== code && /^\d{6}$/.test(codeB), `second set has its own code (${codeB})`);
const c = await ctx.newPage(); watch(c, 'team3');
await openJoin(c, codeB);
await pickSection(c, /^UG/);
const optsB = await c.getByLabel('Your registered team').locator('option').allTextContents();
check(!optsB.some((o) => /^Team 1 · /.test(o)) && optsB.some((o) => /^Team 3 · /.test(o)), 'one set per team per section: a team from set A is not offered in set B');
await c.getByLabel('Your registered team').selectOption('3');
await c.getByRole('button', { name: 'Join quiz' }).click();
await c.getByText('Waiting for the organizer to open the quiz').waitFor();
await r1('Live Host');
await org.getByRole('button', { name: 'Go live' }).click();
await confirmDialog('Go live');
await c.getByRole('button', { name: 'Start the quiz' }).click({ timeout: 10000 });
await c.locator('.play-q-text').waitFor();
await c.locator('.play-options button').first().click();
await c.getByText('Answer A saved').waitFor();
await c.getByRole('heading', { name: "TIME'S UP" }).waitFor({ timeout: 15000 });
await c.getByText('Time is up. Your quiz has been submitted.').first().waitFor({ timeout: 8000 });
check(true, 'at the deadline the attempt is submitted automatically with a clear message');
await nav('Results');
await org.locator('.results-table').waitFor();
const t3Row = await org.locator('.results-table tbody tr', { hasText: 'T3' }).first().innerText();
check(/Timed out/.test(t3Row), `the auto-submitted team is listed as timed out (${t3Row.replace(/\s+/g, ' ').slice(0, 80)})`);
await c.goto(`${BASE}/join`);
await c.evaluate(() => sessionStorage.clear());
await openJoin(c, code);
await c.getByText('That code is not valid').waitFor();
check(true, 'the ended set\'s code no longer works');

// --- registration desk: started teams are locked, others editable
const desk = await ctx.newPage(); watch(desk, 'desk');
await nav('Teams');
await org.getByRole('heading', { name: 'Teams' }).waitFor();
const teamsText = await org.locator('table').innerText();
check(/Submitted early/i.test(teamsText) && /Organizer-finalized/i.test(teamsText), 'Teams page shows each team\'s Round 1 attempt status');
await desk.goto(`${BASE}/registration`);
await desk.locator('table').waitFor();
const ugRow = (n) => desk.locator('tbody tr', { has: desk.locator('td.num', { hasText: new RegExp(`^${n}$`) }) }).filter({ hasText: 'UG' }).first();
check(await ugRow(1).getByRole('button', { name: /Edit UG team 1/ }).isDisabled(), 'desk: a team that started is locked');
check(!(await ugRow(5).getByRole('button', { name: /Edit UG team 5/ }).isDisabled()), 'desk: teams that have not started stay editable');

check(errors.length === 0, `no console/page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
await browser.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL QUIZ-SET E2E CHECKS PASSED');
process.exit(failures ? 1 : 0);
