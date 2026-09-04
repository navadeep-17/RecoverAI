import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { getCase } from '../api/cases';
import { StatusBadge } from '../components/ui/Badge';
import { ErrorState, LoadingState } from '../components/ui/State';
import { formatDate, formatMoney, riskLabel } from '../lib/format';

export function CaseDetailPage({ caseId, navigate }: { caseId: string; navigate: (path: string) => void }) {
  const query = useQuery({ queryKey: ['case', caseId], queryFn: () => getCase(caseId) });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} retry={() => query.refetch()} />;

  const { case: item, auditEvents } = query.data;
  const plan = item.planVersions?.[0];
  const action = item.actions?.[0];
  const outcomes = item.outcomes ?? [];
  const winner = item.recoveryOutcome ?? null;
  const context = item.contextJson ?? {};
  const attribution = winner ? (winner.actionId ? 'Agent-attributed verified recovery' : 'Organic / unattributed verified recovery') : 'No verified recovery yet';
  const verifiedRecovered = winner?.amountRecovered ? formatMoney(winner.amountRecovered, item.currency) : 'No verified recovery yet';
  const lifecycle = [
    ['DETECT', true],
    ['DIAGNOSE', Boolean(plan?.diagnosisCode)],
    ['PLAN', Boolean(plan)],
    ['POLICY CHECK', Boolean(action?.policyDecision)],
    ['ACT', Boolean(action?.executedAt)],
    ['OBSERVE', Boolean(outcomes.length)],
    ['REPLAN', (item.planVersions?.length || 0) > 1],
  ];

  return (
    <div className="space-y-6">
      <button onClick={() => navigate('/recoveries')} className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-slate-950">
        <ArrowLeft className="h-4 w-4" />
        Back to recoveries
      </button>
      <section className="card">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="eyebrow">CASE DETAIL</p>
            <h1 className="page-title">{item.id}</h1>
            <p className="page-copy">
              {item.customer?.name || item.customer?.email || 'Customer identity unavailable'} · {riskLabel(item.riskType)}
            </p>
          </div>
          <StatusBadge status={item.status} />
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-4">
          <Fact label="Amount at risk" value={formatMoney(item.amountAtRisk, item.currency)} />
          <Fact label="Verified recovered" value={verifiedRecovered} />
          <Fact label="Recovery attribution" value={attribution} />
          <Fact label="Opened" value={formatDate(item.openedAt)} />
        </div>
      </section>
      <section className="card">
        <p className="eyebrow">RECOVERY DECISION</p>
        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Fact label="Risk" value={`${riskLabel(item.riskType)} · ${formatMoney(item.amountAtRisk, item.currency)}`} />
          <VerifiedEvidence context={context} />
          <Fact label="AI proposal" value={plan ? `${plan.proposedActionType.replaceAll('_', ' ')} · ${Math.round(plan.confidence * 100)}%` : 'Not available'} />
          <Fact label="Policy" value={action ? `${action.policyDecision} · ${action.policyRationale || 'No persisted rationale.'}` : 'Not available'} />
          <Fact label="Execution" value={action ? `${action.status} · ${providerLabel(action.providerName)}` : 'No action yet'} />
          <Fact label="Observation" value={outcomes[0] ? outcomes[0].outcomeType : 'No authoritative outcome yet'} />
          <Fact label="Replan" value={(item.planVersions?.length || 0) > 1 ? `Plan v${plan?.version}` : 'No replan yet'} />
          <Fact label="Verified outcome" value={winner?.amountRecovered ? `${formatMoney(winner.amountRecovered, item.currency)} · ${attribution}` : 'No verified recovery yet'} />
        </div>
      </section>
      <section className="card">
        <h2 className="font-semibold text-slate-950">Agent lifecycle</h2>
        <p className="mt-1 text-sm text-slate-500">Derived from persisted plan, action, outcome, and audit evidence.</p>
        <div className="mt-5 grid gap-2 sm:grid-cols-4 xl:grid-cols-7">
          {lifecycle.map(([label, complete]) => (
            <div key={label as string} className={`rounded-lg border p-3 text-xs font-semibold ${complete ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-slate-50 text-slate-400'}`}>
              {complete ? '✓ ' : '○ '}
              {label as string}
            </div>
          ))}
        </div>
      </section>
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Diagnosis / case facts">
          <p className="font-medium text-slate-900">{plan?.diagnosisSummary || 'No persisted diagnosis yet.'}</p>
          <p className="mt-3 text-sm text-slate-600">
            {riskLabel(item.riskType)} case opened {formatDate(item.openedAt)}. Operational evidence is shown below.
          </p>
        </Panel>
        <Panel title="Recovery plan">
          {plan ? (
            <div className="space-y-2 text-sm">
              <p>
                <b>Version {plan.version}</b> · {plan.proposedActionType.replaceAll('_', ' ')}
              </p>
              <p>Confidence: {Math.round(plan.confidence * 100)}%</p>
              <p className="text-slate-600">{plan.reasoningSummary || 'No stored reasoning summary.'}</p>
            </div>
          ) : (
            <p className="text-sm text-slate-500">No plan version exists.</p>
          )}
        </Panel>
        <Panel title="Policy decision">
          {action ? (
            <div className="text-sm">
              <p className="font-semibold">{action.policyDecision}</p>
              <p className="mt-2 text-slate-600">{action.policyRationale || 'No persisted policy rationale.'}</p>
            </div>
          ) : (
            <p className="text-sm text-slate-500">No authorized action exists.</p>
          )}
        </Panel>
        <Panel title="Actions">
          {item.actions?.length ? (
            <ul className="space-y-3">
              {item.actions.map((entry) => (
                <li key={entry.id} className="text-sm">
                  <p className="font-semibold">{entry.actionType.replaceAll('_', ' ')}</p>
                  <p className="text-slate-500">
                    {entry.status} · {providerLabel(entry.providerName)} · {formatDate(entry.executedAt || entry.createdAt)}
                  </p>
                  {entry.paymentLinkUrl ? (
                    <a href={entry.paymentLinkUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex rounded-lg bg-sky-600 px-3 py-2 font-semibold text-white hover:bg-sky-700">
                      Open Razorpay Test Payment Link
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">No actions have been authorized.</p>
          )}
        </Panel>
        <Panel title="Outcomes">
          {outcomes.length ? (
            <ul className="space-y-3">
              {outcomes.map((outcome) => (
                <li key={outcome.id} className="text-sm">
                  <p className="font-semibold">{outcome.outcomeType}</p>
                  <p className="text-slate-500">
                    {outcome.amountRecovered ? formatMoney(outcome.amountRecovered, item.currency) : 'No monetary amount'} · {formatDate(outcome.observedAt)}
                  </p>
                  <p className="text-slate-600">{winner?.id === outcome.id ? attribution : 'Non-monetary observation'}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">No authoritative outcomes observed.</p>
          )}
        </Panel>
        <Panel title="Audit timeline">
          {auditEvents.length ? (
            <ol className="space-y-3">
              {auditEvents.map((event) => (
                <li key={event.id} className="border-l-2 border-slate-200 pl-3 text-sm">
                  <p className="font-semibold">{event.eventType}</p>
                  <p className="text-slate-500">
                    {event.reasonCode || event.actorType} · {formatDate(event.createdAt)}
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-slate-500">No audit events available.</p>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 font-semibold text-slate-950">{value}</p>
    </div>
  );
}
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2 className="font-semibold text-slate-950">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}
function providerLabel(providerName?: string | null) {
  if (!providerName || providerName === 'UNKNOWN') return 'Internal / unclassified provider evidence';
  if (/^SIMULATED_/i.test(providerName)) return 'Simulated provider';
  if (providerName === 'RAZORPAY_TEST_MODE_PAYMENT_LINKS') return 'Razorpay Test Mode';
  return 'Internal / unclassified provider evidence';
}
function evidenceFacts(context: Record<string, unknown>) {
  const string = (key: string) => (typeof context[key] === 'string' ? (context[key] as string) : null);
  const retry = typeof context.retryAttemptNumber === 'number' ? String(context.retryAttemptNumber) : null;
  const network = string('cardNetwork');
  const last4 = string('cardLast4');
  return [
    ['Failure', string('verifiedPaymentFailureCode')],
    ['Method', string('paymentMethod')],
    ['Card', network ? (last4 ? `${network} •••• ${last4}` : network) : null],
    ['Bank', string('bankName')],
    ['Retry attempt', retry],
    ['Gateway', string('gatewayErrorMessage')],
  ].filter((fact): fact is [string, string] => Boolean(fact[1]));
}
function VerifiedEvidence({ context }: { context: Record<string, unknown> }) {
  const facts = evidenceFacts(context);
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Verified evidence</p>
      {facts.length ? (
        <dl className="mt-1 space-y-1 text-sm font-semibold text-slate-950">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className="inline text-slate-500">{label}: </dt>
              <dd className="inline">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-1 font-semibold text-slate-950">Not available</p>
      )}
    </div>
  );
}
