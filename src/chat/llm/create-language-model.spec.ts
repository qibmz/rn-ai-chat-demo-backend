import { createLanguageModel } from './create-language-model.js';

describe('createLanguageModel', () => {
  it('returns a DeepSeek chat model for provider=deepseek', () => {
    const model = createLanguageModel({
      provider: 'deepseek',
      apiKey: 'test-key',
      baseURL: 'https://api.deepseek.com/v1',
      modelId: 'deepseek-flash',
    });
    expect(model).toBeTruthy();
    expect(typeof (model as { doStream?: unknown }).doStream).toBe('function');
  });

  it('throws Chinese error for unsupported provider', () => {
    expect(() =>
      createLanguageModel({
        provider: 'openai' as never,
        apiKey: 'k',
        baseURL: 'https://example.com/v1',
        modelId: 'gpt',
      }),
    ).toThrow(/暂不支持的 LLM_PROVIDER/);
  });
});
