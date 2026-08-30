import { useQuery } from '@tanstack/react-query';
import { Activity, CircleAlert, ShieldCheck, TrendingUp } from 'lucide-react';
import { getRevenueRadarMetrics } from '../api/cases';
import { ErrorState, EmptyState, LoadingState } from '../components/ui/State';
import { formatMoney, riskLabel, statusLabel } from '../lib/format';

export function RevenueRadarPage() {
  const query = useQuery({ queryKey: ['revenue-radar-metrics'], queryFn: getRevenueRadarMetrics });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} retry={() => query.refetch()} />;
  const metricsResponse = query.data;
  const metrics = [
    ['Revenue at risk', formatMoney(metricsResponse.revenueAtRisk), 'Active cases only', CircleAlert, 'text-amber-600'],
    ['Verified revenue recovered', formatMoney(metricsResponse.verifiedRecovered), 'Persisted recovered amounts only', TrendingUp, 'text-emerald-600'],
    ['Active recoveries', String(metricsResponse.activeRecoveries), 'Open, waiting, or under review', Activity, 'text-sky-600'],
    ['Needs human review', String(metricsResponse.needsReview), 'Policy-routed cases', ShieldCheck, 'text-violet-600'],
  ];
  return <div className="space-y-6"><div><p className="eyebrow">REVENUE RADAR</p><h1 className="page-title">Recovery operations, grounded in evidence</h1><p className="page-copy">AI proposes. Policy decides. Executor acts. Observer verifies.</p></div>
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{metrics.map(([label, value, detail, Icon, tone]) => <section key={label as string} className="card"><div className="flex items-start justify-between"><p className="text-sm font-medium text-slate-600">{label as string}</p><Icon className={`h-5 w-5 ${tone as string}`} /></div><p className="mt-4 text-2xl font-bold tracking-tight text-slate-950">{value as string}</p><p className="mt-1 text-xs text-slate-500">{detail as string}</p></section>)}</div>
    {metricsResponse.activeRecoveries === 0 && Object.keys(metricsResponse.statusBreakdown).length === 0 ? <EmptyState title="No recovery cases yet" detail="When verified revenue-risk events arrive, RecoverAI will surface policy-governed recovery work here." /> : <div className="grid gap-5 xl:grid-cols-2"><MoneyDistribution title="Revenue at risk by risk type" values={metricsResponse.riskTypeBreakdown} /><CountDistribution title="Cases by lifecycle status" values={metricsResponse.statusBreakdown} /></div>}
  </div>;
}
function MoneyDistribution({ title, values }: { title: string; values: Record<string, { count: number; amountAtRisk: string }> }) { return <section className="card"><h2 className="font-semibold text-slate-900">{title}</h2><div className="mt-5 space-y-3">{Object.entries(values).map(([key, value]) => <div key={key} className="flex items-center justify-between text-sm"><span className="text-slate-600">{riskLabel(key as never)}</span><span className="font-semibold text-slate-900">{formatMoney(value.amountAtRisk)}</span></div>)}</div></section>; }
function CountDistribution({ title, values }: { title: string; values: Record<string, number> }) { return <section className="card"><h2 className="font-semibold text-slate-900">{title}</h2><div className="mt-5 space-y-3">{Object.entries(values).map(([key, value]) => <div key={key} className="flex items-center justify-between text-sm"><span className="text-slate-600">{statusLabel(key as never)}</span><span className="font-semibold text-slate-900">{value}</span></div>)}</div></section>; }
