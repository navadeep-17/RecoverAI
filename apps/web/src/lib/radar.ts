import type { RecoveryCase } from '../types/cases';
import { sumMoney } from './money';
export function deriveRadarMetrics(cases: RecoveryCase[]) {
  const active = cases.filter((item) => ['OPEN', 'WAITING', 'NEEDS_REVIEW'].includes(item.status));
  return {
    active,
    revenueAtRisk: sumMoney(active.map((item) => item.amountAtRisk)),
    verifiedRecovered: sumMoney(cases.map((item) => item.recoveredAmount)),
    needsReview: cases.filter((item) => item.status === 'NEEDS_REVIEW').length,
  };
}
