import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { QuizProvider } from './context/QuizContext.jsx';
import { UIProvider } from './context/UIContext.jsx';
import { Loading } from './components/Common.jsx';
import HostLayout from './components/HostLayout.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { LEGACY_ROUTES } from './lib/rounds.js';
import Landing from './pages/Landing.jsx';
import Login from './pages/Login.jsx';
import ConfigError from './pages/ConfigError.jsx';
import { configProblem } from './backend/index.js';

const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Rounds = lazy(() => import('./pages/Rounds.jsx'));
const Round1Layout = lazy(() => import('./components/Round1Layout.jsx'));
const Round1Overview = lazy(() => import('./pages/Round1Overview.jsx'));
const Teams = lazy(() => import('./pages/Teams.jsx'));
const Questions = lazy(() => import('./pages/Questions.jsx'));
const LiveHost = lazy(() => import('./pages/LiveHost.jsx'));
const Leaderboard = lazy(() => import('./pages/Leaderboard.jsx'));
const Results = lazy(() => import('./pages/Results.jsx'));
const SettingsPage = lazy(() => import('./pages/Settings.jsx'));
const Projector = lazy(() => import('./pages/Projector.jsx'));
const ProjectorRound2 = lazy(() => import('./pages/ProjectorRound2.jsx'));
const Round2Layout = lazy(() => import('./pages/Round2Layout.jsx'));
const Round2Session = lazy(() => import('./pages/Round2Game.jsx'));
const Round2Dashboard = lazy(() => import('./pages/Round2Game.jsx').then((m) => ({ default: m.Round2Dashboard })));
const TriviaSets = lazy(() => import('./pages/Round2Sets.jsx').then((m) => ({ default: m.TriviaSets })));
const TriviaSetEditor = lazy(() => import('./pages/Round2Sets.jsx').then((m) => ({ default: m.TriviaSetEditor })));
const Round2Join = lazy(() => import('./pages/Round2Join.jsx'));
const QuizSetup = lazy(() => import('./pages/QuizSetup.jsx'));
const Round1Participants = lazy(() => import('./pages/Round1Participants.jsx'));
const NewSetWizard = lazy(() => import('./components/SetWizard.jsx').then((m) => ({ default: m.NewSetWizard })));
const QuizSets = lazy(() => import('./pages/QuizSets.jsx'));
const Join = lazy(() => import('./pages/Join.jsx'));
const Play = lazy(() => import('./pages/Play.jsx'));

function RequireOrganizer({ children }) {
  const { loading, user, organizer } = useAuth();
  const location = useLocation();
  if (loading) return <Loading label="Checking organizer access…" />;
  if (!user || !organizer) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

/** A rendering error shows a message (with Reload) instead of a blank screen; navigating away clears it. */
function PageBoundary({ children }) {
  const { pathname } = useLocation();
  return <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>;
}

export default function App() {
  // Fail safe: a build without valid Supabase configuration never runs as an open demo.
  if (configProblem) return <ConfigError problem={configProblem} />;
  return (
    <BrowserRouter>
      <UIProvider>
        <AuthProvider>
          <Suspense fallback={<Loading />}>
            <PageBoundary>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/login" element={<Login />} />
              {/* The registration desk was removed: participants enter their own details when they join. Old links go home. */}
              <Route path="/registration/*" element={<Navigate to="/" replace />} />
              {/* Participant routes: no organizer login; authorized by the join code + the participant's details, then a device token */}
              <Route path="/join" element={<Join />} />
              <Route path="/play" element={<Play />} />
              <Route path="/projector" element={<RequireOrganizer><Projector /></RequireOrganizer>} />
              <Route path="/projector/round2" element={<RequireOrganizer><ProjectorRound2 /></RequireOrganizer>} />
              <Route path="/host" element={<RequireOrganizer><QuizProvider><HostLayout /></QuizProvider></RequireOrganizer>}>
                <Route index element={<Dashboard />} />
                <Route path="rounds" element={<Rounds />} />
                {/* Round 1: the existing quiz-set pages, grouped under one area */}
                <Route path="rounds/1" element={<Round1Layout />}>
                  <Route index element={<Round1Overview />} />
                  <Route path="sets" element={<QuizSets />} />
                  <Route path="setup" element={<QuizSetup />} />
                  <Route path="participants" element={<Round1Participants />} />
                  <Route path="new" element={<NewSetWizard />} />
                  <Route path="live" element={<LiveHost />} />
                  <Route path="questions" element={<Questions />} />
                  <Route path="leaderboard" element={<Leaderboard />} />
                </Route>
                <Route path="rounds/2" element={<Round2Layout />}>
                  <Route index element={<Round2Dashboard />} />
                  <Route path="sets" element={<TriviaSets />} />
                  <Route path="sets/:setId" element={<TriviaSetEditor />} />
                  <Route path="join" element={<Round2Join />} />
                  <Route path="session/:sessionId" element={<Round2Session />} />
                  {/* old single-board pages → their new place */}
                  <Route path="questions" element={<Navigate to="/host/rounds/2/sets" replace />} />
                  <Route path="teams" element={<Navigate to="/host/rounds/2/join" replace />} />
                  <Route path="log" element={<Navigate to="/host/rounds/2" replace />} />
                </Route>
                <Route path="teams" element={<Teams />} />
                <Route path="results" element={<Results />} />
                <Route path="settings" element={<SettingsPage />} />
                {/* Old organizer URLs keep working */}
                {Object.entries(LEGACY_ROUTES).map(([from, to]) => <Route key={from} path={from} element={<Navigate to={to} replace />} />)}
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </PageBoundary>
          </Suspense>
        </AuthProvider>
      </UIProvider>
    </BrowserRouter>
  );
}
