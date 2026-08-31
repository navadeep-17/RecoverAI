import { useQuery } from '@tanstack/react-query';
import { getEvaluation } from '../api/evaluation';
import { ErrorState, LoadingState } from '../components/ui/State';

const money = (paise: string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(paise) / 100);

export function EvaluationPage() {
  const query = useQuery({ queryKey: ['evaluation'], queryFn: getEvaluation });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} retry={() => query.refetch()} />;
  const snapshot = query.data;
  return <div className="space-y-6"><section><p className="eyebrow">SYNTHETIC BENCHMARK</p><h1 className="page-title">Frozen evaluation snapshot</h1><p className="page-copy">Synthetic decision/safety benchmark — not production revenue recovered.</p></section>
    <section className="grid gap-4 md:grid-cols-4"><Fact label="Evaluation set" value={`${snapshot.scenarioCount} scenarios`} /><Fact label="Frozen" value={snapshot.frozen ? 'Yes' : 'No'} /><Fact label="Fingerprint" value={snapshot.evaluatorFingerprint} /><Fact label="Approved checkpoint" value={snapshot.approvedCheckpoint} /></section>
    <section className="card overflow-x-auto"><h2 className="font-semibold">Heldout strategy comparison</h2><table className="mt-4 w-full text-left text-sm"><thead className="border-b text-xs uppercase text-slate-500"><tr><th className="p-2">Strategy</th><th className="p-2">Synthetic recovery rate</th><th className="p-2">Synthetic recovered amount</th><th className="p-2">Unsafe proposal/ledger entries</th><th className="p-2">Policy violations</th></tr></thead><tbody>{snapshot.results.map((result) => <tr key={result.strategy} className="border-b last:border-0"><td className="p-2 font-semibold">{result.strategy}</td><td className="p-2">{(result.metrics.recoveryRate * 100).toFixed(2)}%</td><td className="p-2">{money(result.metrics.revenueRecoveredPaise)}</td><td className="p-2">{result.metrics.unsafeActions}</td><td className={`p-2 font-semibold ${result.metrics.policyViolations === 0 ? 'text-emerald-700' : 'text-amber-700'}`}>{result.metrics.policyViolations}</td></tr>)}</tbody></table></section>
    <section className="card text-sm text-slate-600"><h2 className="font-semibold text-slate-900">How to read this benchmark</h2><p className="mt-2">Unsafe proposal/ledger entries counts unsafe proposed or recorded actions in the synthetic evaluation ledger; it does not imply the side effect executed in production.</p><p className="mt-2">Review/escalation scenarios are treated conservatively by the frozen benchmark and do not model the full real-world post-review customer-payment lifecycle.</p><p className="mt-2 text-xs">Source: {snapshot.artifact} · split: {snapshot.split} · seed: {snapshot.seed}</p></section>
  </div>;
}
function Fact({ label, value }: { label: string; value: string }) { return <div className="card"><p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p><p className="mt-2 break-all text-sm font-semibold text-slate-950">{value}</p></div>; }
