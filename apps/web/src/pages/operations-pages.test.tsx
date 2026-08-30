// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RevenueRadarPage } from './RevenueRadarPage';
import { RecoveriesPage } from './RecoveriesPage';
import { CaseDetailPage } from './CaseDetailPage';

const api = vi.hoisted(() => ({ getRevenueRadarMetrics: vi.fn(), listCases: vi.fn(), getCase: vi.fn() }));
vi.mock('../api/cases', () => api);

function renderPage(node: React.ReactNode) { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>); }
const caseItem = { id: 'case-1', customerId: 'customer-1', riskType: 'PAYMENT_FAILURE' as const, amountAtRisk: '14999.99', recoveredAmount: '0.10', currency: 'INR', status: 'OPEN' as const, openedAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-02T00:00:00.000Z', customer: { id: 'customer-1', name: 'Ada', email: 'ada@example.test' } };

describe('operational pages', () => {
  it('renders API-provided authoritative radar totals and monetary risk distribution', async () => {
    api.getRevenueRadarMetrics.mockResolvedValue({ revenueAtRisk: '15000.00', verifiedRecovered: '0.30', activeRecoveries: 51, needsReview: 1, riskTypeBreakdown: { PAYMENT_FAILURE: { count: 51, amountAtRisk: '15000.00' } }, statusBreakdown: { OPEN: 50, NEEDS_REVIEW: 1 } });
    renderPage(<RevenueRadarPage />);
    expect((await screen.findAllByText('₹15,000.00')).length).toBe(2);
    expect(screen.getByText('₹0.30')).toBeTruthy();
    expect(screen.getByText('Revenue at risk by risk type')).toBeTruthy();
    expect(screen.getByText('Payment failure')).toBeTruthy();
  });

  it('renders an intentional empty dashboard state', async () => {
    api.getRevenueRadarMetrics.mockResolvedValue({ revenueAtRisk: '0.00', verifiedRecovered: '0.00', activeRecoveries: 0, needsReview: 0, riskTypeBreakdown: {}, statusBreakdown: {} });
    renderPage(<RevenueRadarPage />);
    expect(await screen.findByText('No recovery cases yet')).toBeTruthy();
  });

  it('renders recoveries, canonical badges, and navigates on selection', async () => {
    api.listCases.mockResolvedValue({ cases: [caseItem] });
    const navigate = vi.fn();
    renderPage(<RecoveriesPage navigate={navigate} />);
    expect(await screen.findByText('Ada')).toBeTruthy();
    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getByText('Payment failure')).toBeTruthy();
    fireEvent.click(screen.getByText('Ada'));
    expect(navigate).toHaveBeenCalledWith('/recoveries/case-1');
  });

  it('renders persisted plan, action, outcome, and audit evidence without oracle fields', async () => {
    api.getCase.mockResolvedValue({ case: { ...caseItem, planVersions: [{ id: 'plan-1', version: 1, diagnosisCode: 'DECLINED', diagnosisSummary: 'Payment declined', confidence: 0.9, proposedActionType: 'SEND_PAYMENT_LINK', reasoningSummary: 'Persisted evidence', createdAt: '2025-01-01T00:00:00.000Z' }], actions: [{ id: 'action-1', actionType: 'SEND_PAYMENT_LINK', status: 'SUCCESS', policyDecision: 'ALLOW', policyRationale: 'Within policy', providerName: 'razorpay-test', createdAt: '2025-01-01T00:00:00.000Z', executedAt: '2025-01-01T00:01:00.000Z' }], outcomes: [{ id: 'outcome-1', outcomeType: 'PAYMENT_SUCCEEDED', amountRecovered: '0.10', observedAt: '2025-01-01T00:02:00.000Z' }] }, auditEvents: [{ id: 'audit-1', eventType: 'OUTCOME_RECORDED', actorType: 'SYSTEM', reasonCode: 'VERIFIED', createdAt: '2025-01-01T00:02:00.000Z' }] });
    renderPage(<CaseDetailPage caseId="case-1" navigate={vi.fn()} />);
    expect(await screen.findByText('Payment declined')).toBeTruthy();
    expect(screen.getByText('SEND PAYMENT LINK')).toBeTruthy();
    expect(screen.getByText('PAYMENT_SUCCEEDED')).toBeTruthy();
    expect(screen.getByText('OUTCOME_RECORDED')).toBeTruthy();
    expect(screen.queryByText(/oracle/i)).toBeNull();
  });

  it('shows a retryable visible API error', async () => {
    api.getRevenueRadarMetrics.mockRejectedValueOnce(new Error('API unavailable')).mockResolvedValueOnce({ revenueAtRisk: '0.00', verifiedRecovered: '0.00', activeRecoveries: 0, needsReview: 0, riskTypeBreakdown: {}, statusBreakdown: {} });
    renderPage(<RevenueRadarPage />);
    expect(await screen.findByText('API unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.getByText('No recovery cases yet')).toBeTruthy());
  });
});
