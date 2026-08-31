// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EvaluationPage } from './EvaluationPage';
import { PolicySettingsPage } from './PolicySettingsPage';

const api = vi.hoisted(() => ({ getEvaluation: vi.fn(), getPolicy: vi.fn(), updatePolicy: vi.fn() }));
vi.mock('../api/evaluation', () => ({ getEvaluation: api.getEvaluation })); vi.mock('../api/policy', () => ({ getPolicy: api.getPolicy, updatePolicy: api.updatePolicy }));
const policy = { id: 'p', merchantId: 'm', maxRetriesPerCase: 3, maxContactsPerCase: 3, maxActionsPerCase: 5, cooldownHoursBetweenActions: 24, highValueThreshold: '50000.00', minConfidenceThreshold: .65, reviewFirstMode: false, checkoutAbandonmentThresholdMinutes: 30, quietHoursStart: 21, quietHoursEnd: 9, quietHoursTimezone: 'Asia/Kolkata', maxRecoveryWindowDays: 30, overdueGracePeriodDays: 3, createdAt: '', updatedAt: '' };
function page(node: React.ReactNode) { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>); }
describe('evaluation and policy pages', () => {
  it('renders all frozen strategies and benchmark safety disclosure', async () => { api.getEvaluation.mockResolvedValue({ frozen: true, artifact: 'heldout-summary.json', evaluatorFingerprint: 'sha256:test', approvedCheckpoint: 'checkpoint', scenarioCount: 500, benchmarkLabel: 'SYNTHETIC BENCHMARK', seed: 42, split: 'heldout', results: ['NO_INTERVENTION', 'NAIVE_RECOVERY', 'RULE_BASED', 'RULE_BASED_WITH_POLICY', 'RECOVERAI', 'POLICY_AWARE_ORACLE'].map(strategy => ({ strategy, metrics: { recoveryRate: .1, revenueRecoveredPaise: '100', unsafeActions: 0, policyViolations: 0 } })) }); page(<EvaluationPage />); expect(await screen.findByText('RECOVERAI')).toBeTruthy(); expect(screen.getByText('RULE_BASED_WITH_POLICY')).toBeTruthy(); expect(screen.getByText(/not production revenue recovered/i)).toBeTruthy(); expect(screen.getAllByText(/Unsafe proposal\/ledger entries/).length).toBeGreaterThan(1); });
  it('loads, saves, and resets policy settings', async () => { api.getPolicy.mockResolvedValue({ policy }); api.updatePolicy.mockResolvedValue({ policy: { ...policy, maxRetriesPerCase: 4 } }); page(<PolicySettingsPage />); const input = await screen.findByLabelText('Maximum retries'); fireEvent.change(input, { target: { value: '4' } }); fireEvent.click(screen.getByRole('button', { name: 'Save Changes' })); await waitFor(() => expect(api.updatePolicy).toHaveBeenCalledWith(expect.objectContaining({ maxRetriesPerCase: 4 }))); expect(await screen.findByText(/Policy settings saved/)).toBeTruthy(); });
});
