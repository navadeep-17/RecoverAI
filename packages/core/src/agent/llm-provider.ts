export interface LLMRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  responseFormat?: 'json';
}

export interface LLMResponse {
  rawText: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
  modelName: string;
}

export interface LLMProvider {
  readonly providerName: string;
  generateText(request: LLMRequest): Promise<LLMResponse>;
}
