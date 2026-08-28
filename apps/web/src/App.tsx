import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ShieldCheck, Activity, AlertCircle, ArrowUpRight } from 'lucide-react';

const queryClient = new QueryClient();

export function AppShell() {
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center space-x-3">
          <div className="bg-sky-600 text-white p-2 rounded-lg font-bold">RAI</div>
          <div>
            <h1 className="text-lg font-semibold text-slate-900">RecoverAI</h1>
            <p className="text-xs text-slate-500">Autonomous Revenue Recovery Control Plane</p>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
            <span className="w-2 h-2 mr-1.5 bg-green-500 rounded-full"></span>
            Policy Firewall Active
          </span>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-500">Revenue at Risk</span>
              <AlertCircle className="w-5 h-5 text-amber-500" />
            </div>
            <p className="text-2xl font-bold text-slate-900 mt-2">₹0.00</p>
            <span className="text-xs text-slate-400">Across active cases</span>
          </div>

          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-500">Recovered by RecoverAI</span>
              <ArrowUpRight className="w-5 h-5 text-emerald-500" />
            </div>
            <p className="text-2xl font-bold text-emerald-600 mt-2">₹0.00</p>
            <span className="text-xs text-emerald-600">Verified safe recoveries</span>
          </div>

          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-500">Active Recoveries</span>
              <Activity className="w-5 h-5 text-sky-500" />
            </div>
            <p className="text-2xl font-bold text-slate-900 mt-2">0</p>
            <span className="text-xs text-slate-400">Open & waiting workflows</span>
          </div>

          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-500">Needs Attention</span>
              <ShieldCheck className="w-5 h-5 text-indigo-500" />
            </div>
            <p className="text-2xl font-bold text-slate-900 mt-2">0</p>
            <span className="text-xs text-slate-400">Human review inbox</span>
          </div>
        </div>

        <section className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm text-center py-12">
          <h2 className="text-lg font-semibold text-slate-800">Command Center Bootstrapped</h2>
          <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
            Phase 0 Foundation established. Ready for Core Domain, Policy Engine, Event Ingestion,
            and Closed-Loop Recovery.
          </p>
        </section>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>
  );
}
