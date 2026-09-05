import { useQuery } from '@tanstack/react-query';
import { getIntegrationStatus } from '../api/integrations';

export function IntegrationStatus() {
  const query = useQuery({
    queryKey: ['integration-status'],
    queryFn: getIntegrationStatus,
    retry: false,
  });
  const configured = Boolean(query.data?.razorpay.configured && query.data.razorpay.paymentLinksEnabled && query.data.razorpay.webhooksConfigured);

  return (
    <div className="absolute bottom-5 text-xs text-slate-500">
      <p className="font-semibold text-slate-700">Razorpay Test Mode · {configured ? 'Configured' : 'Not configured'}</p>
      <p className="mt-2">{configured ? 'Payment-link and signed-webhook paths are configured for this merchant. This status does not perform a live Razorpay connectivity check.' : 'The deterministic simulator remains available.'}</p>
    </div>
  );
}
