import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';

describe('Razorpay webhook route', () => {
  it('passes the original JSON bytes, rather than reconstructed JSON, to signature verification', async () => {
    const accept = vi.fn().mockResolvedValue({ accepted: true, duplicate: false, unsupported: false, webhookEventId: 'wh_001' });
    const app = buildServer({ razorpayWebhookService: { accept } as any });
    const raw = '{\n  "id": "evt_001", "event": "payment.failed"\n}';
    const signature = createHmac('sha256', 'test-secret').update(Buffer.from(raw)).digest('hex');

    const response = await app.inject({
      method: 'POST', url: '/webhooks/razorpay', payload: raw,
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature },
    });

    expect(response.statusCode).toBe(202);
    expect(accept).toHaveBeenCalledOnce();
    expect(Buffer.isBuffer(accept.mock.calls[0][0])).toBe(true);
    expect(accept.mock.calls[0][0].toString('utf8')).toBe(raw);
    expect(accept.mock.calls[0][1]).toBe(signature);
    await app.close();
  });
});
