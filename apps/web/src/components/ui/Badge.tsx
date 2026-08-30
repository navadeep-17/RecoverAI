import clsx from 'clsx';
import { riskLabel, statusLabel } from '../../lib/format';
import type { CaseStatus, RiskType } from '../../types/cases';

export function StatusBadge({ status }: { status: CaseStatus }) {
  const tone: Record<CaseStatus, string> = { OPEN: 'bg-sky-50 text-sky-700', WAITING: 'bg-amber-50 text-amber-700', NEEDS_REVIEW: 'bg-violet-50 text-violet-700', RECOVERED: 'bg-emerald-50 text-emerald-700', STOPPED: 'bg-slate-100 text-slate-600', EXHAUSTED: 'bg-rose-50 text-rose-700' };
  return <span className={clsx('inline-flex rounded-full px-2.5 py-1 text-xs font-semibold', tone[status])}>{statusLabel(status)}</span>;
}
export function RiskBadge({ risk }: { risk: RiskType }) { return <span className="text-xs font-medium text-slate-600">{riskLabel(risk)}</span>; }
