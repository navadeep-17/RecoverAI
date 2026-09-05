// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntegrationStatus } from './IntegrationStatus';

const api = vi.hoisted(() => ({ getIntegrationStatus: vi.fn() }));
vi.mock('../api/integrations', () => api);

function renderStatus() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <IntegrationStatus />
    </QueryClientProvider>,
  );
  return client;
}

describe('integration status', () => {
  it('labels complete local configuration without claiming verified Razorpay connectivity', async () => {
    api.getIntegrationStatus.mockResolvedValue({
      razorpay: {
        mode: 'TEST',
        configured: true,
        paymentLinksEnabled: true,
        webhooksConfigured: true,
      },
      ai: { provider: 'gemini' },
    });
    renderStatus();
    expect(await screen.findByText('Razorpay Test Mode · Configured')).toBeTruthy();
    expect(screen.queryByText('Razorpay Test Mode · Connected')).toBeNull();
    expect(screen.getByText('Payment-link and signed-webhook paths are configured for this merchant. This status does not perform a live Razorpay connectivity check.')).toBeTruthy();
    expect(screen.queryByText('Payment links and signed webhook recovery are enabled for this merchant.')).toBeNull();
  });

  it.each([
    ['incomplete', true, true],
    ['absent', false, false],
  ])('shows not configured for %s configuration', async (_state, configured, paymentLinksEnabled) => {
    api.getIntegrationStatus.mockResolvedValue({
      razorpay: {
        mode: 'TEST',
        configured,
        paymentLinksEnabled,
        webhooksConfigured: false,
      },
      ai: { provider: 'mock' },
    });
    const client = renderStatus();
    await waitFor(() => expect(client.getQueryState(['integration-status'])?.status).toBe('success'));
    expect(screen.getByText('Razorpay Test Mode · Not configured')).toBeTruthy();
    expect(screen.getByText('The deterministic simulator remains available.')).toBeTruthy();
  });

  it('shows not configured when integration status is unavailable', async () => {
    api.getIntegrationStatus.mockRejectedValue(new Error('Unavailable'));
    const client = renderStatus();
    await waitFor(() => expect(client.getQueryState(['integration-status'])?.status).toBe('error'));
    expect(screen.getByText('Razorpay Test Mode · Not configured')).toBeTruthy();
  });
});
