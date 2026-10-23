// End-to-end (LOCAL DEMO MODE): fresh quiz sets, Save & Next with 2–6 options, the question count inside the
// editor, importing from previous sets, and participant self-join (code → verified section → name + college).
//   npm run build:demo && npm run preview:demo     (serves http://localhost:4173)
//   node scripts/e2e-fresh-join.mjs [baseUrl] [screenshotDir]
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
const dialog = () => org.getByRole('dialog');
const count = () => dialog().locator('.editor-count').innerText();
const fillOptions = async (texts) => { for (const [i, t] of texts.entries()) await dialog().getByLabel(`Option ${'ABCDEF'[i]}`, { exact: true }).fill(t); };
const confirmDialog = async (label) => {
  const dlg = org.getByRole('alertdialog');
  await dlg.waitFor();
  await dlg.getByRole('button', { name: label }).click();
  await dlg.waitFor({ state: 'detached' });
};
const next = () => org.locator('.wizard-footer').getByRole('button', { name: 'Next' }).click();
const tab = (name) => org.locator('.round-tabs').getByRole('link', { name, exact: true }).click();

// --- landing: Join Quiz and Organizer Login only
await org.goto(`${BASE}/`);
await org.getByRole('link', { name: /Join Quiz/ }).waitFor();
check(await org.getByRole('link', { name: /Registration Desk/ }).count() === 0, 'landing page has no Registration Desk');
check(await org.getByRole('link', { name: /Organizer Login/ }).count() === 1, 'landing page keeps Organizer Login');
check(/UG & PG/.test(await org.locator('.fact-grid').innerText()), 'landing page keeps the UG/PG distinction');
await org.screenshot({ path: join(SHOTS, 'f00-landing.png') });
await org.goto(`${BASE}/registration/login`);
await org.waitForURL(`${BASE}/`);
check(true, 'old registration desk links lead home');

// --- organizer: a new set starts empty
await org.goto(`${BASE}/login`);
await org.getByRole('button', { name: 'Enter demo console' }).click();
await org.locator('.page').waitFor();
await org.locator('aside nav').getByRole('link', { name: 'Rounds', exact: true }).click();
await org.getByRole('link', { name: 'Open Round 1' }).click();
await tab('Quiz sets');
await org.getByRole('link', { name: 'New quiz set' }).click();
await org.getByLabel('Quiz title').fill('Fresh UG Set');
await org.getByRole('radio', { name: /^UG/ }).click();
await next();
await org.getByText('No questions in this set yet').waitFor();
check(/^0\s*questions in this set/.test(await org.locator('.count-meter').innerText()), 'a new set starts with 0 questions (no bank questions copied)');
check(await org.getByRole('button', { name: /Choose from bank/ }).count() === 0, 'no automatic "Choose from bank" selection');

// --- Save & Next: 4, then 2, then 6 options
await org.getByRole('button', { name: 'Add question', exact: true }).click();
await dialog().waitFor();
check(/Questions in this set: 0/.test(await count()) && /New question — Question 1/.test(await count()), 'editor shows the count: 0 saved, new question 1');
check(await dialog().locator('.option-edit').count() === 4, 'a new question starts with four options');
await dialog().getByLabel('Question text').fill('Which protocol resolves domain names?');
await fillOptions(['HTTP', 'DNS', 'FTP', 'SMTP']);
await dialog().getByLabel('Option B is correct').check();
await dialog().getByRole('button', { name: /Save & Next/ }).click();
await dialog().locator('.editor-count', { hasText: 'Questions in this set: 1' }).waitFor();
check(/New question — Question 2/.test(await count()), 'Save & Next saved question 1 and opened question 2');
check(await dialog().getByLabel('Question text').inputValue() === '' && await dialog().locator('.option-edit').count() === 4, 'the next question starts clean with four options');

await dialog().getByRole('button', { name: 'Remove option D' }).click();
await dialog().getByRole('button', { name: 'Remove option C' }).click();
check(await dialog().locator('.option-edit').count() === 2, 'options can be removed down to two');
check(await dialog().getByRole('button', { name: 'Remove option B' }).isDisabled(), 'removing is disabled at two options');
await dialog().getByLabel('Question text').fill('HTTP is stateless.');
await fillOptions(['True', 'False']);
await dialog().getByLabel('Option A is correct').check();
await dialog().getByRole('button', { name: /Save & Next/ }).click();
await dialog().locator('.editor-count', { hasText: 'Questions in this set: 2' }).waitFor();

await dialog().getByRole('button', { name: 'Add Option' }).click();
await dialog().getByRole('button', { name: 'Add Option' }).click();
check(await dialog().locator('.option-edit').count() === 6, 'options can be added up to six (A–F)');
check(await dialog().getByRole('button', { name: 'Add Option' }).isDisabled(), 'Add Option is disabled at six');
await dialog().getByLabel('Question text').fill('Which is NOT a programming language?');
await fillOptions(['Python', 'Rust', 'Kotlin', 'Linux', 'Go', '']);
await dialog().getByLabel('Option F is correct').check();
check(await dialog().locator('.editor-preview .option-tile').count() === 6, 'projector preview shows six options live');
check(await dialog().locator('.editor-preview .option-key').count() === 0, 'projector preview never shows the correct answer');
await dialog().getByRole('button', { name: 'Save Question' }).click();
check(await dialog().getByText(/Not saved: Option F is required/).count() === 1, 'an empty option blocks the save with a clear message');
check(await dialog().getByLabel('Question text').inputValue() === 'Which is NOT a programming language?', 'a failed save keeps the typed question');
await dialog().getByRole('button', { name: 'Remove option F' }).click();
check(await dialog().getByLabel('Option F is correct').count() === 0 && !(await dialog().getByLabel('Option D is correct').isChecked()), 'removing the correct option clears the key');
await dialog().getByLabel('Option D is correct').check();
await org.screenshot({ path: join(SHOTS, 'f01-editor-five-options.png') });
await dialog().getByRole('button', { name: 'Save Question' }).click();
await dialog().waitFor({ state: 'detached' });
check(/^3\s*questions in this set/.test(await org.locator('.count-meter').innerText()), 'Save Question closes the editor; the set has 3 questions');
check(await org.locator('.wz-qlist .badge-new').count() === 3, 'newly written questions are marked New');

// --- import from previous sets (copies)
await org.getByRole('button', { name: 'Add Questions from Previous Sets' }).click();
await dialog().locator('.import-set').first().waitFor();
await dialog().locator('.import-q input[type=checkbox]').first().check();
await dialog().locator('.import-q input[type=checkbox]').nth(1).check();
await org.screenshot({ path: join(SHOTS, 'f02-import-previous.png') });
await dialog().getByRole('button', { name: 'Import 2 questions' }).click();
await dialog().waitFor({ state: 'detached' });
await org.locator('.count-meter', { hasText: '5' }).waitFor();
check(await org.locator('.wz-qlist .badge-import').count() === 2, 'imported questions are marked Imported');
await org.getByRole('button', { name: 'Add Questions from Previous Sets' }).click();
await dialog().locator('.import-set').first().waitFor();
check(await dialog().locator('.import-q.is-in input:disabled').count() >= 2, 'already-imported questions cannot be imported twice');
await dialog().getByRole('button', { name: 'Cancel' }).click();
await org.screenshot({ path: join(SHOTS, 'f03-questions-step.png') });

// --- rules, publish
await next();
await org.getByLabel(/Time limit per team/).fill('10');
await next();
await org.getByText(/Ready to publish/).waitFor();
await org.getByRole('button', { name: 'Publish set' }).click();
await confirmDialog('Publish & generate code');
const code = (await org.locator('.join-code-big').textContent()).replace(/\s/g, '');
check(/^\d{6}$/.test(code), `published with code ${code}`);

// --- participant: code → verified section → details → waiting room
const p = await ctx.newPage(); watch(p, 'participant');
await p.goto(`${BASE}/join`);
await p.getByLabel('Six-digit join code').fill('999999');
await p.getByRole('button', { name: 'Continue', exact: true }).click();
await p.getByText(/That code is not valid/).waitFor();
check(true, 'an invalid code is refused with a clear error');
await p.getByLabel('Six-digit join code').fill(code);
await p.getByRole('button', { name: 'Continue', exact: true }).click();
await p.getByText('Verified section:').waitFor();
check(/Verified section:\s*UG/.test(await p.locator('.verified-section').innerText()), 'the section is verified from the code');
check(await p.getByRole('combobox').count() === 0 && await p.getByRole('radio').count() === 0, 'no team list and no section choice for participants');
await p.getByRole('button', { name: /Join quiz/ }).click();
check(await p.getByText('Enter your full name.').count() === 1 && await p.getByText('Enter your college name.').count() === 1, 'name and college are required');
await p.getByLabel('Full name').fill('  Asha   Rao ');
await p.getByLabel('College name').fill('St Joseph Engineering College');
await p.screenshot({ path: join(SHOTS, 'f04-join-details.png') });
await p.getByRole('button', { name: /Join quiz/ }).click();
await p.getByText(/Waiting for the organizer/).waitFor();
check(/Asha Rao/.test(await p.locator('.lobby-team').innerText()) && /Verified section: UG/.test(await p.locator('.lobby-team').innerText()), 'waiting screen shows the participant, college and section');
await p.reload();
await p.getByText(/Waiting for the organizer/).waitFor();
check(true, 'a refresh keeps the participant signed in');

// --- organizer goes live (no pre-registered teams needed); participant answers
await tab('Live host');
await org.getByRole('button', { name: 'Go live' }).click();
await confirmDialog('Go live');
await p.getByRole('button', { name: 'Start the quiz' }).click();
await p.locator('.play-question').waitFor();
const tiles = await p.locator('.play-options .option-tile').count();
check([2, 4, 5].includes(tiles), `the question shows only its own options (${tiles})`);
await p.locator('.play-options .option-tile').first().click();
await p.getByText(/saved/).first().waitFor();
await p.reload();
await p.locator('.play-question').waitFor();
check(await p.locator('.play-timebar').count() === 1, 'after a refresh the timer and question come back');
await p.screenshot({ path: join(SHOTS, 'f05-participant-question.png') });
await p.getByRole('button', { name: 'Submit Quiz' }).click();
await p.getByRole('button', { name: 'Submit now' }).click();
await p.getByText('Quiz submitted').waitFor();

// --- leaderboard: name, college, section
await tab('Leaderboard');
await org.locator('.leaderboard-table').waitFor();
const board = await org.locator('.leaderboard-table').innerText();
check(/Asha Rao/.test(board) && /St Joseph Engineering College/.test(board) && /UG/.test(board), 'leaderboard shows name, college and section');
await org.screenshot({ path: join(SHOTS, 'f06-leaderboard.png') });

// --- phone width: the editor stays usable
// (same browser context: demo data lives in this browser only)
const m = await ctx.newPage(); watch(m, 'phone');
await m.setViewportSize({ width: 390, height: 844 });
await m.goto(`${BASE}/join`);
await m.getByLabel('Six-digit join code').fill(code);
await m.getByRole('button', { name: 'Continue', exact: true }).click();
await m.getByText('Verified section:').waitFor();
check(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'join page has no horizontal scroll on a phone');
await m.screenshot({ path: join(SHOTS, 'f07-phone-join.png') });

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
await browser.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
