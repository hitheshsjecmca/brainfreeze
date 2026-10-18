// End-to-end (LOCAL DEMO MODE): Round 2 "MIND MELTDOWN" trivia sets and live games.
// Trivia Sets: create sets, topics and questions, edit the draft, preview, publish → six-digit code.
// Join Round 2: code → set → section → registered teams → review → Start Round 2 (projector opens).
// Game: tile → hidden; Reveal → question + 18 s timer; Answer → answer only; Right/Wrong →
// "Which Team Answered?" → Confirm → summary (question, team, result, points, change) → Confirm Score.
// Right = +the question's points, Wrong = 0; cancel/double-click/expiry never mis-score; a failed save shows
// an error, keeps the question open and can be retried; a second game of the same set is independent.
// The projector is interactive for the organiser (tile → Reveal / Cancel → Right / Wrong / Answer → team
// popup → Confirm → Confirm Score), stays in step with the host
// screen, and never shows scores, rankings or the score log — those are on the private host screen only.
//   npm run build:demo && npm run preview:demo     (serves http://localhost:4173)
//   node scripts/e2e-round2.mjs [baseUrl] [screenshotDir]
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
const host = await ctx.newPage(); watch(host, 'host');
const tab = (name) => host.locator('.round-tabs').getByRole('link', { name, exact: true }).click();
const tile = (topic, pts) => host.getByRole('button', { name: new RegExp(`^${topic}, ${pts} points`) }); // played tiles add ", already played"
const scoreOf = async (page, n) => (await page.locator('.r2-scores li', { has: page.locator('.r2-score-no', { hasText: new RegExp(`^UG T${n}$`) }) }).first().locator('.r2-score-val').innerText()).trim();
const dialog = () => host.getByRole('dialog');

// --- Trivia Sets: two sets; topics and questions; draft edits; preview; publish
await host.goto(`${BASE}/login`);
await host.getByRole('button', { name: 'Enter demo console' }).click();
await host.locator('.page').waitFor();
await host.locator('aside nav').getByRole('link', { name: 'Rounds', exact: true }).click();
check(await host.getByRole('link', { name: 'Open Round 2' }).count() === 1, 'Rounds page links to Round 2');
await host.getByRole('link', { name: 'Open Round 2' }).click();
await host.getByText('No live Round 2 game').waitFor();
check(true, 'no game is live before Start Round 2');
const tabs = await host.locator('.round-tabs a').allInnerTexts();
check(JSON.stringify(tabs) === JSON.stringify(['Round 2 Dashboard', 'Trivia Sets', 'Join Round 2']), `Round 2 navigation: ${tabs.join(' | ')}`);

const newSet = async (title, sectionLabel) => {
  await tab('Trivia Sets');
  await host.getByRole('button', { name: 'New trivia set' }).click();
  await dialog().getByLabel('Trivia set title').fill(title);
  await dialog().getByLabel('Section').selectOption({ label: sectionLabel });
  await dialog().getByRole('button', { name: 'Create set' }).click();
  await host.getByRole('heading', { name: new RegExp(`^${title}`) }).waitFor();
};
await newSet('Spare Board', 'UG and PG');
await newSet('UG Final Board', 'UG only');
for (const name of ['Networks', 'Databases']) {
  await host.getByLabel('New topic').fill(name);
  await host.getByRole('button', { name: 'Add topic' }).click();
  await host.getByRole('heading', { level: 2, name: new RegExp(`^${name}`) }).waitFor();
}
const addQuestion = async (topic, points, text, answer) => {
  await host.locator('section', { has: host.getByRole('heading', { level: 2, name: new RegExp(`^${topic}`) }) }).getByRole('button', { name: 'Add question' }).click();
  await dialog().getByLabel('Points').fill(points);
  await dialog().getByLabel('Question').fill(text);
  await dialog().getByLabel(/^Correct answer/).fill(answer);
  await dialog().getByRole('button', { name: 'Save question' }).click();
  await dialog().waitFor({ state: 'detached' });
};
check(await host.getByRole('button', { name: 'Publish Trivia Set' }).isDisabled(), 'an empty set cannot be published');
await addQuestion('Networks', '10', 'What does DNS stand for?', 'Domain Name System');
await addQuestion('Networks', '20', 'Which port does HTTP use?', '80');
await addQuestion('Databases', '15', 'What does SQL stand for?', 'Structured Query Language');
// edit the draft before publishing
await host.getByRole('button', { name: 'Edit 20-point question in Networks' }).click();
await dialog().getByLabel('Question').fill('Which port does HTTPS use by default?');
await dialog().getByLabel(/^Correct answer/).fill('443');
await dialog().getByRole('button', { name: 'Save question' }).click();
await dialog().waitFor({ state: 'detached' });
await host.getByText('Which port does HTTPS use by default?').waitFor();
check(await host.locator('.r2-qlist li').count() === 3, 'three questions in two topics; the draft edit is saved');
check(await host.locator('.r2-board .r2-tile').count() === 3, 'board preview shows every point tile');
await host.getByRole('button', { name: 'Publish Trivia Set' }).click();
await host.getByRole('alertdialog').getByRole('button', { name: 'Publish Trivia Set' }).click();
await host.locator('.r2-code-box .join-code-big').waitFor();
const code = (await host.locator('.r2-code-box .join-code-big').innerText()).replace(/\s/g, '');
check(/^\d{6}$/.test(code), `publishing generates a six-digit code (${code})`);
check(await host.getByRole('button', { name: 'Copy code' }).count() === 1, 'the code has a copy action');
await host.screenshot({ path: join(SHOTS, 'r2-00-trivia-set.png') });
await host.reload();
await host.locator('.r2-code-box .join-code-big').waitFor();
check((await host.locator('.r2-code-box .join-code-big').innerText()).replace(/\s/g, '') === code, 'reopening the set keeps the same code');
await tab('Trivia Sets');
const setRows = await host.locator('tbody tr').allInnerTexts();
check(setRows.length === 2 && setRows.some((r) => /UG Final Board/.test(r) && /Published v1/.test(r)) && setRows.some((r) => /Spare Board/.test(r) && /Draft/.test(r)), 'several independent sets: one published, one draft');

// --- Join Round 2: code → set → section → teams → review → Start
await tab('Join Round 2');
await host.getByLabel('Six-digit trivia set code').fill('000000');
await host.getByRole('button', { name: 'Load trivia set' }).click();
await host.getByText('No published trivia set has that code').waitFor();
check(true, 'an unknown code is refused');
await host.getByLabel('Six-digit trivia set code').fill(code);
await host.getByRole('button', { name: 'Load trivia set' }).click();
await host.getByRole('heading', { name: /^UG Final Board/ }).waitFor();
check(await host.locator('.r2-board .r2-tile').count() === 3, 'the code loads the published set');
check(await host.getByRole('radio', { name: /^PG/ }).isDisabled(), 'a UG-only set cannot be played by the PG section');
await host.locator('.team-picker-list li').first().waitFor();
const teamCount = await host.locator('.team-picker-list li').count();
check(teamCount >= 3, `registered UG teams are listed (${teamCount})`);
check(await host.getByRole('button', { name: /Start Round 2/ }).isDisabled(), 'Start is disabled until a team is selected');
for (const n of [1, 2, 3]) await host.locator('.team-picker-list li', { hasText: `T${n} ` }).first().locator('input').check();
check(/T1 .*T2 .*T3 /.test(await host.locator('.r2-review').innerText()), 'the review lists the set, section and the three teams');
await host.screenshot({ path: join(SHOTS, 'r2-01-join.png') });
await host.getByRole('button', { name: /Review & Start Round 2/ }).click();
const [proj] = await Promise.all([ctx.waitForEvent('page'), host.getByRole('alertdialog').getByRole('button', { name: 'Start Round 2' }).click()]);
watch(proj, 'projector');
await host.getByRole('heading', { name: 'Trivia board' }).waitFor();
check(/\/host\/rounds\/2\/session\//.test(host.url()), 'Start Round 2 opens the live game');
await proj.getByRole('heading', { name: 'MIND MELTDOWN' }).waitFor();
await proj.locator('.r2-tile').first().waitFor();
const projPrivate = async () => (await proj.locator('.r2-scores, .r2-proj-scores, .r2-proj-last, .r2-score-val').count()) === 0 && !/SCORES|LEADERBOARD|\bpts\b/i.test(await proj.locator('body').innerText());
check(await proj.locator('.r2-tile').count() === 3 && await projPrivate(), 'the projector shows the board — no scores, leaderboard or ranking');
check(await proj.getByRole('button', { name: /^Networks, 20 points/ }).isEnabled(), 'projector point tiles are clickable for the organiser');
check(await host.getByRole('heading', { name: 'Leaderboard' }).count() === 1 && await host.locator('.r2-scores li').count() === 3, 'the private host screen shows the leaderboard of the three teams');

// --- tile click does not reveal; Cancel returns
await tile('Networks', 20).click();
await dialog().getByRole('button', { name: 'Reveal Question' }).waitFor();
check(await host.getByText('Which port does HTTPS use by default?').count() === 0, 'clicking a tile does not show the question to the host');
await proj.locator('.r2-overlay').waitFor();
check(await proj.getByText('Which port does HTTPS use by default?').count() === 0 && /20/.test(await proj.locator('.r2-ov-points').innerText()), 'projector shows topic and points only — no question');
await dialog().getByRole('button', { name: 'Cancel' }).click();
await dialog().waitFor({ state: 'detached' });
check(await tile('Networks', 20).isEnabled(), 'Cancel returns to the board; the tile stays available');

// --- reveal: question + 18 s timer, answer hidden
await tile('Networks', 20).click();
await dialog().getByRole('button', { name: 'Reveal Question' }).click();
await host.getByRole('heading', { name: 'Which port does HTTPS use by default?' }).waitFor();
await proj.getByText('Which port does HTTPS use by default?').waitFor();
const t0 = Number((await proj.locator('.r2-timer strong').innerText()).trim());
check(t0 >= 16 && t0 <= 18, `projector countdown starts at 18 s (${t0})`);
check(await proj.getByText('443').count() === 0 && await proj.getByText('Answer hidden').count() === 1, 'answer hidden on the projector until Answer');
await proj.screenshot({ path: join(SHOTS, 'r2-02-projector-question.png') });

// --- Answer reveals only
await host.getByRole('button', { name: 'Answer', exact: true }).click();
await proj.locator('.r2-ov-answer', { hasText: '443' }).waitFor();
check(await scoreOf(host, 1) === '0' && await scoreOf(host, 2) === '0', 'Answer shows the answer without changing scores');

// --- Right → "Which Team Answered?" → Cancel → nothing changes (also from the summary step)
await host.getByRole('button', { name: 'Right', exact: true }).click();
await dialog().getByRole('heading', { name: 'Which Team Answered?' }).waitFor();
check(await dialog().getByRole('button', { name: 'Confirm', exact: true }).isDisabled(), 'Right opens "Which Team Answered?"; Confirm disabled until a team is chosen');
check(await dialog().locator('input[type=radio]:checked').count() === 0 && await dialog().locator('.r2-team-opt').count() === 3, 'only the three selected teams are offered; none preselected');
await dialog().getByRole('button', { name: 'Cancel' }).click();
await dialog().waitFor({ state: 'detached' });
check(await scoreOf(host, 1) === '0' && await host.getByRole('button', { name: 'Right', exact: true }).count() === 1, 'Cancel changes no score and keeps the question open');
await host.getByRole('button', { name: 'Right', exact: true }).click();
await dialog().locator('.r2-team-opt').first().click();
await dialog().getByRole('button', { name: 'Confirm', exact: true }).click();
await dialog().getByRole('heading', { name: 'Confirm score' }).waitFor();
await dialog().getByRole('button', { name: 'Cancel' }).click();
await dialog().waitFor({ state: 'detached' });
check(await scoreOf(host, 1) === '0' && await host.getByRole('button', { name: 'Right', exact: true }).count() === 1, 'Cancel on the summary changes no score and keeps the question open');

// --- Right → team 1 → Confirm → summary (+20) → a failed save shows an error and keeps everything → retry (double-clicked) → +20 once
await host.getByRole('button', { name: 'Right', exact: true }).click();
await dialog().getByRole('heading', { name: 'Which Team Answered?' }).waitFor();
await dialog().locator('.r2-team-opt').first().click();
await dialog().getByRole('button', { name: 'Confirm', exact: true }).click();
await dialog().getByRole('heading', { name: 'Confirm score' }).waitFor();
const summary = await dialog().innerText();
check(/Which port does HTTPS use by default\?/.test(summary) && /UG T1/.test(summary) && /Right/.test(summary) && /Question points\s*20/.test(summary) && /\+20 points/.test(summary),
  'the summary shows the question, the team, Right, the question’s 20 points and the +20 change');
check(await scoreOf(host, 1) === '0', 'no score changes before Confirm Score');
// one simulated storage failure for the next write (the demo backend saves through IndexedDB)
await host.evaluate(() => { const orig = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function put() { IDBObjectStore.prototype.put = orig; throw new DOMException('Simulated save failure', 'QuotaExceededError'); }; });
await dialog().getByRole('button', { name: 'Confirm Score' }).click();
await dialog().getByRole('alert').filter({ hasText: 'The score was not saved' }).waitFor();
check(await dialog().getByRole('heading', { name: 'Confirm score' }).count() === 1 && await host.locator('.r2-control-foot').count() === 1 && await scoreOf(host, 1) === '0',
  'a failed save shows an error, keeps the summary and the open question, and changes no score');
await dialog().getByRole('button', { name: 'Confirm Score' }).dblclick();
await dialog().waitFor({ state: 'detached' });
await host.locator('.r2-last').waitFor();
check(await scoreOf(host, 1) === '20', 'the retry (double-clicked) adds the question’s 20 points once');
check(await tile('Networks', 20).isDisabled() && await host.getByRole('heading', { name: 'Trivia board' }).count() === 1, 'back on the trivia board; the played tile is disabled');
await proj.locator('.r2-tile-used').first().waitFor();
check(await proj.locator('.r2-overlay').count() === 0 && await projPrivate(), 'projector returns to the board with the tile used — no scores');
await host.reload();
await host.locator('.r2-board').waitFor();
check(await tile('Networks', 20).isDisabled() && await scoreOf(host, 1) === '20', 'after a reload the question stays played and the score persists');

// --- played entirely ON THE PROJECTOR: tile → Cancel; tile → Reveal → Answer → Right → team 2 → Confirm (+10)
const pdialog = () => proj.getByRole('dialog');
const ptile = proj.getByRole('button', { name: /^Networks, 10 points/ });
await ptile.click();
await proj.locator('.r2-overlay').getByRole('button', { name: 'Reveal Question' }).waitFor();
check(await proj.getByText('What does DNS stand for?').count() === 0, 'a tile clicked on the projector opens Reveal Question / Cancel without the question');
await dialog().getByRole('heading', { name: 'Question selected' }).waitFor();
check(true, 'the host screen follows the projector selection');
await proj.locator('.r2-overlay').getByRole('button', { name: 'Cancel' }).click();
await proj.locator('.r2-overlay').waitFor({ state: 'detached' });
await dialog().waitFor({ state: 'detached' });
check(await ptile.isEnabled(), 'Cancel on the projector returns both screens to the board; tile still available');
await ptile.click();
await proj.locator('.r2-overlay').getByRole('button', { name: 'Reveal Question' }).click();
await proj.getByText('What does DNS stand for?').waitFor();
const pt0 = Number((await proj.locator('.r2-timer strong').innerText()).trim());
check(pt0 >= 16 && pt0 <= 18, `Reveal on the projector shows the question and starts the 18 s timer (${pt0})`);
await host.getByRole('heading', { name: 'What does DNS stand for?' }).waitFor();
check(true, 'the host screen shows the question revealed from the projector');
check(await proj.getByText('Domain Name System').count() === 0, 'the projector never peeks at the answer');
await proj.getByRole('button', { name: 'Answer', exact: true }).click();
await proj.locator('.r2-ov-answer', { hasText: 'Domain Name System' }).waitFor();
await host.locator('.r2-answer', { hasText: 'Domain Name System' }).waitFor();
check(await scoreOf(host, 2) === '0', 'Answer on the projector shows the answer on both screens, no score change');
await proj.getByRole('button', { name: 'Right', exact: true }).click();
await pdialog().getByRole('heading', { name: 'Which Team Answered?' }).waitFor();
const popup = await pdialog().innerText();
check(await pdialog().locator('.r2-team-opt').count() === 3 && !/pts|−\d|\+\d/.test(popup), 'the projector team popup lists the three teams without any scores');
check(await pdialog().getByRole('button', { name: 'Confirm', exact: true }).isDisabled(), 'Confirm needs a team on the projector too');
await pdialog().locator('.r2-team-opt', { hasText: 'T2' }).click();
await pdialog().getByRole('button', { name: 'Confirm', exact: true }).click();
const psum = await pdialog().innerText();
check(/\+10 points/.test(psum) && !/\(now/.test(psum), 'the projector summary shows the +10 change but no team total');
await pdialog().getByRole('button', { name: 'Confirm Score' }).dblclick();
await pdialog().waitFor({ state: 'detached' });
await proj.locator('.r2-overlay').waitFor({ state: 'detached' });
check(await ptile.isDisabled() && await projPrivate(), 'after Confirm the projector is back on the board, tile used, still no scores');
await host.locator('.r2-last', { hasText: 'Right' }).waitFor();
check(await scoreOf(host, 2) === '10', 'Right confirmed on the projector adds the full value (+10) once — on the private leaderboard');
await proj.reload();
await proj.locator('.r2-tile').first().waitFor();
check(await proj.getByRole('button', { name: /^Networks, 10 points, already played/ }).isDisabled() && await projPrivate(), 'a projector refresh keeps the tile used and shows no scores');
await host.reload();
await host.locator('.r2-board').waitFor();
check(await scoreOf(host, 2) === '10', 'a host refresh keeps the score counted once');

// --- Display only: no controls on the projector
await proj.getByRole('button', { name: /Display only/ }).click();
check(await proj.locator('.r2-board button').count() === 0, 'Display only turns the projector into a passive screen (no clickable tiles)');
await proj.getByRole('button', { name: /Show controls/ }).click();
check(await proj.locator('.r2-board button').count() > 0, 'Show controls brings the interactive tiles back');

// --- expiry never scores
await tile('Databases', 15).click();
await dialog().getByRole('button', { name: 'Reveal Question' }).click();
await proj.locator('.r2-timer.timer-expired').waitFor({ timeout: 25000 });
check(await proj.getByText("TIME'S UP").count() === 1, 'projector shows that time expired');
check(await host.getByRole('button', { name: 'Right', exact: true }).count() === 1 && await scoreOf(host, 3) === '0', 'expired timer awards nothing; the host still decides');
await host.getByRole('button', { name: 'Close without points' }).click();
await host.getByRole('alertdialog').getByRole('button', { name: 'Close without points' }).click();
await host.locator('.r2-last', { hasText: 'no points' }).waitFor();
check(await tile('Databases', 15).isDisabled() && await scoreOf(host, 3) === '0', 'closing without points marks the question played, 0 points');
await proj.locator('.r2-overlay').waitFor({ state: 'detached' });
await proj.locator('.r2-tile-used').nth(2).waitFor();
check(await proj.locator('.r2-tile-used').count() === 3 && await projPrivate(), 'projector back on the board: all three tiles marked played, no scores');
await proj.screenshot({ path: join(SHOTS, 'r2-03-projector-board.png') });
const logRows = await host.locator('#r2-log').locator('xpath=ancestor::section').locator('tbody tr').allInnerTexts();
check(logRows.length === 3, `score log records each played question once — the double click did not duplicate (${logRows.length} rows)`);
await host.screenshot({ path: join(SHOTS, 'r2-04-host-game.png') });
const firstGame = host.url();

// --- a second game of the same set is independent
await tab('Join Round 2');
await host.getByLabel('Six-digit trivia set code').fill(code);
await host.getByRole('button', { name: 'Load trivia set' }).click();
await host.locator('.team-picker-list li').first().waitFor();
await host.locator('.team-picker-list li', { hasText: 'T3 ' }).first().locator('input').check();
await host.getByRole('button', { name: /Review & Start Round 2/ }).click();
await host.getByRole('alertdialog').getByRole('button', { name: 'Start Round 2' }).click();
await host.getByRole('heading', { name: 'Trivia board' }).waitFor();
check(host.url() !== firstGame && await host.locator('.r2-tile-used').count() === 0 && await scoreOf(host, 3) === '0', 'the second game starts with a fresh board and scores');
// Wrong → team 3 → summary (+0) → Confirm Score → 0 points, tile used, back on the board
await tile('Networks', 20).click();
await dialog().getByRole('button', { name: 'Reveal Question' }).click();
await host.getByRole('button', { name: 'Wrong', exact: true }).click();
await dialog().getByRole('heading', { name: 'Which Team Answered?' }).waitFor();
await dialog().locator('.r2-team-opt').first().click();
await dialog().getByRole('button', { name: 'Confirm', exact: true }).click();
const wsum = await dialog().innerText();
check(/Wrong/.test(wsum) && /Score change\s*0 points/.test(wsum) && !/−/.test(wsum), 'Wrong: the summary shows a 0-point change — nothing is deducted');
await dialog().getByRole('button', { name: 'Confirm Score' }).click();
await dialog().waitFor({ state: 'detached' });
await host.locator('.r2-last', { hasText: 'Wrong' }).waitFor();
check(await scoreOf(host, 3) === '0' && await tile('Networks', 20).isDisabled(), 'Wrong scores 0 for the confirmed team; the tile is used and the board is back');
await host.goto(firstGame);
await host.locator('.r2-board').waitFor();
check(await host.locator('.r2-tile-used').count() === 3 && await scoreOf(host, 1) === '20', 'the first game is unchanged');
await tab('Round 2 Dashboard');
await host.locator('tbody tr').nth(1).waitFor({ timeout: 5000 }).catch(() => {});
check(await host.locator('tbody tr').count() === 2, 'the dashboard lists both live games');

// --- phone width
const m = await ctx.newPage(); watch(m, 'phone');
await m.setViewportSize({ width: 390, height: 844 });
await m.goto(firstGame.replace(/^.*\/host/, `${BASE}/host`));
await m.locator('.r2-board').waitFor();
const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check(overflow <= 1, `no horizontal page scroll on the Round 2 game at phone width (overflow ${overflow}px)`);

check(errors.length === 0, `no console/page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
await browser.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL ROUND 2 E2E CHECKS PASSED');
process.exit(failures ? 1 : 0);
