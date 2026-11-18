import { useCallback, useMemo, useState } from 'react';
import { JobBar, JobsProvider } from './jobs';
import { NavContext, routeProjectId, type Nav, type Route } from './nav';
import { Correction } from './screens/Correction';
import { Dashboard } from './screens/Dashboard';
import { Home } from './screens/Home';
import { Import } from './screens/Import';
import { Jobs } from './screens/Jobs';
import { Plan } from './screens/Plan';
import { ProjectForm } from './screens/ProjectForm';
import { Settings } from './screens/Settings';
import { Subject } from './screens/Subject';

function Screen({ route }: { route: Route }) {
  switch (route.screen) {
    case 'home':
      return <Home />;
    case 'projectNew':
      return <ProjectForm />;
    case 'projectEdit':
      return <ProjectForm projectId={route.projectId} />;
    case 'dashboard':
      return <Dashboard projectId={route.projectId} />;
    case 'subject':
      return <Subject projectId={route.projectId} subjectId={route.subjectId} tab={route.tab} />;
    case 'plan':
      return <Plan projectId={route.projectId} />;
    case 'import':
      return <Import projectId={route.projectId} subjectId={route.subjectId} testId={route.testId} />;
    case 'correction':
      return <Correction projectId={route.projectId} subjectId={route.subjectId} sourceId={route.sourceId} />;
    case 'jobs':
      return <Jobs />;
    case 'settings':
      return <Settings />;
    default:
      return <div className="page">この画面はまだありません。</div>;
  }
}

function Header({ nav }: { nav: Nav }) {
  const projectId = routeProjectId(nav.route);
  const is = (s: Route['screen']) => (nav.route.screen === s ? 'navlink active' : 'navlink');
  return (
    <header className="header">
      <button className="brand" data-testid="app-title" onClick={() => nav.go({ screen: 'home' })}>
        MarshallEducater
      </button>
      <nav className="nav">
        <button className={is('home')} data-testid="nav-home" onClick={() => nav.go({ screen: 'home' })}>
          ホーム
        </button>
        {projectId && (
          <>
            <button className={is('dashboard')} data-testid="nav-dashboard" onClick={() => nav.go({ screen: 'dashboard', projectId })}>
              ダッシュボード
            </button>
            <button className={is('plan')} data-testid="nav-plan" onClick={() => nav.go({ screen: 'plan', projectId })}>
              学習計画
            </button>
            <button className={is('import')} data-testid="nav-import" onClick={() => nav.go({ screen: 'import', projectId })}>
              取り込み
            </button>
          </>
        )}
      </nav>
      <nav className="nav right">
        <button className={is('jobs')} data-testid="nav-jobs" onClick={() => nav.go({ screen: 'jobs', projectId })}>
          ジョブ一覧
        </button>
        <button className={is('settings')} data-testid="nav-settings" onClick={() => nav.go({ screen: 'settings', projectId })}>
          設定
        </button>
      </nav>
    </header>
  );
}

export function App() {
  const [stack, setStack] = useState<Route[]>([{ screen: 'home' }]);
  const route = stack[stack.length - 1];
  const go = useCallback((r: Route) => setStack((s) => [...s.slice(-30), r]), []);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const nav = useMemo<Nav>(() => ({ route, go, back }), [route, go, back]);
  return (
    <NavContext.Provider value={nav}>
      <JobsProvider>
        <div className="app">
          <Header nav={nav} />
          <main className="main" key={JSON.stringify(route)}>
            <Screen route={route} />
          </main>
          <JobBar />
        </div>
      </JobsProvider>
    </NavContext.Provider>
  );
}
