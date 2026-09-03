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
    api.getRevenueRadarMetrics.mockResolvedValue({ revenueAtRisk: '15000.00', verifiedRecovered: '0.30', agentAttributedRecovered: '0.10', activeRecoveries: 51, needsReview: 1, riskTypeBreakdown: { PAYMENT_FAILURE: { count: 51, amountAtRisk: '15000.00' } }, statusBreakdown: { OPEN: 50, NEEDS_REVIEW: 1 } });
    renderPage(<RevenueRadarPage />);
    expect((await screen.findAllByText('₹15,000.00')).length).toBe(2);
    expect(screen.getByText('₹0.30')).toBeTruthy();
    expect(screen.getByText('Revenue at risk by risk type')).toBeTruthy();
    expect(screen.getByText('Agent-attributed recovered')).toBeTruthy();
    expect(screen.getByText('Payment failure')).toBeTruthy();
  });

  it('renders an intentional empty dashboard state', async () => {
    api.getRevenueRadarMetrics.mockResolvedValue({ revenueAtRisk: '0.00', verifiedRecovered: '0.00', agentAttributedRecovered: '0.00', activeRecoveries: 0, needsReview: 0, riskTypeBreakdown: {}, statusBreakdown: {} });
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

  it('renders structured safe evidence, winning attribution, replan, and provider classification', async () => {
    api.getCase.mockResolvedValue({ case: { ...caseItem, status: 'RECOVERED', contextJson: { verifiedPaymentFailureCode: 'CARD_EXPIRED', gatewayErrorMessage: 'issuer declined', paymentMethod: 'card', cardNetwork: 'Visa', cardLast4: '4242', bankName: 'HDFC', retryAttemptNumber: 2 }, recoveryOutcome: { id: 'outcome-1', outcomeType: 'PAYMENT_SUCCEEDED', amountRecovered: '0.10', actionId: 'action-1' }, planVersions: [{ id: 'plan-2', version: 2, diagnosisCode: 'DECLINED', diagnosisSummary: 'Payment declined', confidence: 0.92, proposedActionType: 'SEND_PAYMENT_LINK', reasoningSummary: 'Persisted evidence', createdAt: '2025-01-02T00:00:00.000Z' }, { id: 'plan-1', version: 1, diagnosisCode: 'DECLINED', diagnosisSummary: 'Payment declined', confidence: 0.9, proposedActionType: 'SCHEDULE_FOLLOWUP', reasoningSummary: 'Earlier evidence', createdAt: '2025-01-01T00:00:00.000Z' }], actions: [{ id: 'action-1', actionType: 'SEND_PAYMENT_LINK', status: 'SUCCESS', policyDecision: 'ALLOW', policyRationale: 'Within policy', providerName: null, createdAt: '2025-01-01T00:00:00.000Z', executedAt: '2025-01-01T00:01:00.000Z' }], outcomes: [{ id: 'outcome-1', outcomeType: 'PAYMENT_SUCCEEDED', amountRecovered: '0.10', actionId: 'action-1', observedAt: '2025-01-01T00:02:00.000Z' }] }, auditEvents: [{ id: 'audit-1', eventType: 'OUTCOME_RECORDED', actorType: 'SYSTEM', reasonCode: 'VERIFIED', createdAt: '2025-01-01T00:02:00.000Z' }] });
    renderPage(<CaseDetailPage caseId="case-1" navigate={vi.fn()} />);
    expect(await screen.findByText('RECOVERY DECISION')).toBeTruthy();
    for (const value of ['Failure:', 'CARD_EXPIRED', 'Method:', 'card', 'Card:', 'Visa •••• 4242', 'Bank:', 'HDFC', 'Retry attempt:', '2', 'Gateway:', 'issuer declined', 'SEND PAYMENT LINK · 92%', 'Plan v2', 'SUCCESS · Internal / unclassified provider evidence', 'OUTCOME_RECORDED']) expect(screen.getByText(value)).toBeTruthy();
    expect(screen.getAllByText('Agent-attributed verified recovery').length).toBeGreaterThan(0);
    expect(screen.queryByText(/oracle/i)).toBeNull();
  });

  it('uses only an organic winning outcome for attribution despite an unrelated action-bound observation', async () => {
    api.getCase.mockResolvedValue({ case: { ...caseItem, status: 'RECOVERED', recoveryOutcome: { id: 'winning-organic', outcomeType: 'PAYMENT_SUCCEEDED', amountRecovered: '0.10', actionId: null }, planVersions: [], actions: [], outcomes: [{ id: 'unrelated-update', outcomeType: 'PAYMENT_METHOD_UPDATED', amountRecovered: null, actionId: 'action-update', observedAt: '2025-01-01T00:02:00.000Z' }, { id: 'winning-organic', outcomeType: 'PAYMENT_SUCCEEDED', amountRecovered: '0.10', actionId: null, observedAt: '2025-01-01T00:01:00.000Z' }] }, auditEvents: [] });
    renderPage(<CaseDetailPage caseId="case-1" navigate={vi.fn()} />);
    expect((await screen.findAllByText('Organic / unattributed verified recovery')).length).toBeGreaterThan(0);
    expect(screen.getByText('Non-monetary observation')).toBeTruthy();
    expect(screen.queryByText('Agent-attributed verified recovery')).toBeNull();
  });

  it('keeps unknown provider evidence unclassified and recognizes only explicit simulated and Razorpay Test Mode identities', async () => {
    api.getCase.mockResolvedValue({ case: { ...caseItem, planVersions: [], outcomes: [], actions: [{ id: 'unknown', actionType: 'SEND_PAYMENT_LINK', status: 'SUCCESS', policyDecision: 'ALLOW', providerName: 'some-provider', createdAt: '2025-01-01T00:00:00.000Z' }, { id: 'simulated', actionType: 'SEND_PAYMENT_LINK', status: 'SUCCESS', policyDecision: 'ALLOW', providerName: 'SIMULATED_RECOVERY_PROVIDER', createdAt: '2025-01-01T00:00:00.000Z' }, { id: 'razorpay', actionType: 'SEND_PAYMENT_LINK', status: 'SUCCESS', policyDecision: 'ALLOW', providerName: 'RAZORPAY_TEST_MODE_PAYMENT_LINKS', createdAt: '2025-01-01T00:00:00.000Z' }] }, auditEvents: [] });
    renderPage(<CaseDetailPage caseId="case-1" navigate={vi.fn()} />);
    expect((await screen.findAllByText(/SUCCESS · Internal \/ unclassified provider evidence/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/Simulated provider/)).toBeTruthy();
    expect(screen.getByText(/Razorpay Test Mode/)).toBeTruthy();
    expect(screen.queryByText('External provider')).toBeNull();
  });

  it('shows a retryable visible API error', async () => {
    api.getRevenueRadarMetrics.mockRejectedValueOnce(new Error('API unavailable')).mockResolvedValueOnce({ revenueAtRisk: '0.00', verifiedRecovered: '0.00', agentAttributedRecovered: '0.00', activeRecoveries: 0, needsReview: 0, riskTypeBreakdown: {}, statusBreakdown: {} });
    renderPage(<RevenueRadarPage />);
    expect(await screen.findByText('API unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.getByText('No recovery cases yet')).toBeTruthy());
  });
});
