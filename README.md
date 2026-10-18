# BRAINFREZE — COLD START

**JOSHIANA 15.0 · WINTER ARC — Round 1: MCQ Elimination Round**
*THINK. DECODE. COMPETE.*

A live quiz platform for Round 1. Teams of two register in a **section, UG or PG** (up to 50 teams per section). Organizers build any number of **quiz sets** per section. Each set has:
- any number of questions (at least one) chosen from the shared question bank;
- its own timer and scoring rules;
- its own six-digit join code once published;
- its own team attempts, answers, results and audit trail.

Answers reach the system in two ways. Both are scored in the database against the set's private answer key:

1. **Team devices.** A team opens `/join` on an organizer-provided device and enters the set's code, its team number and its team PIN.
   - The team reads the instructions and presses **Start**.
   - The server records the start time and the deadline (start + the set's time limit).
   - Every team gets its **own random question order and option order**, generated and stored by the server.
   - The team can **Submit quiz** early. At the deadline the attempt closes automatically.
2. **Paper.** The organizer records answers from answer sheets on the Live Host page, as before.

There are three separate consoles:
- **Registration desk** (`/registration/login`): registration staff create, view, search and edit teams (section, team number, team name, both participants, college). A team's registration locks once that team has started a quiz. Staff **cannot** touch quiz sets, questions, answer keys, scoring, timers, attempts or results.
- **Organizer console** (`/login`): quiz sets, publishing, going live, pause/resume, end, results, corrections, qualification and the projector reveal.
- **Team devices** (`/join`): no accounts.

> **Scope:** Round 1 (COLD START) and Round 2 (MIND MELTDOWN, the host-controlled trivia board) are implemented. Round 3 (THE KNOWLEDGE AUCTION) has been removed from the application (see *Round 3 — removed* below); its migrations 13 and 14 stay in the migration history.

> **Modes**
> - **Supabase mode** — the live event. Organizer login, database-side scoring, Row Level Security, and live sync.
> - **Local demo mode** — rehearsals only. Data stays in one browser (IndexedDB). There is no login and no server-side protection. Participant pages work only in **other tabs of the same browser**. It is labelled on every screen.
> - **A production build will not start in demo mode by accident.** Without valid Supabase settings it shows a configuration error, unless it was deliberately built as a demo (`npm run build:demo`).

---

## Contents
1. [Event flow](#event-flow)
2. [Screens and routes](#screens-and-routes)
3. [Architecture and security model](#architecture-and-security-model)
4. [Database migrations](#database-migrations)
5. [Local development and testing](#local-development-and-testing)
6. [Supabase setup (manual steps)](#supabase-setup-manual-steps)
7. [GitHub and Vercel](#github-and-vercel)
8. [Scoring, timer and ranking rules](#scoring-timer-and-ranking-rules)
9. [Event-day runbook](#event-day-runbook)
10. [What has been verified](#what-has-been-verified)
11. [Known limitations](#known-limitations)

Security and backups are covered in [docs/SECURITY_AND_BACKUPS.md](docs/SECURITY_AND_BACKUPS.md).

---

## Event flow

**Registration staff (registration desk):**
1. Sign in at `/registration/login` with a registration-staff account.
2. **Register team** for each arriving team. Enter:
   - the section (UG/PG);
   - the team number (unique within the section);
   - the team name, participant 1, participant 2 and college.

   The desk shows the team's private **PIN** to hand over with its slip.
3. Search and edit registrations. A team that has started a quiz is shown as **locked**; ask an organizer to change it. New teams can always be registered.

**Organizer:** the sidebar has five sections: **Dashboard, Rounds, Teams, Results, Settings & Backup**.
- The **Dashboard** shows one *Next step* button, a few counts taken from real data, the event flow (Round 1 → top 5 → Round 2 → Round 2 results) and the two round cards.
- **Rounds → Round 1** contains every Round 1 page as tabs: Overview, Quiz sets, Set setup & join, Live host, Question bank and Leaderboard. Its header holds the **quiz set picker** (per browser tab, so two tabs can run two sets), the set's section/stage/code and the single **Projector** button.
- **Rounds → Round 2** is the MIND MELTDOWN trivia board (described below).

1. **Rounds → Round 1 → Quiz sets → New quiz set** opens a four-step wizard. Duplicate, delete (drafts only) or archive sets on the same tab.
2. **The wizard** (one step on screen at a time; *Back*, *Next*, *Save draft* and *Cancel* at the bottom):
   1. **Basic details:** quiz title and UG/PG section (optional: instructions for teams, walk-in self-registration). *Next* creates the draft.
   2. **Questions:** a counter shows how many questions the set has (there is no minimum or maximum). Add a question (with its correct answer), choose questions from the shared bank, or import a CSV (a template is provided). Every row is checked with its line number, and an invalid file is never imported; duplicates are reused, not imported twice. You can also preview, edit, reorder and remove questions. *Next* is refused only while the set has no questions or a question has no valid answer.
   3. **Rules:** time limit per team (any positive number of minutes, default 30), marks (default +1 / −0.25 / 0) and the number of qualifiers (default 5), with *Restore defaults*. The ranking and timing rules are shown here.
   4. **Review & publish:** a summary of every setting and a list of anything that blocks publishing. **Publish set** freezes the questions, answers, option mapping, timer and scoring and generates a unique six-digit code, shown with a **Copy code** button. Teams can join and read the instructions, but cannot start yet.

   *Next* and *Save draft* store everything on the set itself, so the draft can be resumed later from **Quiz sets → Continue setup** (also on another device). Unsaved edits are also kept in this browser, and the wizard reopens at the step where you left off. After publishing, **Set setup & join** shows the published set: join code, registration, PIN slips, frozen questions and team devices.
3. Download the **Team PIN slips** CSV and hand each team its slip.
4. Watch **Team devices & attempts**:
   - who has signed in and who is connected;
   - each team's attempt status;
   - the team's remaining time;
   - its progress.
5. **Live host → Go live.** Joined teams can now press **Start**; each team's own timer starts at that moment.
6. If needed:
   - **Pause all** freezes every running team timer. **Resume** moves each team's deadline by the paused time.
   - **Finalize attempt** ends one team's attempt now, with a reason.
   - **Reset attempt** (audited, with a reason) removes the team's answers in that set and gives it a fresh attempt.
7. **End set.** Teams still answering are organizer-finalized; the code expires.
8. **Results** (Round 1 tab, pick the set; marked *Provisional*, *Under review* or *Finalized*):
   - per-team score, correct/incorrect/unanswered, start, final submission, elapsed time, completion status, rank and tie-review flag;
   - **Attempt detail** for any team (per-question answers, the letter the team saw, server timestamps);
   - CSV exports;
   - then tie-breaks, confirm the top 5 and **Reveal**.

**Team on its device:**
1. Open `/join` and enter the set's six-digit code. Paste works, and phones show a numeric keypad.
2. Enter the team number and PIN from the slip.
   - A team from the other section never works with this code.
   - A team that already takes part in another set of its section is refused (`TEAM_IN_OTHER_SET`).
   - If the organizer allowed walk-ins, a new team can register (including its college) and is shown its new PIN.
3. **Instructions:** team, members, set title and instructions, number of questions, time limit, marks, and how the deadline works. **Start the quiz** appears once the organizer goes live.
4. **Question screen:**
   - the question in the team's own order, four options in the team's own order, and the team's countdown;
   - a navigator (answered questions marked — never right or wrong);
   - **Submit answer** locks one answer per question;
   - **Submit quiz** finishes early. The server records the final time.

   Refreshing, reconnecting or switching tabs never restarts or extends the countdown.
5. **Paused** → the timer is frozen. **Deadline reached** → TIME'S UP; answers after the deadline are refused. **Organizer ended the set** → "Quiz closed". After the reveal, the team sees **its own** rank and score only.

---

### Round 2 — MIND MELTDOWN (trivia board)

Organizer-controlled and shown on the projector; teams do not use devices in this round.

1. **Questions tab:** add any number of topics, and any number of questions per topic. Each question has a point value, the question and its answer. A question that was already played is locked.
2. **Teams & rules tab:**
   - Pick the Round 2 roster. **Add Round 1 qualifiers** suggests only qualifiers an organizer has already confirmed; nobody is added automatically.
   - Set the question timer (default **18 s**). Since migration 16 a wrong answer scores **0**; the old wrong-answer penalty setting is no longer used.
3. Open the **Projector** (`/projector/round2`): the board and the point tiles (played ones marked). It never shows scores; the organiser can play the game directly on it (see migration 11).
4. **Game board tab:**
   - **Click a tile.** A panel shows only the topic and points; the question stays hidden on the projector too. **Cancel** returns it unused.
   - **Reveal Question:** the question appears and the 18-second countdown starts from the server time. At zero it shows *Time's up* and awards nothing.
   - **Answer:** shows the stored answer on the projector. It never changes a score. *Peek* shows it on the host screen only.
   - **Right** or **Wrong:** opens **"Which Team Answered?"**. Choose exactly one team and press **Confirm**; a summary shows the question, the team, Right/Wrong, the question's saved points and the score change (Right **+points**, Wrong **+0**). **Confirm Score** saves it: the database takes the points from the saved question, records the result once (a retry or double click never scores twice), marks the question used and returns to the board. If saving fails the summary stays open with the error and can be retried. **Cancel** (on either step) changes nothing.
   - **Close without points:** for a question nobody answered. It gives 0 points and marks the question used.
5. **Score log tab:** every result, with question, team, result, value, points, host and time, plus the standings. **Reset results (rehearsal)** voids every result (they stay listed) and makes all questions available again. It needs a typed confirmation and a reason.

Nothing advances automatically: no automatic team selection or next question.


### Round 3 — removed

Round 3 (THE KNOWLEDGE AUCTION) has been removed from the application: there are no Round 3 pages, routes, projector, demo engine or RPC calls, and old `/host/rounds/3…` or `/projector/round3…` links fall through to the home page. Its database schema from migrations 13 and 14 (`r3_*` tables, `r3s_*` functions) and any existing Round 3 data are **still in the database, unchanged**; removing them needs a separate, explicitly approved cleanup migration (Round 2's `_r2s_new_code` reads `r3_sets` and must be updated first).

## Screens and routes

| Route | Who | Purpose |
|---|---|---|
| `/` | Everyone | Landing page with **Join quiz**, **Organizer login** and **Registration desk** |
| `/registration/login`, `/registration` | Registration staff (and organizers) | Both sections' teams: register, search, edit, PINs, CSV. Teams that have started a quiz are locked |
| `/join` | Teams | Set code → team sign-in (number + PIN) or walk-in registration |
| `/play` | Teams | Instructions, **Start**, countdown, questions, **Submit quiz**, paused, time's up, closed, own result |
| `/login` | Organizer | Supabase email/password (demo: labelled "Enter demo console") |
| `/host` | Organizer | **Dashboard**: next step, event counts, event flow, round cards (no timer) |
| `/host/rounds` | Organizer | Three round cards; Round 1 opens its area, Rounds 2–3 are marked not implemented |
| `/host/rounds/1` | Organizer | Round 1 overview for the selected set: compact progress (questions → published → live → ended → qualifiers → revealed), one primary action, a warning when a draft cannot be published, all sets at a glance, standings only once answers exist |
| `/host/rounds/1/sets` | Organizer | All sets: new set, continue a draft's setup, open, duplicate, delete drafts, archive |
| `/host/rounds/1/new` | Organizer | Set wizard step 1 (title, section); *Next* creates the draft and continues on `/host/rounds/1/setup` |
| `/host/rounds/1/setup` | Organizer | **Draft:** the four-step wizard (details → questions → rules → review & publish). **Published:** code (copy, revoke, new code, open/close registration, unpublish before anyone joins), name/instructions, PIN slips, frozen questions with the audited **Correct key** action, locked timer & scoring, team devices & attempts |
| `/host/rounds/1/live` | Organizer | Go live, pause all/resume, end set, the set timer, paper answer entry, team devices & attempts (finalize / reset attempt), activity log, undo |
| `/host/rounds/1/questions`, `/host/rounds/1/leaderboard` | Organizer | Question bank (shared by every set); leaderboard of the selected set |
| `/host/rounds/2` | Organizer | Round 2 game board: tiles → Reveal Question → Right / Wrong / Answer → team confirmation; live scores |
| `/host/rounds/2/questions`, `/host/rounds/2/teams`, `/host/rounds/2/log` | Organizer | Round 2 topics & questions; roster and rules (timer, penalty); score log, standings, rehearsal reset |
| `/projector/round2` | Organizer | Round 2 public projector: MIND MELTDOWN board, played tiles, revealed question with countdown, answer only after **Answer**. Interactive for the organiser (tile → Reveal Question / Cancel → Right / Wrong / Answer → team popup → Confirm Score); **Display only** (or `?view=display`) hides the controls. Never shows scores, rankings, the score log or the join code |
| `/host/rounds/3` | Organizer | Information only — not implemented, no controls |
| `/host/teams` | Organizer | All teams of both sections with their Round 1 status (attempt status, qualified / not qualified); add, edit, delete, import (into a chosen section), export |
| `/host/results` | Organizer | Round tabs; Round 1 per set: status, times, tie review, attempt detail, CSV exports, tie-breaks, qualifiers, reveal |
| `/host/settings` | Organizer | **Settings & Backup**: mode, event timezone, exports, JSON backup/restore, demo-data removal, security status |
| Old `/host/sets`, `/host/quiz`, `/host/live`, `/host/questions`, `/host/leaderboard` | — | Redirect to the new Round 1 paths |
| `/projector?set=<id>` | Organizer's projector window | One set: standby (shows its **join code** while registration is open), progress, leaderboard, reveal. **Never** receives answer keys |

---

## Architecture and security model

```
Team device (anon)            Organizer (authenticated + in organizers)        Projector (organizer session)
  join_lookup / join_team        RLS read access to tables                       questions (no keys) + get_standings()
  participant_state (poll 2 s)   SECURITY DEFINER RPCs for every change
  participant_submit             live table updates (Realtime)
        │                                  │
        └──────────── SECURITY DEFINER functions in Postgres ───────────────┘
              scoring from question_keys · single session lock · append-only audit log
```

**Quiz sets.** A quiz set is a row of `quiz_sessions`; any number may be active per section (`is_current` now means "not archived"). Organizer RPCs keep their signatures and act on the set named by the `x-brainfreze-set` request header (a set id), which the app sets on every organizer call. Without it they fall back to the newest active set of the `x-brainfreze-section` section. Participant RPCs ignore both headers: their set comes from the join code or the device token.

**Frozen sets.** Publishing copies the set's questions, keys and resolved marks into `set_questions` (organizer-only, not published to Realtime) and locks the timer and scoring. Later bank edits never change a published set. A bank question used by a published set cannot be deleted. A wrong published key is fixed only with `correct_set_question` (reason required, audited as `key_change`, re-scores that set only).

**Attempts.** `quiz_attempts` holds one attempt per team per set (unique index; reset attempts are kept for the audit trail). Each attempt stores:
- `question_order` and `option_orders` (for example `CADB`: displayed A shows original C), generated with `gen_random_uuid()` when the team joins;
- `started_at`, `deadline_at`, `paused_ms`, `finished_at` and the status (`ready`, `in_progress`, `submitted`, `timed_out`, `organizer_finalized`, `reset`).

Answers record the attempt, the **displayed** letter, the **original** option used for scoring, the server timestamp and whether it was on time. Expired attempts are finalized at their deadline whenever anything reads them, so the result never depends on a device being online. `public.finalize_all_expired()` can also be scheduled with pg_cron.

**One set per team per section.** A team with an attempt or answers in one active set of its section cannot join, or be scored in, another (`TEAM_IN_OTHER_SET`), unless an organizer resets that attempt or archives that set.

**Registration staff** are Supabase users listed in `public.registration_staff` (not in `organizers`). They can call only `registration_access`, `reg_overview` and `reg_save_team`; RLS gives them **zero rows** from every table (including `question_keys`), and every organizer RPC rejects them with `NOT_AUTHORIZED`. `reg_save_team` refuses changes once that section's quiz has started (`REGISTRATION_LOCKED`) and can never set the demo flag. Every create/edit (desk, organizer or walk-in) is written to the append-only `registration_events` log with the actor and the changed fields.

**Shuffling.** The device asks for a position in its own order. The server answers with that question, its options in the team's option order (no key), and a list of answered/unanswered flags. The device submits the letter it saw; the server maps it back through the stored permutation and scores the original option.

**Participants have no Supabase account and no table access.** They call eight functions as the `anon` role:
- `join_lookup`
- `join_team`
- `register_team`
- `participant_state`
- `participant_start`
- `participant_submit`
- `participant_finish`
- `participant_leave`

**Identity:**
- Joining needs the active code **and** the team number **and** the team PIN.
- Wrong team and wrong PIN return the same error, so team numbers can't be probed.
- Success returns a random **256-bit device token**. Only its SHA-256 hash is stored.
- Every participant call is authorized by that token, which is bound to **one team in one quiz set**. No request parameter can name another team or attempt.

**One device per team:**
- A second device is refused while the first is active (seen in the last 45 s).
- After 45 s of silence the PIN can move the team to a new device; the old token is revoked.
- The organizer can also **disconnect** a device or **issue a new PIN**.

**Registration:**
- When registration is **closed**, new teams are refused.
- Teams that already joined can still reconnect.

**Join codes:**
- Six random digits from a cryptographically secure generator, with no bias.
- Unique among active quizzes, enforced by a database unique index; collisions are retried on the server.
- **A code is never reused**, so an old code can never open a different quiz.
- Codes expire on end, unpublish, revoke, regenerate or archive. A set's code identifies that set only — never a team or a section.

**Submissions:**
- **One per team per question.** The answer locks; a retry with the same request ID returns the original result and is never counted twice.
- Accepted only while the set is **running**, the team's attempt is **in progress**, and the **database clock** is before the team's deadline. Any question of the team's attempt may be answered, in any order.
- The browser sends only the chosen option. Responses **never** include correctness, points, keys or explanations.
- Corrections and undo remain organizer-only, with reasons, and are audited (the audit log now records `source = participant|organizer`).

**Rate limiting:**
- Failed code/PIN attempts are counted per client (SHA-256 of the client IP from request headers): 30 per 10 minutes.
- There is also a global cap of 600 per minute.

**Live sync:**
- Organizers get Supabase Realtime table updates.
- Participants **poll** `participant_state` every 2 s. They have no table access, so they can't use table-level Realtime.
- They also listen for a **data-free** broadcast "changed" signal from the organizer to refresh at once. If public broadcast channels are disabled in the project, polling alone still works.
- The countdown is the stored deadline minus the server time, corrected for each device's clock skew, so a device clock can't change anything. The device shows its connection status, and retries Start, answers and Submit quiz safely with the same request (idempotent).

---

## Database migrations

Run in **filename order**. Migrations 1–3 are applied to your live project. **Migrations 4, 5, 6 and 7 are NOT applied there** (each requires the previous one). Nothing has been applied to the live database from this environment.

| # | File | Contents |
|---|---|---|
| 1 | `20261013000100_schema.sql` | Tables, constraints, triggers (Round 1) |
| 2 | `20261013000200_functions.sql` | Organizer functions (Round 1) |
| 3 | `20261013000300_security.sql` | RLS, grants, Realtime publication |
| 4 | **`20261014000100_participants.sql`** | Join codes, PINs, participant functions |
| 5 | **`20261015000100_sections_registration.sql`** | UG/PG sections, registration desk role, self-paced shuffling |
| 6 | **`20261016000100_quiz_sets_attempts.sql`** | Quiz sets, frozen set questions, team attempts, per-team timers, elapsed-time ranking. Details below |
| 7 | **`20261017000100_round2_trivia.sql`** | **New.** Round 2 trivia board. New tables and functions only; Round 1 is unchanged. Details below |
| 8 | **`20261018000100_round1_simplify_setup.sql`** | **New.** Round 1 setup: removes the 30–60 question limit (publishing needs at least one question) and lets the organizer pick any positive time limit. Relaxes checks only; no data changes, grants kept. Round 2 untouched |
| 9 | **`20261019000100_round1_participant_flow.sql`** | **New.** PIN-free participant join: `join_roster` (registered teams of the code's section) and `join_registered_team` (one device per team until an organizer releases it); answers can be changed until the team submits or its deadline passes (each change audited). No data changes; function permissions re-applied in full with the two new functions added |
| 10 | **`20261020000100_round2_trivia_sets.sql`** | **New.** Round 2 trivia sets: editable drafts (topics, point-valued questions, answers), Publish → frozen version + one six-digit code per set, and live sessions created only by Start Round 2 (own teams, board state and once-per-question scores). Copies an existing migration-7 board into a draft set; migration-7 tables/functions are kept unchanged. Answers are readable only through organizer RPCs. Function permissions re-applied in full |
| 11 | **`20261021000100_round2_private_scores.sql`** | **New.** Redefines `r2s_board` only (same signature and organizer-only grant): the projector board (`p_host = false`) no longer carries scores, the last result, the score log or the join code, and gains the session's team names (no scores) for the projector's team popup; the host board (`p_host = true`) keeps the leaderboard, last result, score log and answer peek. No table, data or permission changes |
| 12 | **`20261022000100_permissions_repair.sql`** | **New.** Permissions only. Re-applies the complete function permission set (the same lists as migration 10) and checks itself: every `r2s_*` function executable by signed-in users (each still checks organizer membership inside), no organizer function executable by anon, no internal `_` helper executable by anyone. Fixes *"Round 2 could not load. This account is not authorized for this action."*, caused by an older migration (3–7 or 9) being run after migration 10: each of those revokes EXECUTE on every function and re-grants only the ones it knows, which removes the Round 2 grants. Safe to run repeatedly |
| 13 | **`20261023000100_round3_auction.sql`** | *(Round 3 is no longer used by the app; schema and data kept.)* Round 3 THE KNOWLEDGE AUCTION: auction sets (draft topics and NORMAL/BLIND questions, answers and explanations in organizer-only tables), Publish → immutable version (a trigger refuses any UPDATE/DELETE) + one six-digit code, live auctions for exactly three registered teams of one section (one live auction per section) with a public **budget** (100) and a private **score** (0) in separate columns, server-validated bids (≥ 10, steps of 10, ≤ budget; deadline enforced), finalized bid order with organizer tie resolution, idempotent outcome confirmation (request id + one outcome per team per question) and an audit ledger. The projector board never contains scores or unrevealed topics/questions/answers. `_r2s_new_code` now also avoids Round 3 codes. Re-applies the complete function permission set (as migration 12, plus `r3s_*`) with a self-check. Safe to re-run |
| 14 | **`20261024000100_round3_timers.sql`** | *(Round 3 is no longer used by the app; schema kept.)* Optional bidding timer: **No timer** (manual Close Bidding only) or **timed**, any 1–3600 whole seconds; timed bidding **closes automatically at the server deadline** — every organizer action and every board read (projector or control panel, including after a refresh or reconnect) first closes an expired bidding at its deadline, so it is closed even if the organizer was disconnected. An open bidding can no longer be restarted or extended (only the audited *reopen bidding* correction). Defaults: set (new sets: no timer) → auction default chosen at Start Round 3 (changeable, audited) → per-question override when bidding starts. Answer timer per auction (5–600 s). New signatures `r3s_start_session(…, p_settings jsonb)`, `r3s_start_bidding(…, p_timer jsonb)`, new `r3s_update_session_settings`; old signatures dropped; existing auctions back-filled. Re-applies the complete permission set |
| 16 | **`20261026000100_round2_wrong_scores_zero.sql`** | **New.** Round 2 scoring: `_r2_delta` gives Right = +the question's saved points, Wrong = **0** (nothing deducted; the stored penalty is ignored; recorded results are unchanged). Re-installs `r2s_board` exactly as migration 11, so the board always carries the game's team list — a database still running migration 10's `r2s_board` returned none and the "Which Team Answered?" step blanked the page. Re-applies the complete permission set (identical to migration 15) with a self-check. No table, RLS or data changes; safe to re-run |

**Round 1 participant flow (migration 9):** a team opens `/join`, enters the six-digit code, picks UG or PG, and chooses its registered team from a dropdown ("Team 12 · Team name (participant & participant)"; only teams of the set's section are listed, with no college, ids or PINs). A team stays bound to the first device that joins; another device is refused until an organizer presses **Release device** in the device monitor (the team then resumes the same attempt). The team presses **Start**: the server stores its start time and deadline, and the countdown on the quiz page is computed from that deadline, so refreshing never resets it. Tapping an option saves it on the server immediately and can be changed until **Submit Quiz** (a confirmation shows answered/unanswered counts and can be cancelled). When the deadline passes, the server times the attempt out with every saved answer, even if the device is offline; later answers are refused. Live Host shows only Go live, End set, the projector controls and the device monitor; pause, paper answer entry and corrections are in the folded **Emergency & paper answers** section. The older PIN sign-in (`join_team`) remains callable for older clients but the app no longer uses it.

**Round 2 workflow (migration 10):** Rounds → Round 2 has three tabs. **Trivia Sets**: create any number of sets (title, UG / PG / both, question timer — default 18 s — and wrong-answer penalty — default 50 % of the value), add any number of topics and questions with any point values, preview the board, then **Publish Trivia Set**: the draft is frozen as a version and the set gets one six-digit code (kept on later publications; editing the draft never changes a published version or a running game). **Join Round 2**: enter the code, pick the section, tick the registered teams, review, **Start Round 2** — only then is a game created, and the projector opens for it. **Round 2 Dashboard**: live and finished games; each game has its own board, scores and score log, and never affects another game. Gameplay is unchanged: tile → (hidden) → Reveal Question (timer) → Right / Wrong → choose the team → Confirm Score (computed by the database, once per question per game); Answer only reveals the answer; an expired timer never scores.

**Private scores and interactive projector (migration 11):** the leaderboard, the last result and the score log appear only on the organiser's private game screen (Round 2 → game). The projector board is a separate, public view: tiles, used marks, the open question and timer after **Reveal Question**, the answer after **Answer**, and nothing else. The organiser can run the whole question flow on the projector itself (useful when the laptop is mirrored to the projector), or switch it to **Display only** and play from the private screen; both screens use the same organizer-only server functions and stay in step. The projector window listens only to session-state changes, never to score rows.

**What migration 7 adds (Round 2):**
- **Tables:**
  - `r2_settings`: timer 18 s and penalty 50 % by default.
  - `r2_topics` and `r2_questions`: point value and `used` flag.
  - `r2_answers`: kept separate from the questions.
  - `r2_teams`: the roster.
  - `r2_results`: one live result per question, enforced by a partial unique index. Each row stores request id, team snapshot, result, value, points, `answer_revealed`, host and time. A reset voids results instead of deleting them.
  - `r2_game`: phase `idle` → `selected` → `revealed`, plus server `revealed_at`.
- **Organizer functions:**
  - setup: `r2_save_topic`, `r2_delete_topic`, `r2_save_question`, `r2_delete_question`, `r2_set_teams`, `r2_update_settings`;
  - gameplay: `r2_select_question`, `r2_cancel_selection`, `r2_reveal_question`, `r2_reveal_answer`, `r2_score_question`, `r2_close_question`;
  - `r2_reset_results`, and the projector's `r2_board`.
- **Scoring is computed in the database:**
  - `r2_score_question` takes no score; the points come from the stored value and the penalty setting.
  - It locks the game row, so it is atomic.
  - It is idempotent by request id, so a retried or double-clicked request is recognised and never counted twice.
  - A question that was already scored is refused.
- **Hidden until revealed:** `r2_board` returns no question text before **Reveal Question** and no answer before **Answer**.
- **Security:**
  - Every table has RLS with read access for organizers only; there are no write grants.
  - Every function requires an organizer; none is granted to `anon`.
  - Realtime publishes the game, results, questions, topics, roster and settings, but **not** `r2_answers`.
  - The migration re-applies the complete function permission list, as migration 6 did.
- **Effect on Round 1:**
  - Deleting a team removes it from the roster and keeps its Round 2 results as a snapshot.
  - Restoring a Round 1 backup re-creates teams, so the Round 2 roster must be picked again.
- **Rollback:** drop the `r2_*` functions and tables; nothing else depends on them.

**What migration 4 adds:**
- **New quiz columns:** `description`, `question_ids` (the question selection), `published_at`, `join_code`, `join_code_active`, `registration_open`, `self_registration`.
- **New tables:** `team_credentials` (PINs, organizer-only), `participant_sessions` (device tokens, hashed), `join_attempts` and `retired_join_codes` (internal; no grants at all).
- **New organizer functions:** `update_quiz_details`, `publish_quiz`, `unpublish_quiz`, `regenerate_join_code`, `set_registration`, `revoke_participant`, `rotate_team_pin`.
- **New participant functions** (callable without an account): `join_lookup`, `join_team`, `register_team`, `participant_state`, `participant_submit`, `participant_leave`.
- **Updated existing functions** (same signatures):
  - `start_quiz`, `go_to_question`, `record_answer` and the standings now respect the question selection;
  - `end_quiz` expires the join code;
  - `new_session` creates a draft copy;
  - `restore_backup` keeps PINs, and a restored quiz is never left published.
- **Permissions:** re-applies the complete function permission set.

Migrations 4–6 are safe to re-run. **If you ever re-run migration 3, 4 or 5, re-run migration 6 afterwards**, because each re-applies its own (older) function definitions and permission set.

**What migration 5 adds:**
- **Columns:** `quiz_sessions.section`, `quiz_sessions.self_paced` (default true), `teams.section`, `teams.college_name`.
- **Constraints:** team numbers unique per `(section, team_number)` (replaces the global unique number); one current session **per section** (same index name, new definition); 50 teams per section.
- **Existing data:** existing teams and sessions become **UG** (column default) and existing sessions become self-paced; a PG session is created. Nothing is deleted. Existing teams keep `college_name = NULL` until edited (the Teams page flags them).
- **New tables:** `registration_staff` (who may use the desk; self-read only), `registration_events` (append-only log; organizer-read only).
- **New functions:** `registration_access`, `is_registration_staff`, `reg_overview`, `reg_save_team` (registration desk); internal `_current_section`, `_lock_section_session`, `_lock_all_current`, `_assert_bank_editable`, `_team_questions`, `_upsert_team`, `_require_registrar`.
- **Changed signatures:** `register_team` gains `p_college_name`; `participant_state` gains `p_position` (old versions are dropped).
- **Updated functions (same signatures):** section-aware `save_team`, `delete_team`, `import_teams`, `remove_demo_data`, `start_quiz`, `update_quiz_details` (pacing), `new_session`, `record_answer`, `get_standings`, `set_tiebreak`, `join_lookup`, `join_team`, `participant_submit`; bank-wide `save_question` (re-scores both sections), `delete_question`, `reorder_questions`, `import_questions`; `restore_backup` (backup format 2 with both sections; format 1 still restores into UG).
- **Permissions:** re-applies the complete function permission set.

**What migration 6 adds** (depends on 4 and 5):
- **Effect on existing data:**
  - Nothing is deleted. Existing sessions become quiz sets in their section (the current UG and PG sessions stay the newest set of each section).
  - Already-archived sessions get `archived_at`.
  - A session that was published before this migration has no frozen snapshot. It keeps working, but publish it again (Unpublish → Publish, possible only before any team joins) to freeze it.
  - Existing answers keep `attempt_id = NULL` and count as paper answers (full time limit for ranking).
- **Columns:**
  - `quiz_sessions.published_by`, `paused_at`, `archived_at`;
  - `team_answers.attempt_id`, `displayed_option`, `on_time`.
- **Constraints:**
  - The one-current-session-per-section index is redefined (same name) so any number of active sets may exist.
  - `score_events.action` allows `attempt_reset`, `attempt_finalize` and `key_change`.
- **New tables (RLS on, organizer read-only, no writes from any API role):**
  - `set_questions`: frozen questions + keys. Not in Realtime.
  - `quiz_attempts`: one attempt per team per set. Added to Realtime for organizers.
- **New organizer functions:** `create_set`, `duplicate_set`, `delete_set`, `archive_set`, `revoke_join_code`, `finalize_expired_attempts`, `finalize_attempt`, `reset_attempt`, `correct_set_question`, `get_set_results`.
- **New participant functions:** `participant_start`, `participant_finish`.
- **Internal function:** `finalize_all_expired()` (no API grant; for pg_cron).
- **Replaced functions (same signatures):**
  - `publish_quiz`: at least one question, keys, a positive timer, valid marks; snapshot; `published_by`.
  - `update_quiz_details` and `update_settings`: `SET_FROZEN` after publishing.
  - `start_quiz`: requires a published set (`NOT_PUBLISHED`).
  - `pause_quiz` / `resume_quiz`: freeze and shift team deadlines.
  - `end_quiz`: times out expired attempts and organizer-finalizes running ones.
  - `unpublish_quiz`: only before anyone joins.
  - `new_session`: archives the set and creates a draft copy.
  - `record_answer`, `undo_last_action`, `set_tiebreak` and `get_standings`: elapsed-time ranking.
  - `join_lookup`, `join_team`, `register_team`, `participant_state`, `participant_submit`: attempts, shuffled options, deadlines.
  - `save_question`, `delete_question`, `import_questions`, `remove_demo_data` and `delete_team`: published sets are protected.
  - `reg_overview` and `reg_save_team`: per-team lock.
  - `restore_backup`: backup format 3; formats 1–2 still restore.
- **Permissions:** re-applies the complete function permission set.
- **Rollback / recovery:** migration 6 replaces functions and widens one unique index, so there is no automatic down-migration.
  1. Before applying it, take a Supabase database backup (or note the point-in-time-recovery timestamp) **and** download a JSON backup from the app.
  2. To undo, restore that database backup and redeploy the previous frontend.
  3. Re-running migration 5 alone is **not** a rollback: the new tables would remain, the old one-set-per-section index would not come back, and the old frontend expects one set per section.

---


## Local development and testing

```bash
cd brainfreze-cold-start
npm install

npm run dev:demo        # demo mode (ignores .env.local) → http://localhost:5173
npm run dev             # uses .env.local → your Supabase project

npm run lint            # ESLint
npm test                # 297 tests: engine, participants, quiz sets, Round 2, SQL (PGlite, migrations 1–7), RPC contract, CSV, sample keys, fail-safe
npm run build           # production build (uses .env.local; refuses to run without Supabase config)
npm run build:demo      # explicit demo build → dist-demo/
npm run preview:demo    # serve dist-demo on http://localhost:4173

# Browser tests (need Chrome or Edge installed; run against preview:demo in a 2nd terminal)
npm run test:e2e                # Round 1 organizer flow: publish, go live, paper entry, results, reveal (37 checks)
npm run test:e2e:sets           # quiz sets: 29/30 questions, publish, join, Start, countdown, refresh, submit, pause,
                                # results + attempt detail + CSV, end set, dashboard, Teams status, one set per section, desk lock (51 checks)
npm run test:e2e:round2         # Round 2: setup, projector window, hidden tile, reveal + 18 s timer, Answer, Right/Wrong team
                                # confirmation, cancel, double click, reload, expiry, close without points, score log (25 checks)
```

**Try the full flow locally in demo mode** (registration desk, one organizer, two simulated teams):
1. Run `npm run dev:demo`.
2. **Registration desk:** open <http://localhost:5173/registration/login> → **Enter demo registration desk**. Register a team and note its PIN.
3. **Create a set:** open <http://localhost:5173/login> → **Enter demo console**. Go to **Rounds → Open Round 1 → Quiz sets → New quiz set**, enter a title, choose UG and press **Next**.
4. **Publish it:** on **Set setup & join**, adjust the questions and the time limit, check the ranking rules, then **Publish set**. Note the code, and click **Show PINs**.
5. **Team 1:** open a **new tab** at <http://localhost:5173/join>. Enter the code, team **1** and its PIN, then **Sign in team**. The tab shows the instructions.
6. **Team 2:** open another **new tab** and repeat with team **2**. You can press F12 and use the device toolbar to see the phone layout.
7. **Go live:** in the organizer tab, go to **Live host → Go live**. In each team tab press **Start the quiz**. The two tabs show different question and option orders and their own countdowns.
8. **Answer and submit:** answer a few questions and press **Submit quiz** in one tab. Reload the other tab: same question, same countdown.
9. **Organizer controls:** try **Pause all / Resume**, **Results** (times, status, attempt detail, CSVs), **End set**, then the **Dashboard** and **Teams** statuses.
10. **Second set:** create a second UG set. Team 1 is refused there (one set per section).

Demo state is shared between tabs **of one browser only**. Each tab keeps its own team identity and its own selected set.

**Try it with Supabase** (after the manual steps below):
1. Run `npm run dev`.
2. Sign in as the organizer in one browser.
3. Open `/join` in **two separate browser profiles or incognito windows**, or on two phones on the same network, using `http://<your-PC-IP>:5173/join` after `npm run dev -- --host`.

---

## Supabase setup (manual steps)

Your project already has migrations 1–3 and public sign-ups disabled (checked read-only on 14 Oct). Nothing below has been done for you, and nothing has been applied to the live database.

1. **Back up first.** Take both kinds of backup:
   - In the deployed or local organizer console, use Settings → **Download JSON backup**.
   - In Supabase, take a database backup or note the point-in-time-recovery timestamp.
2. **Apply migrations 4–14, in order** (skip the ones already applied; migration 13 is already live). In Supabase **SQL Editor → New query**, paste each whole file and run it:
   1. `supabase/migrations/20261014000100_participants.sql`
   2. `supabase/migrations/20261015000100_sections_registration.sql`
   3. `supabase/migrations/20261016000100_quiz_sets_attempts.sql`
   4. `supabase/migrations/20261017000100_round2_trivia.sql` (Round 2)
   5. `supabase/migrations/20261018000100_round1_simplify_setup.sql` (Round 1 setup: no question-count limit, any positive time limit)
   6. `supabase/migrations/20261019000100_round1_participant_flow.sql` (Round 1 participant flow: join by registered team without a PIN, autosaved answers)
   7. `supabase/migrations/20261020000100_round2_trivia_sets.sql` (Round 2 trivia sets, codes and games)
   8. `supabase/migrations/20261021000100_round2_private_scores.sql` (Round 2 scores private to the host screen; projector board without scores)
   9. `supabase/migrations/20261022000100_permissions_repair.sql` (permissions only)
   10. `supabase/migrations/20261023000100_round3_auction.sql` (Round 3 schema — unused by the app, but later migrations depend on it)
   11. `supabase/migrations/20261024000100_round3_timers.sql` (Round 3 schema; also re-applies every permission)

   **Do not re-run an older migration file on its own.** Migrations 3–7, 9, 10, 12 and 13 each reset the permissions of *every* function to the list they know, so an older file run later removes newer grants. If you re-run one, run the **newest** migration (`20261024000100_round3_timers.sql`, safe to re-run) again afterwards. To check the Round 2 permissions (read-only), run this in the SQL Editor; it must return no rows:

   ```sql
   select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'r2s\_%'
     and not has_function_privilege('authenticated', p.oid, 'execute');
   ```

   *(CLI alternative: `supabase link --project-ref <ref>` then `supabase db push`.)*

   Migration 5 assigns existing teams and the existing session to **UG**. Move PG teams afterwards, using the Teams page or the registration desk.
3. **Recommended:** if the `pg_cron` extension is available, schedule `select public.finalize_all_expired();` every minute. This is optional: expired attempts are finalized at their deadline whenever anything reads them anyway.
4. **Create the organizer user** if you haven't already: **Authentication → Users → Add user**, with **Auto confirm user** ticked (email confirmation is on in your project).
5. **Authorize the organizer:**
   ```sql
   insert into public.organizers (user_id, display_name)
   select id, 'Quiz Master' from auth.users where email = 'organizer@example.com';
   ```
6. **Create registration-staff accounts** (Authentication → Users → Add user, **Auto confirm** ticked), then authorize each one for the desk only — **do not** add them to `organizers`:
   ```sql
   insert into public.registration_staff (user_id, display_name)
   select id, 'Registration desk 1' from auth.users where email = 'desk1@example.com';
   ```
7. **Check the migrations** in the SQL editor. Each line should return what's noted:
   ```sql
   select count(*) from public.team_credentials;              -- one row per team
   select section, status from public.quiz_sessions where is_current order by section;  -- PG setup, UG <status>
   select has_function_privilege('anon', 'public.join_lookup(text)', 'execute');      -- true
   select has_function_privilege('anon', 'public.participant_start(text)', 'execute'); -- true
   select has_function_privilege('anon', 'public.start_quiz()', 'execute');           -- false
   select has_function_privilege('anon', 'public.create_set(jsonb)', 'execute');      -- false
   select has_function_privilege('anon', 'public.reg_save_team(jsonb)', 'execute');   -- false
   select has_table_privilege('anon', 'public.question_keys', 'select');               -- false
   select has_table_privilege('anon', 'public.set_questions', 'select');               -- false
   select has_table_privilege('anon', 'public.quiz_attempts', 'select');               -- false
   select tablename from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('set_questions', 'quiz_attempts');  -- quiz_attempts only
   ```
8. **Live verification (staging project first, then live):**
   1. Sign in as the organizer and create a UG set and a PG set.
   2. Try to publish one with 29 questions (refused), then with 30.
   3. Sign in as registration staff and confirm that the desk works and that `/host` refuses the account.
   4. Join the UG set from two separate browsers or phones with team PINs. Press Start; refresh; answer; Submit quiz on one device; let the other run past a short time limit (5 min).
   5. Check that Results shows the elapsed times, statuses and tie flags, and download the four CSVs.
   6. Try a PG team on the UG code (refused) and the first team on a second UG set (refused).
9. **Optional:** in **Realtime → Settings**, allow public broadcast channels so team devices update instantly. Without it they update within about 2 s by polling.
8. Keep **public sign-ups disabled**. Participants never need accounts; staff and organizers are created by you.

**Environment variables** (`.env.local` locally, and Vercel project settings):

| Variable | Value | Safe in the browser? |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` | Yes |
| `VITE_SUPABASE_ANON_KEY` | the anon / **publishable** key | Yes — public by design and protected by RLS |
| `VITE_ALLOW_DEMO_MODE` | leave **unset** in production | Only `true` for a deliberate demo deployment |
| `VITE_EVENT_TIMEZONE` | optional, e.g. `Asia/Kolkata` (the default) | Yes — only changes how timestamps are displayed; they are stored as UTC `timestamptz` |
| service-role / `sb_secret_…` key | **never** in any `VITE_` variable | **No.** The app refuses to start if it detects one, and it doesn't need one |

---

## GitHub and Vercel

Nothing has been pushed or deployed.

```bash
git init && git add . && git status    # confirm .env.local, dist/ and backups are NOT staged
git commit -m "BRAINFREZE COLD START with quiz sets"
git remote add origin https://github.com/<you>/brainfreze-cold-start.git
git push -u origin main
```

**Vercel:**
1. Import the repo with framework **Vite**, build command `npm run build`, output `dist`.
2. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3. If they're missing, the deployed site shows **"Configuration required"** instead of an open demo.

`vercel.json` routes every page (`/join`, `/play`, `/registration/*`, `/host/*`, …) to the app and sets security headers.

---

## Scoring, timer and ranking rules

| Rule | Behaviour |
|---|---|
| Scoring | Correct **+1**, incorrect **−0.25**, unanswered **0** by default. Configurable per set before publishing; per-question overrides from the bank are kept. **Frozen when the set is published.** |
| Unrecorded questions | Count as unanswered |
| Questions per set | **Any number (at least one)**, checked in the browser and again in the database at publish time; no duplicates; every question needs a key and valid marks |
| Timer | Per set, **any positive number of minutes** chosen by the organizer, frozen at publish. Each team's timer starts when **it** presses Start (deadline = server start + limit). The countdown is the stored deadline minus the server time; refreshes and reconnections never reset it |
| Pause | **Pause all** freezes every running team timer. On resume each deadline moves by the paused time, and paused time is excluded from elapsed time |
| After the deadline | Team answers are refused (`TIME_EXPIRED`) and the attempt is finalized as **timed out**, at the deadline itself, even if the device is offline. The organizer can still enter paper answers by authorizing post-time entry (reason audited) |
| Completion status | **Submitted early** (team pressed Submit quiz), **Timed out**, **Organizer-finalized** (End set or Finalize attempt) |
| Elapsed time | Submitted: final submission − start − paused time (server times). **Timed out, organizer-finalized, never started, or paper-only: the full time limit.** Leaving a quiz unfinished is never rewarded |
| Ranking | 1. Higher score. 2. Shorter elapsed time. 3. Equal score **and** equal time → flagged **Review**; an organizer tie-break result decides only when every team in that tie has one; otherwise the teams share the rank. The old "fewer incorrect answers" rule is no longer used |
| Last-answer time | **Not** used for ranking (only the final submission time is) |
| Cut-off ties | Flagged, never silently eliminated |
| Corrections | Organizer only, with a reason, in the audit log. A published key changes only through **Correct key** (audited `key_change`, re-scores that set) |
| Reveal | Results are revealed only after confirmation. Participants then see their own rank and score only |
| Timestamps | Stored as `timestamptz` (UTC); shown in the event timezone (`VITE_EVENT_TIMEZONE`, default Asia/Kolkata). CSVs contain both |

---

## Event-day runbook

1. **Day before:**
   - apply migrations 4, 5 and 6 (after backups); create the organizer and registration-staff accounts;
   - remove demo data;
   - register the real teams (registration desk or import) and import the questions;
   - create the sets (for example one per section and slot); choose the questions, the time limit and the scoring; review and **publish**;
   - print the PIN slips;
   - **rehearse with two real devices**, including a refresh and an early Submit quiz;
   - download a backup.
2. **At the venue:**
   - open `/join` on each team device;
   - project each set's **Standby** view (Open set projector), which shows its join code;
   - **close registration** once all teams have joined.
3. **Go live.** Teams press Start; each gets its own countdown.
4. Watch **Team devices & attempts**: status, remaining time, progress.
5. **If a device fails:**
   - **disconnect** it and sign the team in on a spare device with its PIN — it resumes the same attempt and deadline; or
   - if the attempt itself must be redone, **Reset attempt** (with a reason); or
   - record that team's answers on Live Host.
6. **End set** when every team has finished or timed out. If needed, authorize post-time entry for paper answers.
7. **Results:**
   1. Review **Review** flags.
   2. Enter tie-breaks.
   3. Confirm the top 5.
   4. Export the CSVs.
   5. Download a backup.
   6. **Reveal**.

---

## What has been verified

Everything below ran **locally**: Node tests with PGlite (a real PostgreSQL in WebAssembly, running the actual migrations) and browser tests against the **demo build**. **Nothing was run against the live Supabase project.**

| Check | Result (16 Oct 2026) |
|---|---|
| `npm run lint` | **0 problems** |
| `npm test` | **297 passed, 15 files.** See the breakdown below |
| `npm run build` / `npm run build:demo` | Both build |
| Browser, demo build, Chrome: quiz sets | **51/51** checks, 3 consecutive passing runs after the set wizard. Covers the wizard (validation, 29 → 30 questions, rules, resume after reload, publish with copyable code) and the full set flow (see `scripts/e2e-sets.mjs`) |
| Browser, demo build, Chrome: Round 1 organizer flow | **37/37**: set wizard at phone width (CSV import with an invalid then a valid file, remove all, cancel), five-section navigation, dashboard next step, Round 2 card and Round 3 marked not implemented, publish, go live, paper entry, correction, undo, timer reload, projector, leaderboard, end set, tie at cut-off, qualifiers, reveal, mobile layout of the dashboard and the Round 1 area |
| Browser, demo build, Chrome: Round 2 | **25/25** checks, 3 consecutive passing runs, host and projector in separate windows (see `scripts/e2e-round2.mjs`) |
| Live Supabase | **Not tested.** Read-only check on 14–15 Oct: migrations 1–3 present; **migrations 4, 5, 6 and 7 NOT applied** |

**`npm test` breakdown:**
- **Round 2:**
  - 16 demo-engine tests: a tile reveals nothing; Reveal starts 18 s; Answer changes no score; Right/Wrong open the team step; Confirm needs exactly one team; Cancel changes nothing; +value and −penalty (configurable, 2 decimals); once per question; duplicate requests; expiry awards nothing; locks; reset; Round 1 untouched.
  - 13 SQL tests (migration 7): server-side scoring; the one-result-per-question index; idempotent requests; question and answer hidden on the board; organizer-only access; anon denied; answers not published to Realtime; team deletion keeps the snapshot; reset.
- **SQL (PGlite, migrations 1–7):**
  - 22 quiz-set tests: lifecycle; 29/30/60/61 questions; duplicates; missing keys; timer limits; freeze; unique codes; wrong section; one set per section; revoke/archive; staff denial; stable shuffle; option-mapping scoring; idempotent retries; timer persistence; early submit; deadline timeout; pause/resume; ranking and equal-time ties; reset/finalize audit; published-key correction; end set; audit columns.
  - 64 earlier SQL tests, updated for the set model.
- **Demo engine:** 24 quiz-set tests, 19 participant tests and 25 Round 1 engine tests, all mirroring the SQL.
- **RPC contract:** 78 tests (Round 2 RPCs included) — every RPC the app calls exists with the same argument names and the right grants; organizer calls carry the set header; the projector never selects keys.
- **CSV, sample keys and fail-safe configuration:** 12 tests.
- **Set wizard:** 20 tests — step order, Next/Back and reachable steps, resume step; no question-count limits (only "at least one") and incomplete questions; default rules and positive-duration validation; Save draft round-trip and browser-kept edits; CSV/JSON parsing, per-line validation, duplicates; publish refused for invalid sets, one-question and 64-question sets publish, six-digit code, frozen questions and rules afterwards.
- **Organizer navigation and dashboard logic:** 7 tests — five sections; every Round 1 tab and old URL is routed; Round 2 routed and no Round 3 route left; Round 1 status and the single next action through draft → published → live → review → qualified; setup progress; results status.

The quiz-set browser test covers:
- creating a set; 29 questions blocked, 30 published; the timer frozen after publishing;
- instructions on a phone; Start; the countdown; a refresh keeping the deadline;
- shuffled options; Submit quiz; the organizer monitor; pause freezing the team timer;
- results with elapsed time and status; attempt detail; the submission-audit CSV;
- End set → organizer-finalized; the second set's own code; one set per section; the expired code;
- the registration desk locking only started teams.

**Not verified:**
- Anything against the **live** Supabase project with migrations 4–6 applied, including:
  - registration-staff login;
  - set header routing;
  - attempts, Realtime on `quiz_attempts`;
  - rate-limit client IP;
  - the optional pg_cron job.
- Physical phones (only Chrome's phone-sized viewport was tested).
- Vercel deployment.

---

## Known limitations

- **Round 2:**
  - **Requires migration 7.** Until it is applied, the Round 2 pages show a load error in Supabase mode.
  - **No undo for a single result.** A mis-scored question can only be fixed with *Reset results*, which voids all Round 2 results.
  - **One shared board** for the whole event, with UG and PG teams in one roster.
  - **Not in the JSON backup.** Round 2 data is in the database but not in the Round 1 JSON backup.
  - **The timer only informs.** It never blocks scoring, so the host may still score after time is up.
- **Team Round 1 status** comes from device attempts and confirmed qualifiers in active sets; teams scored only on paper show "No device attempt".
- **Team devices are always self-paced.** The old organizer-paced device mode (every team answering the projector question) was replaced by per-team attempts and timers. The projector shows the set's code, progress, leaderboard and reveal; paper entry by question still works on Live Host.
- **One device per team, one answer per question, one set per team per section.** Corrections stay organizer-only; a retake needs an organizer **Reset attempt**.
- **Sets share one question bank.** A published set keeps a frozen copy; bank questions used by a published (non-archived) set cannot be deleted or replaced by import until that set is archived.
- **The set wizard edits shared bank questions.** Editing a question in the wizard changes it for every draft that uses it (published sets keep their frozen copy). A new draft starts with the whole bank selected (the server's "no selection yet" meaning), which the organizer can trim in step 2; an empty selection can't be saved, only edited locally until questions are added.
- **Published keys can still be corrected** with the audited **Correct key** action (it re-scores recorded answers and is logged); the questions themselves can't be edited once published.
- **Sets published before migration 6** have no frozen copy until they are published again.
- **Set selection is per browser tab** (sessionStorage). Two organizers can run different sets in parallel tabs; each tab's actions touch only its own set.
- **Registration staff see team PINs** (they hand them out). Treat desk accounts like organizer accounts.
- **Demo mode has no accounts**, so in demo the registration desk and organizer console are both open in the same browser.
- **Rate limiting is keyed by client IP.** At a venue where all devices share one public IP, 30 failed attempts in 10 minutes from that network trigger a temporary block. Tell teams to type carefully; the organizer can still record answers manually.
- **"Connected" is inferred** from device check-ins (every 10 s or more). A quiet device shows "last seen", never "withdrawn".
- **Participant updates arrive by polling** (about 2 s), with an optional instant broadcast signal. Deadlines do not depend on either.
- **Demo mode isn't secure** and works only within one browser.
- **Restoring a backup** replaces all data. Restored sets keep their frozen questions and attempts but never an active code. A restored live set is **paused**, and the time between export and restore counts as paused time. PINs are kept.
- **Images:** links only in Supabase mode. Fonts come from Google Fonts, with a system-font fallback.
