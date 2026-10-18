import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Lock, RotateCcw, Users } from 'lucide-react';
import { useQuiz } from '../context/QuizContext.jsx';
import { useUI } from '../context/UIContext.jsx';
import { PageHeader } from '../components/Common.jsx';
import TeamPicker from '../components/TeamPicker.jsx';
import { SECTION_LABELS, SET_STAGE_LABELS } from '../lib/constants.js';
import { setStage } from '../lib/engine.js';
import { selectionDiff, selectionNames, selectionProblem } from '../lib/teamSelection.js';

/**
 * Round 1: the organiser chooses which registered teams of the set's section take part in the selected quiz set.
 * Only those teams can join with the code, be scored on paper and appear in the set's results. Nothing is carried
 * over from another set or round, and there is no fixed number of teams. The list can change freely until the set
 * goes live; while it is live only as an audited correction (a team that has started cannot be removed); after the
 * set has ended it is final.
 */
export default function Round1Participants() {
  const { snap } = useQuiz();
  const s = snap.session;
  // Re-initialise the draft whenever the saved selection changes (another screen, a correction, a refresh).
  return <ParticipantsEditor key={`${s.id}:${(s.team_ids || []).join(',')}`} />;
}

function ParticipantsEditor() {
  const { snap, sets, act, pendingKeys } = useQuiz();
  const { confirm } = useUI();
  const s = snap.session;
  const stage = setStage(s);
  const saved = (s.team_ids || []).filter((id) => snap.teams.some((t) => t.id === id));
  const [draft, setDraft] = useState(saved);
  const live = ['running', 'paused'].includes(s.status);
  const final = ['ended', 'finalized'].includes(s.status) || s.is_current === false;
  const { added, removed } = selectionDiff(saved, draft);
  const dirty = added.length > 0 || removed.length > 0;
  const problem = selectionProblem(draft, snap.teams);

  // A team takes part in one active set of its section at a time.
  const otherSets = sets.filter((x) => x.id !== s.id && x.section === s.section && x.stage !== 'archived');
  const unavailable = (t) => {
    const o = otherSets.find((x) => (x.team_ids || []).includes(t.id) || (x.participants || []).some((p) => p.team_id === t.id));
    return o ? `in “${o.name}”` : null;
  };
  const started = (t) => {
    const a = snap.attempts.find((x) => x.team_id === t.id && x.status !== 'reset');
    if (snap.answers.some((x) => x.team_id === t.id)) return 'has recorded answers';
    return a && a.status !== 'ready' ? 'has started' : null;
  };

  async function save() {
    if (problem || !dirty) return;
    const ok = await confirm({
      title: live ? 'Correct the participants of a live set?' : 'Confirm the participants?',
      confirmLabel: live ? 'Apply correction' : 'Confirm participants',
      requireReason: live,
      reasonLabel: 'Reason for the correction (recorded in the audit log)',
      message: (
        <div className="stack">
          <p><b>{draft.length}</b> {s.section} team(s) will take part in <b>{s.name}</b>{added.length || removed.length ? ` (+${added.length}, −${removed.length})` : ''}.</p>
          {draft.length > 0 && <p className="small">{selectionNames(draft, snap.teams)}</p>}
          {removed.length > 0 && <p className="small warn-text">Removed teams can no longer join; a removed team that joined but has not started is signed out.</p>}
          {!draft.length && <p className="small warn-text">No team is selected — the set cannot go live until you choose its participants.</p>}
        </div>
      ),
    });
    if (!ok) return;
    await act('setSetTeams', { set_id: s.id, team_ids: draft, reason: live ? ok.reason : null }, {
      key: 'setSetTeams', success: 'Participants saved', successDetail: `${draft.length} team(s) in ${s.name}`,
    });
  }

  return (
    <div className="page">
      <PageHeader title={`Participants — ${s.name}`} subtitle={`${s.section} quiz set · ${SET_STAGE_LABELS[stage]}. Choose which registered ${s.section} teams take part in this set. Only they can join with the code, be scored on paper and appear in its results. Nothing is carried over from other sets or rounds, and there is no fixed number of teams.`}>
        <span className="badge badge-ice"><Users size={14} /> {saved.length} confirmed</span>
      </PageHeader>

      {final && <div className="inline-alert alert-info"><Lock size={16} /> This set has ended (or is archived): its participants are final.</div>}
      {live && <div className="inline-alert alert-warn"><Lock size={16} /> The set is live. Changing its participants is an audited correction with a reason; teams that have started or have answers cannot be removed.</div>}

      <div className="two-col">
        <section className="panel glass" aria-labelledby="r1p-pick">
          <h2 id="r1p-pick">Select teams</h2>
          {snap.teams.length === 0 ? (
            <p className="muted">No {SECTION_LABELS[s.section] || s.section} teams are registered yet. Add them on the <Link to="/host/teams">Teams</Link> page or at the registration desk.</p>
          ) : (
            <TeamPicker teams={snap.teams} value={draft} onChange={setDraft} label={`Registered ${s.section} teams`} disabled={final}
              locked={live ? started : () => null} unavailable={unavailable} />
          )}
        </section>

        <section className="panel glass r2-review" aria-labelledby="r1p-review">
          <h2 id="r1p-review">Review</h2>
          <dl className="kv small">
            <dt>Quiz set</dt><dd>{s.name} ({s.section})</dd>
            <dt>Selected</dt><dd>{draft.length ? <><b>{draft.length}</b> team(s): {selectionNames(draft, snap.teams)}</> : <span className="warn-text">No team selected.</span>}</dd>
            <dt>Confirmed</dt><dd>{saved.length} team(s){dirty ? <> · <b>unsaved changes</b>: +{added.length}, −{removed.length}</> : ''}</dd>
          </dl>
          {problem && <p className="danger-text small" role="alert">{problem}</p>}
          {!final && (
            <div className="row gap wrap">
              <button className="btn btn-primary btn-lg" onClick={save} disabled={!dirty || !!problem || pendingKeys.has('setSetTeams')}>
                <CheckCircle2 size={18} /> {live ? 'Review & apply correction' : 'Review & confirm participants'}
              </button>
              <button className="btn btn-ghost" onClick={() => setDraft(saved)} disabled={!dirty}><RotateCcw size={16} /> Discard changes</button>
            </div>
          )}
          <p className="muted small">The set can go live only after at least one participant is confirmed. Round 2 has its own, separate team selection.</p>
        </section>
      </div>
    </div>
  );
}
