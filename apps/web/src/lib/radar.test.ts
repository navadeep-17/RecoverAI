import { describe, expect, it } from 'vitest';
import { deriveRadarMetrics } from './radar';
import { riskLabel, statusLabel } from './format';

describe('operational UI data contracts', () => {
  it('derives radar totals only from authoritative case/outcome fields', () => {
    const metrics = deriveRadarMetrics([{ id: 'case_1', merchantId: 'm', riskType: 'PAYMENT_FAILURE', amountAtRisk: '14999.00', recoveredAmount: null, currency: 'INR', status: 'OPEN', openedAt: '2026-01-01T00:00:00Z', outcomes: [{ id: 'out_1', outcomeType: 'PAYMENT_SUCCEEDED', amountRecovered: '14999.00', observedAt: '2026-01-02T00:00:00Z' }] }]);
    expect(metrics.revenueAtRisk).toBe('14999.00');
    expect(metrics.verifiedRecovered).toBe('14999.00');
    expect(metrics.active).toHaveLength(1);
  });
  it('renders empty data as zero metrics and canonical labels', () => {
    expect(deriveRadarMetrics([])).toMatchObject({ revenueAtRisk: '0.00', verifiedRecovered: '0.00', needsReview: 0 });
    expect(riskLabel('CHECKOUT_ABANDONMENT')).toBe('Checkout abandonment');
    expect(statusLabel('NEEDS_REVIEW')).toBe('Needs Review');
  });
});
