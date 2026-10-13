import { streamText } from 'ai';
import { createLanguageModel } from './create-language-model.js';

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]));
      i += 1;
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('DeepSeek provider SSE replay', () => {
  it('emits reasoning-delta and sends max_tokens + thinking', async () => {
    let requestBody = '';
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestBody = String(init?.body ?? '');
      return sseResponse([
        'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":"先分析"}}]}\n\n',
        'data: {"id":"1","choices":[{"index":0,"delta":{"content":"答案"}}]}\n\n',
        'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8,"prompt_cache_miss_tokens":3,"completion_tokens_details":{"reasoning_tokens":2}}}\n\n',
        'data: [DONE]\n\n',
      ]);
    };

    const deepseek = await import('@ai-sdk/deepseek');
    const model = deepseek
      .createDeepSeek({
        apiKey: 'x',
        baseURL: 'http://example.invalid/v1',
        fetch: fetchImpl,
      })
      .chat('deepseek-flash');

    const result = streamText({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 4096,
      providerOptions: {
        deepseek: {
          thinking: { type: 'enabled' },
          reasoningEffort: 'high',
        },
      },
    });

    const events: Array<{ type: string; text?: string }> = [];
    for await (const part of result.fullStream) {
      if (part.type === 'reasoning-delta') {
        events.push({ type: part.type, text: part.text });
      }
      if (part.type === 'text-delta') {
        events.push({ type: part.type, text: part.text });
      }
    }

    const body = JSON.parse(requestBody) as Record<string, unknown>;
    expect(body.max_tokens).toBe(4096);
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning-delta', text: '先分析' }),
        expect.objectContaining({ type: 'text-delta', text: '答案' }),
      ]),
    );

    // also smoke createLanguageModel wiring
    expect(
      createLanguageModel({
        provider: 'deepseek',
        apiKey: 'x',
        baseURL: 'http://example.invalid/v1',
        modelId: 'deepseek-flash',
      }),
    ).toBeTruthy();
  });
});
