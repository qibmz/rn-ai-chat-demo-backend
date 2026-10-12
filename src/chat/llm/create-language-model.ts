import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';

export type SupportedLlmProvider = 'deepseek';

export type CreateLanguageModelParams = {
  provider: string;
  apiKey: string;
  baseURL: string;
  modelId: string;
};

export function createLanguageModel(
  params: CreateLanguageModelParams,
): LanguageModel {
  const provider = params.provider.trim() || 'deepseek';
  if (provider === 'deepseek') {
    return createDeepSeek({
      apiKey: params.apiKey,
      baseURL: params.baseURL,
    }).chat(params.modelId);
  }
  throw new Error(`暂不支持的 LLM_PROVIDER: ${provider}`);
}
