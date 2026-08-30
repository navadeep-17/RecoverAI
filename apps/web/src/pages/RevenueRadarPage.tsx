import { useQuery } from '@tanstack/react-query';
import { Activity, CircleAlert, ShieldCheck, TrendingUp } from 'lucide-react';
import { listCases } from '../api/cases';
import { ErrorState, EmptyState, LoadingState } from '../components/ui/State';
import { formatMoney, riskLabel, statusLabel } from '../lib/format';
import { deriveRadarMetrics } from '../lib/radar';
import type { RecoveryCase } from '../types/cases';

export function RevenueRadarPage() {
  const query = useQuery({ queryKey: ['cases'], queryFn: () => listCases() });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} retry={() => query.refetch()} />;
  const cases = query.data.cases;
  const { active, revenueAtRisk, verifiedRecovered, needsReview } = deriveRadarMetrics(cases);
  const metrics = [
    ['Revenue at risk', formatMoney(revenueAtRisk), 'Active cases only', CircleAlert, 'text-amber-600'],
    ['Verified revenue recovered', formatMoney(verifiedRecovered), 'Authoritative outcome evidence', TrendingUp, 'text-emerald-600'],
    ['Active recoveries', String(active.length), 'Open, waiting, or under review', Activity, 'text-sky-600'],
    ['Needs human review', String(needsReview), 'Policy-routed cases', ShieldCheck, 'text-violet-600'],
  ];
  return <div className="space-y-6"><div><p className="eyebrow">REVENUE RADAR</p><h1 className="page-title">Recovery operations, grounded in evidence</h1><p className="page-copy">AI proposes. Policy decides. Executor acts. Observer verifies.</p></div>
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{metrics.map(([label, value, detail, Icon, tone]) => <section key={label as string} className="card"><div className="flex items-start justify-between"><p className="text-sm font-medium text-slate-600">{label as string}</p><Icon className={`h-5 w-5 ${tone as string}`} /></div><p className="mt-4 text-2xl font-bold tracking-tight text-slate-950">{value as string}</p><p className="mt-1 text-xs text-slate-500">{detail as string}</p></section>)}</div>
    {cases.length === 0 ? <EmptyState title="No recovery cases yet" detail="When verified revenue-risk events arrive, RecoverAI will surface policy-governed recovery work here." /> : <div className="grid gap-5 xl:grid-cols-2"><Distribution title="Revenue at risk by risk type" cases={active} group={(item) => riskLabel(item.riskType)} /><Distribution title="Cases by lifecycle status" cases={cases} group={(item) => statusLabel(item.status)} /></div>}
  </div>;
}
function Distribution({ title, cases, group }: { title: string; cases: RecoveryCase[]; group: (item: RecoveryCase) => string | undefined }) { const values = cases.reduce<Record<string, number>>((all, item) => { const key = group(item) || 'Unknown'; all[key] = (all[key] || 0) + 1; return all; }, {}); return <section className="card"><h2 className="font-semibold text-slate-900">{title}</h2><div className="mt-5 space-y-3">{Object.entries(values).map(([key, value]) => <div key={key} className="flex items-center justify-between text-sm"><span className="text-slate-600">{key}</span><span className="font-semibold text-slate-900">{value}</span></div>)}</div></section>; }
