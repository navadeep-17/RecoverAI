import { useQuery } from '@tanstack/react-query';
import { getIntegrationStatus } from '../api/integrations';

export function IntegrationStatus() {
  const query = useQuery({
    queryKey: ['integration-status'],
    queryFn: getIntegrationStatus,
    retry: false,
  });
  const connected = Boolean(query.data?.razorpay.configured && query.data.razorpay.paymentLinksEnabled && query.data.razorpay.webhooksConfigured);

  return (
    <div className="absolute bottom-5 text-xs text-slate-500">
      <p className="font-semibold text-slate-700">Razorpay Test Mode · {connected ? 'Connected' : 'Not configured'}</p>
      <p className="mt-2">{connected ? 'Payment links and signed webhook recovery are enabled for this merchant.' : 'The deterministic simulator remains available.'}</p>
    </div>
  );
}
