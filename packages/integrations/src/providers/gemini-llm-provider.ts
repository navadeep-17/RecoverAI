import { LLMProvider, LLMRequest, LLMResponse } from '@recoverai/core';

export class GeminiProviderError extends Error {
  constructor(
    public readonly code: 'TIMEOUT' | 'AUTHENTICATION' | 'RATE_LIMIT' | 'UPSTREAM' | 'INVALID_RESPONSE',
    message: string,
  ) {
    super(message);
    this.name = 'GeminiProviderError';
  }
}

export interface GeminiLLMProviderOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Narrow Gemini text adapter. It has no access to persistence, policy, or providers;
 * callers receive text only and RecoveryAgent remains the strict proposal parser.
 */
export class GeminiLLMProvider implements LLMProvider {
  public readonly providerName = 'gemini';
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: GeminiLLMProviderOptions) {
    this.model = options.model || 'gemini-3.6-flash';
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async generateText(request: LLMRequest): Promise<LLMResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
          {
            method: 'POST', signal: controller.signal,
            headers: { 'content-type': 'application/json', 'x-goog-api-key': this.options.apiKey },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: `${request.systemPrompt}\n\n${request.userPrompt}` }] }],
              generationConfig: { temperature: request.temperature ?? 0, responseMimeType: 'application/json' },
            }),
          },
        );
      } catch (error) {
        if (controller.signal.aborted) throw new GeminiProviderError('TIMEOUT', 'Gemini request timed out');
        throw new GeminiProviderError('UPSTREAM', 'Gemini network request failed');
      }
      if (response.status === 401 || response.status === 403) throw new GeminiProviderError('AUTHENTICATION', 'Gemini authentication failed');
      if (response.status === 429) throw new GeminiProviderError('RATE_LIMIT', 'Gemini rate limit reached');
      if (!response.ok) throw new GeminiProviderError('UPSTREAM', `Gemini upstream request failed with status ${response.status}`);
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new GeminiProviderError('INVALID_RESPONSE', 'Gemini returned an invalid JSON response body'); }
      const candidate = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> })?.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text;
      if (typeof text !== 'string' || text.trim().length === 0) throw new GeminiProviderError('INVALID_RESPONSE', 'Gemini response contained no candidate text');
      const usage = (payload as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }).usageMetadata;
      return { rawText: text, modelName: this.model, usage: { promptTokens: usage?.promptTokenCount, completionTokens: usage?.candidatesTokenCount } };
    } finally {
      clearTimeout(timeout);
    }
  }
}
