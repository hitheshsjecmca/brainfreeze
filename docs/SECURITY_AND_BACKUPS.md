# Security and backups

## Threat model

| Actor | Can do |
|---|---|
| Audience | Sees only the projector, which never receives answer keys. |
| Team device (no account, `anon` role) | Only the 8 participant functions. To act for a team it needs the set's active **join code + team number + team PIN**, which yields a device token bound to that one team in that one set. With the token it can read its own attempt (instructions, its own question order and option order, its own answers, its own server deadline), press Start, submit **one** answer per question before its deadline, and Submit quiz. It cannot read any table, another team's attempt, keys, explanations, points or correctness, and cannot change deadlines, timestamps, scores or its section. |
| Anyone on the internet with the URL | Load the static app and the sign-in page. Without an organizer account: **no** table reads and **no** RPC calls, because `anon` has every privilege revoked. |
| Registration staff (authenticated + in `registration_staff`) | Only the registration desk: `reg_overview` (teams, colleges, PINs, a per-team "locked" flag and each section's team count and number of live sets — no questions, keys, answers, attempts or scores) and `reg_save_team` (create a team; edit a team that has not started a quiz; never the demo flag). RLS returns **0 rows** from every table, including `set_questions` and `quiz_attempts`; every organizer RPC (create/publish sets, timer, scoring, go live, attempts, corrections, results) raises `NOT_AUTHORIZED`. Every change is logged in `registration_events`. |
| A signed-in user who is in neither list | Nothing. RLS returns 0 rows, and every RPC raises `NOT_AUTHORIZED`. |
| Organizer | Everything, through validated RPCs only. Each score change is audited. |

## Controls

**Row Level Security** is enabled on every table (including `set_questions` and `quiz_attempts`, added in migration 6).
- `authenticated` gets `SELECT` only, and the policy restricts rows to `is_organizer()`.
- `anon` has no grants at all.

**No direct writes.**
- `INSERT`, `UPDATE` and `DELETE` are revoked from all API roles.
- All changes go through `SECURITY DEFINER` functions with `search_path = ''`. Each one:
  1. checks organizer membership;
  2. validates its input;
  3. locks the current session row, so concurrent calls are serialized;
  4. computes the score from `question_keys`.

**Answer-key isolation.**
- Keys and explanations are stored in `question_keys`, separate from `questions`.
- A published set's frozen copy, including its keys, lives in `set_questions` (organizer-only).
- The projector only selects the public columns of `questions` / `set_questions` (never the key) plus the aggregate `get_standings()`. A contract test checks this.
- Neither `question_keys` nor `set_questions` is added to the Realtime publication.

**Never trust the client.**
- The client sends only `(request_id, team_id, question_id, selected option)`.
- The points, the result, and whether the quiz is still accepting answers (time window, ended, finalized) are all decided in SQL.

**Function grants.**
- `EXECUTE` is revoked on every function in `public` from `public`, `anon` and `authenticated`.
- Only the RPC surface is re-granted, and only to `authenticated`.
- The internal helpers (`_err`, `_standings`, `_rescore_question`, …) can't be called through the API.

**Audit log.**
- `score_events` is append-only, enforced by a trigger that blocks updates and deletes even for the table owner.
- The only permitted change is flipping `undone` from false to true.
- It records corrections (with reasons), undos, re-scores after key edits, deletions, corrections authorization, tie-breaks, qualifier confirmation, reopen and restore.

**Idempotency.** `score_events.request_id` is unique, so a retried request returns the original result instead of scoring twice.

**Secrets.**
- The browser bundle contains only `VITE_SUPABASE_URL` and the anon/publishable key, both of which are public by design.
- The app refuses to start if it detects a `service_role` JWT or an `sb_secret_` key in its environment.
- The service-role key is never needed by the app.

**Auth hardening** (configure this in Supabase):
- disable public sign-ups;
- create organizer users manually;
- use strong passwords;
- optionally enable MFA.

**HTTP headers** come from `vercel.json`:
- `X-Frame-Options: DENY`
- `nosniff`
- `Referrer-Policy`
- `Permissions-Policy`
- `noindex`

**CSV exports** prefix cells that start with `=`, `+`, `-` or `@` with `'`, to prevent formula injection in spreadsheets. Imports strip that prefix again.

## Quiz sets, attempts and timers (migration 6)

| Threat | Control |
|---|---|
| Joining a draft or a different set | `_quiz_by_code` matches only a **published**, active, non-archived, not-ended set with that exact code. Codes are unique across UG and PG (unique index + server-side retry on collision) and never reused, so a revoked or expired code can never open another set. |
| Joining from the wrong section | `join_team` looks the team up only in the set's section; a PG number/PIN never matches a UG set. |
| Taking two sets of a section | `_team_other_set` refuses `join_team` and `record_answer` (`TEAM_IN_OTHER_SET`) while the team has an attempt or answers in another active set of its section. Only an organizer reset or archive frees it. |
| Duplicate attempts | One non-reset attempt per (set, team), enforced by a unique index; reconnecting resumes the same attempt. Resets keep the old attempt (status `reset`, who, when, reason) and log `attempt_reset` with the removed points. |
| Reading another team's attempt | Participant functions take no team or attempt id: everything comes from the device token. `quiz_attempts` is organizer-only under RLS. |
| Predicting or choosing the question order | Orders are generated in the database (`gen_random_uuid()`), stored with the attempt, and never accepted from the browser. The device only sends a position in its own order and the letter it saw. |
| Learning the key from the option order | The device receives options already permuted; the permutation and key stay on the server. The submitted letter is mapped back to the original option in SQL, and scoring uses the frozen key. |
| Extending the time | `started_at` / `deadline_at` are written only by the database (`now()`); Start is idempotent. Answers are refused at or after the deadline (`TIME_EXPIRED`), checked inside `participant_submit`. Expired attempts are finalized at the deadline itself by any read (`_finalize_expired`) and optionally by pg_cron. A device clock or an offline device changes nothing. |
| Changing a published set | `update_quiz_details` / `update_settings` raise `SET_FROZEN` after publishing; bank edits never touch `set_questions`; bank questions in a published set cannot be deleted. A wrong key is fixed only by `correct_set_question` (reason required, audited `key_change` + `rescore` events). |
| Silent score or time changes | Scores, submission times and completion statuses change only through audited RPCs (`record`, `correction`, `undo`, `rescore`, `key_change`, `attempt_finalize`, `attempt_reset`, `tiebreak`). `score_events` is append-only. Ranking is computed, never stored or edited. |
| Selecting a set by header | `x-brainfreze-set` only chooses which set an **already-authorized organizer** acts on; it is not a security boundary. A malformed id is rejected; participants ignore it. |

## Sections and the registration desk (migration 5)

| Threat | Control |
|---|---|
| Staff changing the quiz | Staff are not organizers: `_require_organizer()` rejects them on every quiz RPC (questions, keys, scoring, timers, sessions, publishing, backups). Tested call by call in PGlite. |
| Staff reading answer keys or scores | No table rows (RLS on `is_organizer()`), and `reg_overview` returns only team fields, PINs and section status. |
| Late registration changes | Since migration 6, `reg_save_team` refuses to edit a team that has started a quiz (an attempt beyond "ready", or recorded answers, in an active set) with `REGISTRATION_LOCKED`. New teams can always be added. |
| Untraceable edits | `registration_events` is append-only (trigger blocks updates/deletes) and records actor, role and each changed field. Organizers can read it; staff cannot. |
| A team joining the wrong section | Team lookup in `join_team` is limited to the code's section; numbers alone never identify a team (PIN required). |
| Wrong section targeted by an organizer | The section comes from the `x-brainfreze-section` header, set by the app on every organizer call; an unknown value is rejected. It is a selector for an already-authorized organizer, not a security boundary. |
| Predicting a team's question order | Since migration 6, orders are random per attempt (see above), not derived from ids. |

## Participant joining (migration 4)

| Threat | Control |
|---|---|
| Guessing a join code | 10^6 codes; only active quizzes match; failed attempts rate-limited (30 per 10 min per client IP, 600 per minute globally). The code alone is useless without a team PIN. |
| Impersonating a team by name or number | Sign-in needs the team's PIN (6 characters from a 31-symbol alphabet ≈ 8.9 × 10^8 combinations). Wrong team and wrong PIN give the same error. |
| Taking over a connected team | Refused while that team's device is active (seen in the last 45 s); afterwards the PIN moves the team and revokes the old token. The organizer can disconnect devices and issue new PINs. |
| Stolen or guessed device token | 256-bit random token; only its SHA-256 hash is stored; bound to one team in the **current** session; expires after 12 h, on new session or on unpublish; revocable. |
| Stale codes reaching a new quiz | Codes are never reused: every code ever issued is excluded from future generation. |
| Scoring manipulation | The browser sends only the option. The database checks: quiz running, deadline (database clock), current question, question not closed, one answer per team per question, and request-ID idempotency (a request ID from another team is rejected). Scores come from `question_keys`. |
| Data leakage | Participant responses contain no keys, explanations, points or correctness; covered by tests, including one that deliberately injects a leak to prove detection. Teams see only their **own** rank and score, and only after the reveal. |
| Participants calling organizer functions | `anon` has EXECUTE only on the 6 participant functions. Every other function is revoked; tested in PGlite. |
| PIN exposure | PINs live in `team_credentials`: RLS on, readable only by organizers, not published to Realtime. PIN-slip CSVs and JSON backups contain them, so keep both private. |

**Assumptions to verify on the live project:**
- The client IP for rate limiting comes from the `cf-connecting-ip`, `x-real-ip` or `x-forwarded-for` request header. If Supabase doesn't pass it, all clients share one bucket.
- Public broadcast channels may be disabled; that only affects instant refresh, since polling continues.

## Things you must still do
- Never commit `.env.local`, backups or real question files to a public repository.
- Rotate the anon key if you ever suspect it was paired with a leaked organizer password, and remove ex-organizers from `public.organizers`.
- Apply migrations 4, 5 and 6 (after a database backup and a JSON backup) and rehearse the desk, quiz sets, the Start/countdown/Submit flow and a timeout with real devices before the event.
- Optionally schedule `select public.finalize_all_expired();` with pg_cron (attempts are finalized on read anyway).
- Give registration-staff accounts only to desk volunteers; they can see team PINs.
- Rehearse on a staging Supabase project. The SQL has been executed and tested in PGlite, but not against a live Supabase project from this environment.

## Backups

| What | Where | Contains |
|---|---|---|
| JSON backup (format 3) | Settings → Download JSON backup | **Every quiz set, archived ones included:** each set's session and settings, its frozen questions **with answer keys**, and its team attempts (question/option orders, start, deadline, paused time, finish, status, resets); teams (with section and college), **team PINs**, the question bank **with answer keys**, answers (with attempt, displayed letter and on-time flag), audit log, tie-breaks. Format 1 and 2 files still restore. |
| Registrations CSV | Results | Section, team, participants, college, self-registered, registered at (no PINs) |
| Scores & ranks CSV | Results / Leaderboard / Settings | Set, rank, team, participants, college, score, counts, attempt status, start, finish, elapsed, time limit, tie review, tie-break, qualification status |
| Completion times CSV | Results | Per team: status, start and final submission (UTC and event time), elapsed, limit, rank |
| Submission audit CSV | Results | Every accepted answer: set, attempt, team, set and team question number, displayed and original option, result, points, source, server timestamp (UTC and event time), on time, request id |
| Answers CSV / Audit CSV | Settings | Every recorded answer; every audit event |

- **Restore** (Settings → Restore from backup):
  - validates the file;
  - shows a summary;
  - requires typing `RESTORE`;
  - **downloads a backup of the current data first**;
  - then replaces everything.

  A set that was live at backup time is restored as **paused**; the time between its last running moment and the restore counts as paused time, so team deadlines are not lost. Restored sets never have an active join code.
- **Automatic safety backups** also download before you remove demo data, reset demo mode, archive a set and start a new draft copy, or restore.
- **Recommended cadence:**
  - before the event;
  - when the timer ends;
  - after all sheets are entered;
  - after qualifiers are confirmed.
- **Keep backup files private**, because they contain the answer keys.

## Reliability

- **Supabase mode:**
  - Realtime pushes changes to every open window.
  - A 20-second poll and a refresh when the tab becomes visible cover missed events.
  - When Realtime drops, the top bar shows the status changing from **Live sync** to **Realtime lost · polling** or **OFFLINE**.
- **Recorded answers are never silently lost:**
  - A failed network call stores the answer in a persistent on-device outbox, which survives a refresh. It retries with the **same** request ID, so it is idempotent.
  - Rejected items, such as one that another organizer already recorded, stay listed for review.
- **Duplicate clicks** are ignored while the same action is in flight, and undo retries reuse their request ID.
- **Demo mode** writes every action to IndexedDB immediately, as one transaction, so several open tabs never overwrite each other. If the browser refuses the write (for example, storage is full), the action fails visibly instead of pretending to succeed.
