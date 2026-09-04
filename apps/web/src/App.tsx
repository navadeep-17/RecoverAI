import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Activity, BarChart3, BrainCircuit, ClipboardCheck, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { RevenueRadarPage } from './pages/RevenueRadarPage';
import { RecoveriesPage } from './pages/RecoveriesPage';
import { CaseDetailPage } from './pages/CaseDetailPage';
import { HumanReviewsPage } from './pages/HumanReviewsPage';
import { EvaluationPage } from './pages/EvaluationPage';
import { PolicySettingsPage } from './pages/PolicySettingsPage';
import { IntegrationStatus } from './components/IntegrationStatus';
import './index.css';

const queryClient = new QueryClient();

function Shell() {
  const [path, setPath] = useState(window.location.pathname);
  const navigate = (next: string) => {
    window.history.pushState({}, '', next);
    setPath(next);
  };
  useEffect(() => {
    const handler = () => setPath(window.location.pathname);
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);
  const detail = path.match(/^\/recoveries\/([^/]+)$/);
  const reviewDetail = path.match(/^\/reviews\/([^/]+)$/);
  const activePath = detail ? '/recoveries' : reviewDetail ? '/reviews' : path;
  const nav = [
    { label: 'Revenue Radar', path: '/', icon: BarChart3 },
    { label: 'Active Recoveries', path: '/recoveries', icon: Activity },
    { label: 'Human Review', path: '/reviews', icon: ClipboardCheck },
    { label: 'Evaluation', path: '/evaluation', icon: BrainCircuit },
    { label: 'Policy Settings', path: '/policy', icon: ShieldCheck },
  ];
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <aside className="fixed inset-y-0 hidden w-64 border-r border-slate-200 bg-white p-5 lg:block">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-slate-950 p-2 text-xs font-bold text-white">RAI</div>
          <div>
            <p className="font-bold">RecoverAI</p>
            <p className="text-xs text-slate-500">Revenue recovery control plane</p>
          </div>
        </div>
        <nav className="mt-10 space-y-1">
          {nav.map((item) => (
            <button key={item.label} onClick={() => navigate(item.path)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium ${item.path === activePath ? 'bg-slate-950 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
              <item.icon className="h-4 w-4" />
              {item.label}
            </button>
          ))}
        </nav>
        <IntegrationStatus />
      </aside>
      <div className="lg:pl-64">
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-slate-200 bg-white/95 px-5 backdrop-blur">
          <p className="text-sm font-medium text-slate-600">Policy-Governed Autonomous Revenue Recovery</p>
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">Policy controls active</span>
        </header>
        <main className="mx-auto max-w-7xl p-5 md:p-8">{detail ? <CaseDetailPage caseId={decodeURIComponent(detail[1])} navigate={navigate} /> : path === '/recoveries' ? <RecoveriesPage navigate={navigate} /> : path === '/reviews' || reviewDetail ? <HumanReviewsPage reviewId={reviewDetail ? decodeURIComponent(reviewDetail[1]) : undefined} navigate={navigate} /> : path === '/evaluation' ? <EvaluationPage /> : path === '/policy' ? <PolicySettingsPage /> : <RevenueRadarPage />}</main>
      </div>
    </div>
  );
}
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Shell />
    </QueryClientProvider>
  );
}
