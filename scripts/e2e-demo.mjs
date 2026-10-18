// End-to-end smoke test of the full flow in LOCAL DEMO MODE using an installed
// Chrome/Edge (playwright-core, no browser download).
// Usage:  npm run build:demo && npm run preview:demo   (in another shell)
//         node scripts/e2e-demo.mjs [baseUrl] [screenshotDir]
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:4173';
const SHOTS = process.argv[3] || 'e2e-screenshots';
mkdirSync(SHOTS, { recursive: true });
const exe = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => existsSync(p));

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

const browser = await chromium.launch({ executablePath: exe, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const nav = (name) => page.locator('aside nav').getByRole('link', { name, exact: true }).click();
// Round 1 pages live under Rounds → Round 1 (tabs).
const ROUND1_TABS = { 'Quiz Sets': 'Quiz sets', 'Set setup & Join': 'Set setup & join', 'Live Host': 'Live host', 'Question Bank': 'Question bank', Leaderboard: 'Leaderboard' };
const r1 = async (tab) => {
  if (!(await page.locator('.round-tabs').count())) {
    await nav('Rounds');
    await page.getByRole('link', { name: 'Open Round 1' }).click();
  }
  await page.locator('.round-tabs').getByRole('link', { name: ROUND1_TABS[tab], exact: true }).click();
};
const confirmDialog = async (label, typed) => {
  const dlg = page.getByRole('alertdialog');
  await dlg.waitFor();
  if (typed) await dlg.locator('input').last().fill(typed);
  await dlg.getByRole('button', { name: label }).click();
  await dlg.waitFor({ state: 'detached' });
};

// Landing + login
await page.goto(BASE);
await page.getByText('THINK.').first().waitFor();
await shot(page, '01-landing');
check(await page.getByText('DEMO MODE · LOCAL ONLY').isVisible(), 'landing shows demo-mode badge');
await page.getByRole('link', { name: 'Organizer login' }).click();
await page.getByRole('button', { name: 'Enter demo console' }).click();
await page.getByRole('heading', { name: 'Organizer dashboard' }).waitFor();
await shot(page, '02-dashboard');
check((await page.locator('.mini-stat strong').first().textContent()) === '18', 'dashboard counts all registered teams (12 UG + 6 PG demo)');
check(await page.locator('aside nav a').count() === 5, 'sidebar has five sections');
check(await page.getByRole('button', { name: /Continue setup/ }).count() === 1, 'dashboard shows one next action for a draft set');
check(await page.getByRole('link', { name: 'Open Round 2' }).count() === 1, 'the Round 2 card links to its area');
check(await page.getByRole('link', { name: 'Open Round 3' }).count() === 0 && !(await page.locator('.page').innerText()).includes('Round 3'), 'no Round 3 card or text on the dashboard (Round 3 removed)');
check(await page.locator('.timer').count() === 0, 'no timer on the dashboard');

// Teams: add + duplicate prevention + search
await nav('Teams');
await page.getByRole('radio', { name: 'UG' }).click();
await page.getByRole('button', { name: 'Add UG team' }).click();
const modal = page.getByRole('dialog');
await modal.getByLabel('Team number').fill('1');
await modal.getByLabel('Team name').fill('Dup');
await modal.getByLabel('Participant 1').fill('X');
await modal.getByLabel('Participant 2').fill('Y');
await modal.getByLabel('College name').fill('Rehearsal College');
await modal.getByRole('button', { name: 'Save team' }).click();
check(await modal.getByText('Team number 1 is already in use in the UG section.').isVisible(), 'duplicate team number rejected');
await modal.getByLabel('Team number').fill('13');
await modal.getByLabel('Team name').fill('Real Team Thirteen');
await modal.getByRole('button', { name: 'Save team' }).click();
await modal.waitFor({ state: 'detached' });
check(await page.locator('tbody tr').count() === 13, 'team added (13 rows)');
await page.getByLabel('Search teams').fill('thirteen');
check(await page.locator('tbody tr').count() === 1, 'team search filters');
await shot(page, '03-teams');

// Questions
await r1('Question Bank');
await page.locator('.question-row').first().waitFor();
check(await page.locator('.question-row').count() === 60, '60 sample questions listed');
await page.getByRole('button', { name: 'Edit Q1', exact: true }).click();
await page.getByRole('dialog').waitFor();
await shot(page, '04-question-editor');
await page.getByRole('dialog').getByRole('button', { name: 'Close (draft kept)' }).click();

// Publish the UG draft set (whole 60-question bank) and go live.
// This script covers organizer paper entry; e2e-sets.mjs covers team devices, timers and ranking.
await r1('Set setup & Join');
await page.getByRole('button', { name: 'Publish set' }).click();
await confirmDialog('Publish & generate code');
await page.locator('.join-code-big').waitFor();
check(true, 'UG set published');
await r1('Live Host');
await page.getByRole('button', { name: 'Go live' }).click();
await confirmDialog('Go live');
await page.getByRole('button', { name: 'End set' }).waitFor();
check(await page.locator('.control-bar .timer').count() === 0, 'Live Host shows no set clock');
// paper answer entry is a folded fallback on Live Host
const openFallback = () => page.locator('details.live-fallback > summary').click();
await openFallback();
check(await page.getByText('Q1', { exact: false }).first().isVisible(), 'set is live; paper-entry navigator on Q1');

// Record: team 1 correct (key B), team 2 incorrect
async function record(team, letter) {
  await page.locator('.team-chip', { hasText: new RegExp(`^${team}`) }).first().click();
  await page.keyboard.press(letter);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
}
await record(1, 'B');
await record(2, 'A');
check(await page.locator('.team-chip.rec-correct').count() === 1, 'team 1 recorded correct');
check(await page.locator('.team-chip.rec-incorrect').count() === 1, 'team 2 recorded incorrect');
await shot(page, '05-live-host');

// Duplicate prevention in UI: team 1 again needs a correction + reason
await page.locator('.team-chip', { hasText: /^1/ }).first().click();
await page.keyboard.press('C');
await page.keyboard.press('Enter');
check(await page.getByText('Correction reason (required, audited)').isVisible(), 're-entering a recorded answer requires a correction reason');
check(await page.getByRole('button', { name: /Confirm correction/ }).isDisabled(), 'correction cannot be confirmed without reason');
await page.keyboard.press('Escape');

// Undo last (team 2)
await page.getByRole('button', { name: 'Undo last' }).click();
await confirmDialog('Undo');
await page.waitForTimeout(300);
check(await page.locator('.team-chip.rec-incorrect').count() === 0, 'undo removed team 2 answer');

// Emergency pause survives a reload of the organizer page
await page.getByRole('button', { name: 'Pause all teams' }).click();
await page.getByRole('button', { name: 'Resume' }).waitFor();
await page.reload();
await page.getByRole('button', { name: 'End set' }).waitFor();
await openFallback();
await page.getByRole('button', { name: 'Resume' }).waitFor();
check(true, 'paused state kept across reload');
await page.getByRole('button', { name: 'Resume' }).click();
await page.getByRole('button', { name: 'Pause all teams' }).waitFor();

// Projector never shows the key
const proj = await ctx.newPage();
await proj.goto(`${BASE}/projector`);
await proj.locator('.proj-progress').waitFor();
check(await proj.locator('.option-key').count() === 0, 'projector shows no answer key highlight');
const projText = await proj.locator('body').innerText();
check(!projText.includes('RAM loses its contents'), 'projector does not show the explanation');
check(projText.includes('60 questions') && projText.includes('own order'), 'projector shows set progress (each team has its own order)');
await shot(proj, '06-projector-question');

// Leaderboard on projector
await r1('Leaderboard');
await page.getByRole('button', { name: 'Show on projector' }).click();
await proj.locator('.proj-board').waitFor({ timeout: 15000 });
await shot(proj, '07-projector-leaderboard');
const firstRow = await page.locator('tbody tr').first().innerText();
check(/\b1\b/.test(firstRow) && firstRow.includes('Frost Byte'), 'leaderboard ranks team 1 first');
await shot(page, '08-leaderboard');

// End quiz → results → tie at cut-off → override → confirm → reveal
await r1('Live Host');
await page.getByRole('button', { name: 'End set' }).click();
await confirmDialog('End set', 'END');
await nav('Results');
await page.getByRole('heading', { name: /^Results — / }).waitFor();
check(await page.getByRole('status').filter({ hasText: 'Under review' }).count() === 1, 'results marked under review before qualifiers are confirmed');
check(await page.locator('.results-table tbody tr').count() === 13, 'results table lists every UG team with times and status');
await page.getByText('Unresolved tie at the cut-off').waitFor({ timeout: 5000 }).catch(() => {});
check(await page.getByText('Unresolved tie at the cut-off').isVisible(), 'unresolved tie at the cut-off is flagged');
check(await page.getByRole('button', { name: /Review & confirm/ }).isDisabled(), 'cannot confirm while tie unresolved');
const boxes = page.locator('.tie-pick input[type=checkbox]');
for (let i = 0; i < 4; i++) await boxes.nth(i).check();
await page.getByPlaceholder('e.g. Won buzzer tie-break question 2').fill('Rehearsal: buzzer round');
await shot(page, '09-results-tie');
await page.getByRole('button', { name: /Review & confirm/ }).click();
await confirmDialog('Confirm qualifiers', 'CONFIRM');
await page.getByRole('button', { name: 'Reveal on projector' }).click();
await confirmDialog('Reveal now');
await proj.locator('.proj-reveal').waitFor({ timeout: 15000 });
await proj.waitForTimeout(6500);
await shot(proj, '10-projector-reveal');
check(await proj.locator('.reveal-card').count() === 5, 'reveal shows 5 qualifiers');

// Mobile layout sanity
const m = await ctx.newPage();
await m.setViewportSize({ width: 390, height: 844 });
await m.goto(`${BASE}/host`);
await m.locator('.page').waitFor();
await m.getByRole('button', { name: 'Open menu' }).click();
await m.locator('aside nav').getByRole('link', { name: 'Rounds', exact: true }).click();
await m.getByRole('link', { name: 'Open Round 1' }).click();
await m.locator('.round-tabs').waitFor();
const overflowR1 = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check(overflowR1 <= 1, `no horizontal scroll on the Round 1 page at phone width (overflow ${overflowR1}px)`);
await m.screenshot({ path: join(SHOTS, '12-mobile-round1.png') });
// Set wizard at phone width: new PG set, CSV import (invalid file blocked, valid file added), cancel discards.
m.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
const mNext = () => m.locator('.wizard-footer').getByRole('button', { name: 'Next' }).click();
await m.goto(`${BASE}/host/rounds/1/new`);
await m.getByLabel('Quiz title').fill('PG Phone Set');
await m.getByRole('radio', { name: /^PG/ }).click();
await mNext();
await m.locator('.wz-qlist').waitFor();
check(/Step 2 · Questions/.test(await m.locator('.wz-step-title').innerText()), 'phone: wizard creates the PG draft and opens the questions step');
await m.getByRole('button', { name: 'Remove all' }).click();
await m.getByRole('alertdialog').getByRole('button', { name: 'Remove all' }).click();
check(await m.locator('.count-meter').getByText('Add at least one question.').count() >= 1, 'phone: empty selection explained (no minimum or maximum shown)');
const HEAD = 'question_text,option_a,option_b,option_c,option_d,correct_option\n';
const csvFile = (name, body) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(HEAD + body) });
await m.locator('input[type=file][aria-label="Question CSV file"]').setInputFiles(csvFile('bad.csv', 'Phone Q1?,a,b,c,d,A\nPhone Q2?,a,a,c,d,\n'));
const imp = m.getByRole('dialog');
await imp.waitFor();
check(/Line 3:/.test(await imp.getByRole('alert').innerText()) && await imp.getByRole('button', { name: /^Import/ }).isDisabled(), 'phone: invalid CSV row reported by line and import blocked');
await imp.getByRole('button', { name: 'Cancel' }).click();
await m.locator('input[type=file][aria-label="Question CSV file"]').setInputFiles(csvFile('good.csv', 'Phone Q1?,w,x,y,z,A\nPhone Q2?,p,q,r,s,D\n'));
await m.getByRole('dialog').getByRole('button', { name: 'Import 2 question(s)' }).click();
await m.locator('.count-meter', { hasText: '2 questions in this set' }).waitFor();
check(await m.locator('.wz-qlist li').count() === 2 && /Answer D/.test(await m.locator('.wz-qlist li').nth(1).innerText()), 'phone: imported CSV questions added to the set with their answers');
const overflowWz = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check(overflowWz <= 1, `phone: no horizontal scroll in the set wizard (overflow ${overflowWz}px)`);
await m.screenshot({ path: join(SHOTS, '13-mobile-wizard.png'), fullPage: true });
await m.locator('.wizard-footer').getByRole('button', { name: 'Cancel' }).click();
await m.getByRole('alertdialog').getByRole('button', { name: 'Discard changes' }).click();
await m.getByRole('heading', { name: 'Quiz sets' }).waitFor();
check(true, 'phone: Cancel asks before discarding unsaved changes, then returns to the quiz sets');
await m.goto(`${BASE}/host`);
await m.locator('.page').waitFor();
const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check(overflow <= 1, `no horizontal scroll on mobile (overflow ${overflow}px)`);
await m.screenshot({ path: join(SHOTS, '11-mobile-dashboard.png') });

check(errors.length === 0, `no console/page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
await browser.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL E2E CHECKS PASSED');
process.exit(failures ? 1 : 0);
