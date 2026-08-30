import type { RecoveryCase } from '../types/cases';
export function deriveRadarMetrics(cases: RecoveryCase[]) {
  const active = cases.filter((item) => ['OPEN', 'WAITING', 'NEEDS_REVIEW'].includes(item.status));
  const sum = (items: RecoveryCase[], read: (item: RecoveryCase) => string | null | undefined) => items.reduce((total, item) => total + Number(read(item) || 0), 0).toFixed(2);
  return {
    active,
    revenueAtRisk: sum(active, (item) => item.amountAtRisk),
    verifiedRecovered: sum(cases, (item) => item.outcomes?.reduce((total, outcome) => total + Number(outcome.amountRecovered || 0), 0).toFixed(2) || item.recoveredAmount),
    needsReview: cases.filter((item) => item.status === 'NEEDS_REVIEW').length,
  };
}
