// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntegrationStatus } from './IntegrationStatus';

const api = vi.hoisted(() => ({ getIntegrationStatus: vi.fn() }));
vi.mock('../api/integrations', () => api);

function renderStatus() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <IntegrationStatus />
    </QueryClientProvider>,
  );
}

describe('integration status', () => {
  it('shows connected only for a fully enabled Razorpay Test Mode loop', async () => {
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
    expect(await screen.findByText('Razorpay Test Mode · Connected')).toBeTruthy();
  });

  it('shows not configured for incomplete or unavailable status', async () => {
    api.getIntegrationStatus.mockResolvedValue({
      razorpay: {
        mode: 'TEST',
        configured: true,
        paymentLinksEnabled: true,
        webhooksConfigured: false,
      },
      ai: { provider: 'mock' },
    });
    const first = renderStatus();
    expect(await screen.findByText('Razorpay Test Mode · Not configured')).toBeTruthy();
    first.unmount();

    api.getIntegrationStatus.mockRejectedValue(new Error('Unavailable'));
    renderStatus();
    expect(await screen.findByText('Razorpay Test Mode · Not configured')).toBeTruthy();
  });
});
