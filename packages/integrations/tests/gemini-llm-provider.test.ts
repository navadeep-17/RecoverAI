import { describe, expect, it, vi } from 'vitest';
import { GeminiLLMProvider, GeminiProviderError } from '../src/index.js';

const request = { systemPrompt: 'JSON only', userPrompt: 'facts', responseFormat: 'json' as const };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('GeminiLLMProvider', () => {
  it('returns only candidate text for RecoveryAgent schema validation', async () => {
    const fetchImpl = vi.fn(async () => response({ candidates: [{ content: { parts: [{ text: '{"proposedActionType":"RETRY_PAYMENT"}' }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }));
    const provider = new GeminiLLMProvider({ apiKey: 'secret-not-to-leak', model: 'gemini-test', fetchImpl: fetchImpl as any });
    await expect(provider.generateText(request)).resolves.toMatchObject({ rawText: '{"proposedActionType":"RETRY_PAYMENT"}', modelName: 'gemini-test' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).generationConfig.responseMimeType).toBe('application/json');
  });

  it.each([[401, 'AUTHENTICATION'], [403, 'AUTHENTICATION'], [429, 'RATE_LIMIT'], [500, 'UPSTREAM']] as const)('classifies HTTP %s without disclosing the key', async (status, code) => {
    const provider = new GeminiLLMProvider({ apiKey: 'secret-not-to-leak', fetchImpl: (async () => response({}, status)) as any });
    await expect(provider.generateText(request)).rejects.toMatchObject({ code });
    await provider.generateText(request).catch((error) => expect(String(error)).not.toContain('secret-not-to-leak'));
  });

  it('fails closed for malformed payload, missing candidate, and timeout', async () => {
    const badJson = new GeminiLLMProvider({ apiKey: 'x', fetchImpl: (async () => new Response('not-json', { status: 200 })) as any });
    await expect(badJson.generateText(request)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' } satisfies Partial<GeminiProviderError>);
    const missing = new GeminiLLMProvider({ apiKey: 'x', fetchImpl: (async () => response({ candidates: [] })) as any });
    await expect(missing.generateText(request)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' } satisfies Partial<GeminiProviderError>);
    const timeout = new GeminiLLMProvider({ apiKey: 'x', timeoutMs: 1, fetchImpl: ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as any });
    await expect(timeout.generateText(request)).rejects.toMatchObject({ code: 'TIMEOUT' } satisfies Partial<GeminiProviderError>);
  });
});
