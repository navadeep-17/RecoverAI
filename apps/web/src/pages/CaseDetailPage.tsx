import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { getCase } from '../api/cases';
import { StatusBadge } from '../components/ui/Badge';
import { ErrorState, LoadingState } from '../components/ui/State';
import { formatDate, formatMoney, riskLabel } from '../lib/format';
import { sumMoney } from '../lib/money';

export function CaseDetailPage({ caseId, navigate }: { caseId: string; navigate: (path: string) => void }) {
  const query = useQuery({ queryKey: ['case', caseId], queryFn: () => getCase(caseId) });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} retry={() => query.refetch()} />;

  const { case: item, auditEvents } = query.data;
  const plan = item.planVersions?.[0];
  const action = item.actions?.[0];
  const outcomes = item.outcomes ?? [];
  const recovered = item.recoveredAmount ?? sumMoney(outcomes.map((outcome) => outcome.amountRecovered));
  const lifecycle = [
    ['DETECT', true], ['DIAGNOSE', Boolean(plan?.diagnosisCode)], ['PLAN', Boolean(plan)],
    ['POLICY CHECK', Boolean(action?.policyDecision)], ['ACT', Boolean(action?.executedAt)],
    ['OBSERVE', Boolean(outcomes.length)], ['REPLAN', (item.planVersions?.length || 0) > 1],
  ];

  return <div className="space-y-6">
    <button onClick={() => navigate('/recoveries')} className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-slate-950"><ArrowLeft className="h-4 w-4" />Back to recoveries</button>
    <section className="card">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="eyebrow">CASE DETAIL</p><h1 className="page-title">{item.id}</h1><p className="page-copy">{item.customer?.name || item.customer?.email || 'Customer identity unavailable'} · {riskLabel(item.riskType)}</p></div><StatusBadge status={item.status} /></div>
      <div className="mt-6 grid gap-4 sm:grid-cols-4"><Fact label="Amount at risk" value={formatMoney(item.amountAtRisk, item.currency)} /><Fact label="Verified recovered" value={formatMoney(recovered, item.currency)} /><Fact label="Recovery attribution" value={outcomes.some((outcome) => outcome.actionId) ? 'Agent-attributed verified recovery' : outcomes.length ? 'Organic / unattributed verified recovery' : 'No verified recovery yet'} /><Fact label="Opened" value={formatDate(item.openedAt)} /></div>
    </section>
    <section className="card"><h2 className="font-semibold text-slate-950">Agent lifecycle</h2><p className="mt-1 text-sm text-slate-500">Derived from persisted plan, action, outcome, and audit evidence.</p><div className="mt-5 grid gap-2 sm:grid-cols-4 xl:grid-cols-7">{lifecycle.map(([label, complete]) => <div key={label as string} className={`rounded-lg border p-3 text-xs font-semibold ${complete ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-slate-50 text-slate-400'}`}>{complete ? '✓ ' : '○ '}{label as string}</div>)}</div></section>
    <div className="grid gap-5 xl:grid-cols-2">
      <Panel title="Diagnosis / case facts"><p className="font-medium text-slate-900">{plan?.diagnosisSummary || 'No persisted diagnosis yet.'}</p><p className="mt-3 text-sm text-slate-600">{riskLabel(item.riskType)} case opened {formatDate(item.openedAt)}. Operational evidence is shown below.</p></Panel>
      <Panel title="Recovery plan">{plan ? <div className="space-y-2 text-sm"><p><b>Version {plan.version}</b> · {plan.proposedActionType.replaceAll('_', ' ')}</p><p>Confidence: {Math.round(plan.confidence * 100)}%</p><p className="text-slate-600">{plan.reasoningSummary || 'No stored reasoning summary.'}</p></div> : <p className="text-sm text-slate-500">No plan version exists.</p>}</Panel>
      <Panel title="Policy decision">{action ? <div className="text-sm"><p className="font-semibold">{action.policyDecision}</p><p className="mt-2 text-slate-600">{action.policyRationale || 'No persisted policy rationale.'}</p></div> : <p className="text-sm text-slate-500">No authorized action exists.</p>}</Panel>
      <Panel title="Actions">{item.actions?.length ? <ul className="space-y-3">{item.actions.map((entry) => <li key={entry.id} className="text-sm"><p className="font-semibold">{entry.actionType.replaceAll('_', ' ')}</p><p className="text-slate-500">{entry.status} · {entry.providerName || 'No provider'} · {formatDate(entry.executedAt || entry.createdAt)}</p></li>)}</ul> : <p className="text-sm text-slate-500">No actions have been authorized.</p>}</Panel>
      <Panel title="Outcomes">{outcomes.length ? <ul className="space-y-3">{outcomes.map((outcome) => <li key={outcome.id} className="text-sm"><p className="font-semibold">{outcome.outcomeType}</p><p className="text-slate-500">{formatMoney(outcome.amountRecovered, item.currency)} · {formatDate(outcome.observedAt)}</p><p className="text-slate-600">{outcome.actionId ? 'Agent-attributed verified recovery' : 'Organic / unattributed verified recovery'}</p></li>)}</ul> : <p className="text-sm text-slate-500">No authoritative outcomes observed.</p>}</Panel>
      <Panel title="Audit timeline">{auditEvents.length ? <ol className="space-y-3">{auditEvents.map((event) => <li key={event.id} className="border-l-2 border-slate-200 pl-3 text-sm"><p className="font-semibold">{event.eventType}</p><p className="text-slate-500">{event.reasonCode || event.actorType} · {formatDate(event.createdAt)}</p></li>)}</ol> : <p className="text-sm text-slate-500">No audit events available.</p>}</Panel>
    </div>
  </div>;
}

function Fact({ label, value }: { label: string; value: string }) { return <div><p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p><p className="mt-1 font-semibold text-slate-950">{value}</p></div>; }
function Panel({ title, children }: { title: string; children: ReactNode }) { return <section className="card"><h2 className="font-semibold text-slate-950">{title}</h2><div className="mt-4">{children}</div></section>; }
