// End-to-end (LOCAL DEMO MODE): Round 3 "THE KNOWLEDGE AUCTION".
// Auction Sets: create a set (Normal + Blind questions), reorder, preview, publish → six-digit code.
// Join Round 3: code → section → exactly three teams → Start Round 3 (projector opens).
// Live Auction (private control panel) and public projector: Normal topic shown before bidding; bids validated;
// highest bidder correct (+½ bid score) / wrong (−½ bid budget) → next bidder correct (+10); Blind topic hidden
// until Reveal Topic after bidding; tie resolution; timed bidding (refresh keeps it; closes itself at zero) and
// untimed bidding (manual close only); refresh keeps the answer timer; double-click scores once; Q4 (Normal) and
// Q5 (Blind) run entirely from the organiser-controlled projector at 1280×720 (topic cards, team-card +10/−10/Pass,
// outcomes); audience display has no controls; projector never shows private scores; End Auction → final rankings revealed on demand; results + phone width.
//   npm run build:demo && npm run preview:demo     (serves http://localhost:4173)
//   node scripts/e2e-round3.mjs [baseUrl] [screenshotDir]
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
const dialog = () => host.getByRole('dialog');
const btn = (name) => host.getByRole('button', { name, exact: true });
const scoreOf = async (seat) => Number((await host.locator('.r3-side .r3-team').nth(seat - 1).locator('.r3-score b').innerText()).trim());
const budgetOf = async (page, seat) => Number((await page.locator('.r3-team').nth(seat - 1).locator('.r3-budget').innerText()).replace(/\D/g, ''));
const bidForm = (seat) => host.locator('.r3-bidform').nth(seat - 1);
const bidValue = async (seat) => Number((await bidForm(seat).locator('.r3-bidvalue').innerText()).trim());
const bidStatus = (seat) => bidForm(seat).locator('.r3-bidstatus').innerText();
const plusBtn = (seat) => bidForm(seat).getByRole('button', { name: /^\+10 for/ });
const minusBtn = (seat) => bidForm(seat).getByRole('button', { name: /^−10 for/ });
const passBtn = (seat) => bidForm(seat).getByRole('button', { name: /^Pass for/ });
const waitBid = (seat, v) => bidForm(seat).locator('.r3-bidvalue').filter({ hasText: new RegExp(`^${v}$`) }).waitFor();
// Press +10 (or −10) one step at a time until the server-confirmed bid equals `amount`.
const bid = async (seat, amount) => {
  for (let cur = await bidValue(seat); cur !== amount; cur = await bidValue(seat)) {
    await (cur < amount ? plusBtn(seat) : minusBtn(seat)).click();
    await waitBid(seat, cur < amount ? cur + 10 : cur - 10);
  }
  await host.locator('.r3-side .r3-team').nth(seat - 1).locator('.r3-bid', { hasText: String(amount) }).waitFor();
};
const pass = async (seat) => { await passBtn(seat).click(); await host.locator('.r3-side .r3-team').nth(seat - 1).locator('.r3-bid', { hasText: 'Passed' }).waitFor(); };

// --- Auction Sets
await host.goto(`${BASE}/login`);
await host.getByRole('button', { name: 'Enter demo console' }).click();
await host.locator('.page').waitFor();
// Round 3 Availability: disabled by default → no Round 3 interface, direct URLs redirect; enable it in Settings.
await host.locator('aside nav').getByRole('link', { name: 'Rounds', exact: true }).click();
await host.getByRole('link', { name: 'Open Round 2' }).waitFor();
check(await host.getByRole('link', { name: 'Open Round 3' }).count() === 0, 'Round 3 is hidden by default');
await host.goto(`${BASE}/host/rounds/3/sets`);
await host.waitForURL(/\/host\/rounds$/);
check(true, 'a direct Round 3 URL redirects to Rounds while Round 3 is disabled');
await host.locator('aside nav').getByRole('link', { name: 'Settings & Backup', exact: true }).click();
await host.getByRole('radio', { name: 'Enabled' }).click();
await host.getByRole('alertdialog').getByRole('button', { name: 'Enable Round 3' }).click();
await host.getByRole('radio', { name: 'Enabled', checked: true }).waitFor();
await host.reload();
await host.getByRole('radio', { name: 'Enabled', checked: true }).waitFor();
check(true, 'Round 3 Availability stays enabled after a refresh');
await host.locator('aside nav').getByRole('link', { name: 'Rounds', exact: true }).click();
await host.getByRole('link', { name: 'Open Round 3' }).click();
await host.getByText('No live auction').waitFor();
const tabs = await host.locator('.round-tabs a').allInnerTexts();
check(JSON.stringify(tabs) === JSON.stringify(['Auction Sets', 'Join Round 3', 'Live Auction', 'Round 3 Results']), `Round 3 navigation: ${tabs.join(' | ')}`);
await tab('Auction Sets');
await host.getByRole('button', { name: 'New auction set' }).click();
await dialog().getByLabel('Auction set title').fill('UG Grand Finale');
await dialog().getByLabel('Description (optional)').fill('Three finalists, one winner');
await dialog().getByLabel('Section').selectOption({ label: 'UG only' });
await dialog().getByRole('button', { name: 'Create set' }).click();
await host.getByRole('heading', { name: /^UG Grand Finale/ }).waitFor();
check(await host.getByRole('button', { name: 'Publish Auction Set' }).isDisabled(), 'an empty auction set cannot be published');
for (const name of ['Networks', 'Security']) {
  await host.getByLabel('New topic').fill(name);
  await host.getByRole('button', { name: 'Add topic' }).click();
  await host.getByRole('heading', { level: 2, name: new RegExp(`^${name}`) }).waitFor();
}
const addQuestion = async (topic, mode, text, answer) => {
  await host.locator('section', { has: host.getByRole('heading', { level: 2, name: new RegExp(`^${topic}`) }) }).getByRole('button', { name: 'Add question' }).click();
  await dialog().getByLabel('Topic mode').selectOption(mode);
  await dialog().getByLabel('Question').fill(text);
  await dialog().getByLabel(/^Correct answer/).fill(answer);
  await dialog().getByRole('button', { name: 'Save question' }).click();
  await dialog().waitFor({ state: 'detached' });
};
await addQuestion('Networks', 'NORMAL', 'Which port does HTTPS use by default?', '443');
await addQuestion('Networks', 'NORMAL', 'What does DNS stand for?', 'Domain Name System');
await addQuestion('Security', 'BLIND', 'What does XSS stand for?', 'Cross-site scripting');
await addQuestion('Security', 'NORMAL', 'Which OSI layer does IP belong to?', 'Network layer');
await addQuestion('Security', 'BLIND', 'What does CSRF stand for?', 'Cross-site request forgery');
await host.getByRole('button', { name: 'Move question 2 of Networks up' }).click();
await host.locator('.r3-preview li').first().filter({ hasText: 'What does DNS stand for?' }).waitFor();
check(true, 'reordering a question changes the auction order in the preview');
check(/MYSTERY QUESTION #1/.test(await host.locator('.r3-preview').innerText()), 'the preview shows the blind question as MYSTERY QUESTION #1');
await host.getByRole('button', { name: 'Publish Auction Set' }).click();
await host.getByRole('alertdialog').getByRole('button', { name: 'Publish Auction Set' }).click();
await host.locator('.r2-code-box .join-code-big').waitFor();
const code = (await host.locator('.r2-code-box .join-code-big').innerText()).replace(/\s/g, '');
check(/^\d{6}$/.test(code), `publishing generates a six-digit code (${code})`);
await host.screenshot({ path: join(SHOTS, 'r3-01-auction-set.png') });

// --- Join Round 3
await tab('Join Round 3');
await host.getByLabel('Six-digit auction set code').fill('000000');
await host.getByRole('button', { name: 'Load auction set' }).click();
await host.getByText('No published auction set has that code').waitFor();
check(true, 'an unknown code is refused');
await host.getByLabel('Six-digit auction set code').fill(code);
await host.getByRole('button', { name: 'Load auction set' }).click();
await host.getByRole('list', { name: 'Registered UG teams' }).waitFor();
check(await host.getByRole('radio', { name: /^PG/ }).isDisabled(), 'a UG-only set cannot be played by the PG section');
for (const n of [1, 2, 3]) await host.locator('.r2-roster li', { hasText: new RegExp(`^T${n} `) }).first().locator('input').check();
check(await host.locator('.r2-roster li', { hasText: /^T4 / }).first().locator('input').isDisabled(), 'a fourth team cannot be selected');
check(/Seat 1: T1 .*Seat 2: T2 .*Seat 3: T3 /.test(await host.locator('.r2-review').innerText()), 'the review lists the three finalists in seat order');
check(/Bidding: No timer/.test(await host.locator('.r2-review').innerText()), 'the set default bidding timer is “No timer”');
await host.locator('.r2-review').getByRole('radio', { name: 'Timed' }).check();
await host.locator('.r2-review').getByLabel('Bidding seconds').fill('30');
check(/Bidding: 30 s/.test(await host.locator('.r2-review').innerText()), 'the auction default bidding timer is set to 30 s at Start');
const [proj] = await Promise.all([ctx.waitForEvent('page'), host.getByRole('button', { name: /Start Round 3/ }).click()]);
watch(proj, 'projector');
await host.getByRole('heading', { name: 'Select Question' }).waitFor();
check(/\/host\/rounds\/3\/session\//.test(host.url()), 'Start Round 3 opens the private control panel');
await proj.getByRole('heading', { name: 'THE KNOWLEDGE AUCTION' }).waitFor();
await proj.locator('.r3-team').nth(2).waitFor();
const projNoScores = async () => (await proj.locator('.r3-score, .r3-ranking').count()) === 0 && !/score/i.test(await proj.locator('body').innerText());
check(await budgetOf(proj, 1) === 100 && await budgetOf(proj, 2) === 100 && await budgetOf(proj, 3) === 100, 'projector: every team starts with a public budget of 100');
check(await projNoScores(), 'projector shows no private scores');
check(await scoreOf(1) === 0 && await scoreOf(2) === 0 && await scoreOf(3) === 0, 'control panel: every private score starts at 0');

// --- Q1 NORMAL: topic before bidding; highest bidder correct (+½ bid), double-clicked once
await host.getByRole('button', { name: 'Select question 1' }).click();
await proj.locator('.r3-proj-label', { hasText: 'Networks' }).waitFor();
check(await proj.getByText('What does DNS stand for?').count() === 0, 'NORMAL: the projector shows the topic; the question stays hidden');
await host.getByRole('button', { name: /^Start Bidding/ }).click();
await proj.getByText('BIDDING OPEN').waitFor();
await proj.locator('.r3-timer').waitFor();
await host.locator('.r3-mode-line').waitFor();
check(await proj.locator('.r3-timer').count() === 1 && /Timed · 30 s/.test(await host.locator('.r3-mode-line').innerText()), 'timed bidding (auction default 30 s): countdown on the projector and the control panel');
const b1 = Number((await host.locator('.r3-timer strong').innerText()).trim());
await host.reload();
await host.locator('.r3-bidform').first().waitFor();
const b2 = Number((await host.locator('.r3-timer strong').innerText()).trim());
check(b1 <= 30 && b2 <= b1 && b2 >= b1 - 5, `the bidding timer survives a refresh without restarting (${b1} s → ${b2} s)`);
check(await bidValue(1) === 0 && await bidValue(2) === 0 && await bidValue(3) === 0 && /Ready/i.test(await bidStatus(1)), 'every team starts the question at bid 0, status Ready');
check(await minusBtn(1).isDisabled(), '−10 is disabled at bid 0 (no negative bid)');
await plusBtn(1).click(); await waitBid(1, 10);
check(/Bidding/i.test(await bidStatus(1)) && await budgetOf(host, 1) === 100, '+10 raises the bid from 0 to exactly 10, status Bidding; budget unchanged');
await plusBtn(1).click(); await waitBid(1, 20);
await minusBtn(1).click(); await waitBid(1, 10);
check(await budgetOf(host, 1) === 100, '+10 → 20, −10 corrects back to exactly 10; budget unchanged');
await minusBtn(1).click(); await waitBid(1, 0);
check(/Ready/i.test(await bidStatus(1)) && await minusBtn(1).isDisabled(), '−10 from 10 leaves bid 0 = no valid bid (Ready), and −10 disables');
await plusBtn(2).dblclick(); await waitBid(2, 10);
await host.waitForTimeout(400);
check(await bidValue(2) === 10, 'a double-click on +10 records one raise (bids are sent as absolute amounts)');
await bid(1, 40); await bid(2, 30); await pass(3);
check(/Passed/i.test(await bidStatus(3)) && await plusBtn(3).isDisabled() && await minusBtn(3).isDisabled() && await passBtn(3).count() === 0, 'Pass marks the team Passed and locks its +10 / −10 controls');
await proj.locator('.r3-team').nth(0).locator('.r3-bid', { hasText: '40' }).waitFor();
check(true, 'projector shows the live bids');
check(await budgetOf(host, 1) === 100, 'placing a bid does not change the budget');
await btn('Close Bidding').click();
await btn('Reveal Question (25 s)').click();
await proj.getByText('What does DNS stand for?').waitFor();
check(await proj.locator('.r3-timer').count() === 1 && await proj.getByText('Domain Name System').count() === 0, 'Reveal Question shows the question and the answer timer, not the answer');
await btn('Correct').click();
const sum1 = await dialog().innerText();
check(/Current budget\s*100/.test(sum1) && /Current private score\s*0/.test(sum1) && /Bid\s*40/.test(sum1) && /Resulting private score\s*20/.test(sum1) && /Resulting budget\s*100/.test(sum1),
  'the confirmation shows current budget/score, bid, changes and resulting budget 100 / score 20');
await dialog().getByRole('button', { name: 'Confirm Outcome' }).dblclick();
await dialog().waitFor({ state: 'detached' });
await host.getByRole('button', { name: /Complete Question/ }).waitFor();
check(await scoreOf(1) === 20 && await budgetOf(host, 1) === 100, 'highest bidder correct: private score +20 (½ of 40), budget unchanged — applied once');
await proj.locator('.r3-feedback', { hasText: 'CORRECT' }).waitFor();
check(await projNoScores(), 'projector shows CORRECT but no score');
await host.getByRole('button', { name: /Complete Question/ }).click();
await host.getByRole('heading', { name: 'Select Question' }).waitFor();

// --- Q2 NORMAL: highest bidder wrong (−½ bid budget) → next bidder correct (+10)
await host.getByRole('button', { name: 'Select question 2' }).click();
await host.getByRole('button', { name: /^Start Bidding/ }).click();
await bid(1, 40); await bid(2, 30);
await btn('Close Bidding').click();
await btn('Reveal Question (25 s)').click();
await btn('Wrong').click();
check(/Budget change\s*-20/.test(await dialog().innerText()) && /Resulting budget\s*80/.test(await dialog().innerText()), 'the confirmation previews budget −20 → 80');
await dialog().getByRole('button', { name: 'Confirm Outcome' }).click();
await dialog().waitFor({ state: 'detached' });
await host.getByRole('button', { name: /Move to Next Eligible Bidder/ }).waitFor();
check(await scoreOf(1) === 20 && await budgetOf(host, 1) === 80, 'highest bidder wrong: budget −20, score unchanged');
await proj.locator('.r3-team').nth(0).locator('.r3-budget', { hasText: '80' }).waitFor();
check(true, 'the projector shows the new public budget');
await host.getByRole('button', { name: /Move to Next Eligible Bidder/ }).click();
await btn('Correct').click();
check(/Score change\s*\+10/.test(await dialog().innerText()) && /Resulting private score\s*10/.test(await dialog().innerText()), 'lower-ranked bidder correct previews +10');
await dialog().getByRole('button', { name: 'Confirm Outcome' }).click();
await dialog().waitFor({ state: 'detached' });
await host.getByRole('button', { name: /Complete Question/ }).waitFor();
check(await scoreOf(2) === 10 && await budgetOf(host, 2) === 100, 'lower-ranked bidder correct: +10 score, budget unchanged');
await host.getByRole('button', { name: /Complete Question/ }).click();
await host.getByRole('heading', { name: 'Select Question' }).waitFor();

// --- Q3 BLIND: mystery label, tie resolution, topic only after Reveal Topic, timer survives a refresh
await host.getByRole('button', { name: 'Select question 3' }).click();
await proj.locator('.r3-proj-label', { hasText: 'MYSTERY QUESTION #1' }).waitFor();
check(await proj.getByText('Security').count() === 0, 'BLIND: the projector shows MYSTERY QUESTION #1, not the topic');
await host.getByRole('radio', { name: /^No timer/ }).check();
await host.getByRole('button', { name: 'Start Bidding (No timer)' }).click();
await proj.getByText('No timer — the host closes bidding').waitFor();
check(await proj.locator('.r3-timer').count() === 0 && await host.locator('.r3-timer').count() === 0, 'per-question “No timer”: no countdown anywhere; bidding stays open until Close Bidding');
await bid(1, 30); await bid(2, 30);
const bud3 = await budgetOf(host, 3);
await bid(3, bud3);
check(await plusBtn(3).isDisabled() && await budgetOf(host, 3) === bud3, `+10 is disabled once the bid equals the budget (${await bidValue(3)}); budget unchanged`);
await pass(3);
await bidForm(3).getByRole('button', { name: /^Undo pass for/ }).click();
await host.getByRole('alertdialog').getByRole('button', { name: 'Undo pass' }).click();
await waitBid(3, 0);
check(/Ready/i.test(await bidStatus(3)) && /pass undone/.test(await host.locator('.r3-log').innerText()), 'an accidental pass is undone only through the confirmed correction, which is logged');
await pass(3);
await btn('Close Bidding').click();
await host.getByText(/Two or more teams bid the same amount/).waitFor();
check(await proj.getByText('Security').count() === 0, 'closing bidding never reveals a blind topic');
await host.getByRole('button', { name: /Move .* down/ }).first().click();
await host.getByLabel('How was the tie resolved?').fill('Coin toss won by T2');
await btn('Confirm order').click();
await btn('Reveal Topic').waitFor();
check(await btn('Reveal Question (25 s)').isDisabled(), 'Reveal Question waits for Reveal Topic on a blind question');
await btn('Reveal Topic').click();
await proj.locator('.r3-proj-label', { hasText: 'Security' }).waitFor();
check(await proj.getByText('What does XSS stand for?').count() === 0, 'Reveal Topic shows the topic; the question stays hidden');
await btn('Reveal Question (25 s)').click();
await proj.getByText('What does XSS stand for?').waitFor();
const t1 = Number((await proj.locator('.r3-timer strong').innerText()).trim());
await host.reload();
await host.locator('.r3-timer').waitFor();
const t2 = Number((await host.locator('.r3-timer strong').innerText()).trim());
check(t1 <= 25 && t2 <= t1 && t2 >= t1 - 5, `the answer timer is server-timed and survives a refresh (${t1} s → ${t2} s)`);
check(/Answering: T2 /.test(await host.locator('.r3-turn').innerText()), 'the tie resolution put T2 first');
await btn('Reveal Answer').click();
await proj.locator('.r2-ov-answer', { hasText: 'Cross-site scripting' }).waitFor();
await btn('Correct').click();
await dialog().getByRole('button', { name: 'Confirm Outcome' }).click();
await dialog().waitFor({ state: 'detached' });
await host.getByRole('button', { name: /Complete Question/ }).click();
await host.getByRole('heading', { name: 'Select Question' }).waitFor();
check(await scoreOf(2) === 25, 'T2 as the (tie-resolved) highest bidder earns +15 → 25');
// --- Q4: a 4-second timed bidding closes itself at zero (no Close Bidding click)
await host.getByRole('button', { name: 'Select question 4' }).click();
await host.getByRole('radio', { name: 'Timed' }).check();
await host.getByLabel('Bidding seconds').fill('4');
await host.getByRole('button', { name: 'Start Bidding (4 s)' }).click();
await bid(1, 20);
await host.getByText('Bidding is closed. Answering order:').waitFor({ timeout: 15000 });
await proj.getByText('BIDDING CLOSED').waitFor({ timeout: 10000 });
check(await host.locator('.r3-bidform').count() === 0 && /Q4 bidding closed automatically when the timer ended/.test(await host.locator('.r3-log').innerText()), 'timed bidding closed itself at the deadline; bids are locked');
await host.getByRole('button', { name: 'Cancel question' }).click();
await host.getByRole('alertdialog').getByRole('button', { name: 'Cancel question' }).click();
await host.getByRole('heading', { name: 'Select Question' }).waitFor();
await host.screenshot({ path: join(SHOTS, 'r3-02-control-panel.png') });

// --- The organiser-controlled projector: Q4 (Normal) and Q5 (Blind) are run entirely from the projector screen
await proj.setViewportSize({ width: 1280, height: 720 });
const pbtn = (name) => proj.locator('.r3-ctl').getByRole('button', { name, exact: true });
const pdialog = () => proj.getByRole('dialog');
const pcard = (seat) => proj.locator('.r3-team').nth(seat - 1);
const pPress = async (seat, what, expected) => {
  await pcard(seat).getByRole('button', { name: new RegExp(`^${what} for`) }).click();
  await pcard(seat).locator('.r3-bid').filter({ hasText: expected === '—' ? /^Passed$/ : expected === 0 ? /Ready/ : new RegExp(`^BID ${expected}$`) }).waitFor();
};
const fits = async () => proj.evaluate(() => {
  const bar = document.querySelector('.r3-ctl')?.getBoundingClientRect();
  const teams = document.querySelector('.r3-teams')?.getBoundingClientRect();
  const stage = document.querySelector('.r3-proj-stage')?.getBoundingClientRect();
  const st = document.querySelector('.r3-proj-stage');
  return !!bar && bar.bottom <= window.innerHeight + 1 && teams.bottom <= bar.top + 1 && stage.bottom <= teams.top + 1 && st.scrollHeight <= st.clientHeight + 2
    && document.documentElement.scrollWidth <= window.innerWidth + 1;
});
const sid = host.url().split('/session/')[1];
await proj.locator('.r3-proj-board').waitFor();
const cards = await proj.locator('.r3-proj-board button.r3-tile').allInnerTexts();
check(cards.length === 4 && /Networks\s*SOLD/i.test(cards[0]) && /MYSTERY QUESTION #2/i.test(cards[3]), `projector topic cards are clickable buttons: ${cards.map((c) => c.replace(/\s+/g, ' ')).join(' | ')}`);
await proj.locator('.r3-proj-board button.r3-tile', { hasText: 'Networks' }).click();
check(await pdialog().getByText('Used').count() === 2 && await pdialog().getByRole('button', { name: /^Select question/ }).count() === 0, 'a sold-out topic lists its questions as Used and offers no Select');
await proj.keyboard.press('Escape');
await proj.locator('.r3-proj-board button.r3-tile', { hasText: 'Security' }).click();
check(/Question #4/.test(await pdialog().innerText()) && /NORMAL/.test(await pdialog().innerText()) && !/Network layer/.test(await pdialog().innerText()), 'clicking a topic card lists its unused question with its mode, never the answer');
await pdialog().getByRole('button', { name: 'Select question 4' }).click();
await pdialog().waitFor({ state: 'detached' });
await proj.locator('.r3-proj-label', { hasText: 'Security' }).waitFor();
check(await proj.locator('.r3-status-open').count() === 0 && await pbtn('Start Bidding (30 s)').count() === 1, 'selecting a question does not start bidding; Start Bidding (auction default) is offered');
check(await fits(), 'projector controls fit 1280×720 without overlapping the stage or the team cards (selected)');
await proj.locator('.r3-ctl').getByRole('radio', { name: /^No timer/ }).check();
await pbtn('Start Bidding (No timer)').click();
await proj.locator('.r3-status-open').waitFor();
check(await proj.locator('.r3-timer').count() === 0, 'projector: No timer chosen on the projector — no countdown');
check(await pcard(1).locator('.r3-bidbuttons').count() === 1, 'every team card shows its +10 / −10 / Pass controls while bidding');
await pcard(1).getByRole('button', { name: /bidding controls/ }).click();
check(await pcard(1).locator('.r3-bidbuttons').count() === 0, 'clicking a team card collapses its controls…');
await pcard(1).getByRole('button', { name: /bidding controls/ }).click();
check(await pcard(1).locator('.r3-bidbuttons').count() === 1, '…and clicking it again expands them');
await pPress(1, '\\+10', 10); await pPress(1, '\\+10', 20); await pPress(1, '−10', 10); await pPress(1, '\\+10', 20);
await pPress(3, '\\+10', 10);
await pPress(2, 'Pass', '—');
check(/Passed/i.test(await pcard(2).locator('.r3-bidstatus').innerText()) && await pcard(2).getByRole('button', { name: /^\+10 for/ }).isDisabled(), 'projector Pass locks the team (status Passed, +10 disabled)');
check(await budgetOf(proj, 1) === 80, 'projector bids never change the budget (T1 still 80)');
await host.locator('.r3-side .r3-team').nth(0).locator('.r3-bid', { hasText: '20' }).waitFor();
check(true, 'bids entered on the projector reach the private control panel');
check(await fits(), 'projector controls fit 1280×720 (bidding, with team controls)');
await proj.screenshot({ path: join(SHOTS, 'r3-03a-projector-bidding.png') });

const aud = await ctx.newPage(); watch(aud, 'audience');
await aud.setViewportSize({ width: 1280, height: 720 });
await aud.goto(`${BASE}/projector/round3?session=${sid}&view=display`);
await aud.locator('.r3-status-open').waitFor();
check(await aud.locator('.r3-ctl, .r3-bidbuttons, button.r3-tile, .r3-team-toggle').count() === 0 && (await aud.locator('.r3-score, .r3-ranking').count()) === 0,
  'audience display (?view=display): same live bids, no controls and no private scores');

await pbtn('Close Bidding').click();
await pbtn('Reveal Question (25 s)').click();
await proj.getByText('Which OSI layer does IP belong to?').waitFor();
check(await fits(), 'projector controls fit 1280×720 (answering, with question and timer)');
await proj.screenshot({ path: join(SHOTS, 'r3-03b-projector-answering.png') });
await pbtn('Correct').hover();
check((await pbtn('Correct').evaluate((b) => getComputedStyle(b).backgroundImage)).includes('gradient'), 'Correct keeps its colour when hovered');
await pbtn('Wrong').click();
let pd = await pdialog().innerText();
check(/Budget change\s*-10/.test(pd) && /Resulting budget\s*70/.test(pd) && /Private score change\s*hidden/.test(pd), 'projector Confirm Outcome previews the budget (80 → 70) and keeps the private score change hidden');
await pdialog().getByRole('button', { name: 'Confirm Outcome' }).click();
await pdialog().waitFor({ state: 'detached' });
await pbtn('Next Eligible Bidder: T3 Polar Stack (Demo)').click();
await proj.locator('.r3-proj-turn', { hasText: 'T3' }).waitFor();
await pbtn('Correct').click();
await pdialog().getByRole('button', { name: 'Show private change' }).click();
check(/Private score change\s*\+10/.test(await pdialog().innerText()), 'the organiser can show the private change on demand (+10 for a lower-ranked bidder)');
await pdialog().getByRole('button', { name: 'Confirm Outcome' }).dblclick();
await pdialog().waitFor({ state: 'detached' });
await pbtn('Complete Question → Next Question').click();
await proj.locator('.r3-proj-board').waitFor();
await host.locator('.r3-side .r3-team').nth(2).locator('.r3-score b', { hasText: '10' }).waitFor();
check(await scoreOf(3) === 10 && await budgetOf(host, 1) === 70 && await scoreOf(1) === 20, 'Q4 run from the projector: T1 wrong −10 budget, T3 correct +10 score — applied once');

// Q5 BLIND from the projector: mystery label → bidding → Reveal Topic → Reveal Question
await proj.locator('.r3-proj-board button.r3-tile', { hasText: 'MYSTERY QUESTION #2' }).click();
await pdialog().getByRole('button', { name: 'Select question 5' }).click();
await proj.locator('.r3-proj-label', { hasText: 'MYSTERY QUESTION #2' }).waitFor();
check(!/Security|CSRF/.test(await proj.locator('body').innerText()), 'projector BLIND: only MYSTERY QUESTION #2 — topic and question hidden');
await pbtn('Start Bidding (30 s)').click();
await proj.locator('.r3-timer').waitFor();
await pPress(2, '\\+10', 10);
await pbtn('Close Bidding').click();
await pbtn('Reveal Topic').waitFor();
check(await pbtn('Reveal Question (25 s)').isDisabled() && !/Security/.test(await proj.locator('.r3-proj-stage').innerText()), 'after blind bidding closes: Reveal Topic is offered and Reveal Question waits');
await pbtn('Reveal Topic').click();
await proj.locator('.r3-proj-label', { hasText: 'Security' }).waitFor();
check(!/CSRF/.test(await proj.locator('body').innerText()), 'Reveal Topic on the projector shows the topic; the question stays hidden');
await pbtn('Reveal Question (25 s)').click();
await proj.getByText('What does CSRF stand for?').waitFor();
await proj.mouse.move(640, 300);
await proj.getByRole('button', { name: 'Private notes' }).click();
await pdialog().getByText('Cross-site request forgery').waitFor();
check(/T2 .*25/s.test(await pdialog().locator('.r3-ranking').innerText()), 'Private notes (on demand) show the organiser the answer and the private scores');
await pdialog().getByRole('button', { name: 'Close', exact: true }).click();
await pdialog().waitFor({ state: 'detached' });
check(await projNoScores(), 'closing Private notes removes the private data from the screen');
await pbtn('Pass').click();
await pdialog().getByRole('button', { name: 'Confirm Outcome' }).click();
await pdialog().waitFor({ state: 'detached' });
await pbtn('Reveal Answer').click();
await proj.locator('.r2-ov-answer', { hasText: 'Cross-site request forgery' }).waitFor();
await pbtn('Complete Question → Next Question').click();
await proj.locator('.r3-proj-board').waitFor();
check(/Every question has been played/.test(await proj.locator('.r3-ctl').innerText()) && await scoreOf(2) === 25, 'Q5: highest bidder passed — no change; every question played');
check(await proj.getByRole('button', { name: 'Toggle fullscreen (F)' }).count() === 1, 'fullscreen control available on the projector');
await proj.screenshot({ path: join(SHOTS, 'r3-03-projector.png') });
check(await projNoScores(), 'after five questions the projector still shows no private scores');
await aud.close();

// --- End Auction and results
await btn('End Auction').click();
await host.getByRole('alertdialog').locator('input').fill('END');
await host.getByRole('alertdialog').getByRole('button', { name: 'End Auction' }).click();
await host.getByRole('heading', { name: /final ranking/ }).waitFor();
const ranking = await host.locator('.r3-ranking-lg li').allInnerTexts();
check(/^1\s*T2/.test(ranking[0]) && /^2\s*T1/.test(ranking[1]), `final ranking from private scores: ${ranking.map((r) => r.replace(/\s+/g, ' ')).join(' | ')}`);
await proj.getByText('Final results coming up').waitFor();
check(await projNoScores(), 'after the auction ends the projector still waits for the organiser to reveal results');
await host.getByRole('button', { name: /Reveal final rankings on the projector/ }).click();
await proj.getByRole('heading', { name: 'FINAL RESULTS' }).waitFor();
check(/T2 .*25/s.test(await proj.locator('.r3-final-list').innerText()), 'revealed: the projector shows the final ranking with scores');
await proj.screenshot({ path: join(SHOTS, 'r3-04-projector-final.png') });
await tab('Round 3 Results');
await host.getByRole('link', { name: 'Summary' }).first().click();
await host.getByRole('button', { name: /Export CSV/ }).waitFor();
const rows = await host.locator('table').first().locator('tbody tr').allInnerTexts();
check(rows.length === 3 && /T2 .*25/s.test(rows[0]), 'the session summary lists rank, team, final score and budget');

// --- phone width
const m = await ctx.newPage(); watch(m, 'phone');
await m.setViewportSize({ width: 390, height: 844 });
await m.goto(`${BASE}/host/rounds/3/sets`);
await m.locator('.round-tabs').waitFor();
const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check(overflow <= 1, `no horizontal page scroll in Round 3 at phone width (overflow ${overflow}px)`);

check(errors.length === 0, `no console/page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
await browser.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL ROUND 3 E2E CHECKS PASSED');
process.exit(failures ? 1 : 0);
