import { jsonSchema, streamText, tool } from 'ai';
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

  it('sends reasoning_content as an empty string when assistant history has no reasoning and tools are registered', async () => {
    let requestBody = '';
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestBody = String(init?.body ?? '');
      return sseResponse([
        'data: {"id":"1","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n',
        'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
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
      tools: {
        ping: tool({
          description: '最小探测工具',
          inputSchema: jsonSchema<{ query: string }>({
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
            required: ['query'],
            additionalProperties: false,
          }),
        }),
      },
      messages: [
        { role: 'user', content: '之前的问题' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: '之前的回答' }],
        },
        { role: 'user', content: '继续' },
      ],
    });

    for await (const part of result.fullStream) {
      void part;
    }

    const body = JSON.parse(requestBody) as {
      messages?: Array<{
        role?: string;
        content?: unknown;
        reasoning_content?: unknown;
      }>;
    };
    const assistant = body.messages?.find(
      (message) =>
        message.role === 'assistant' && message.content === '之前的回答',
    );
    expect(assistant).toEqual(
      expect.objectContaining({ reasoning_content: '' }),
    );
    expect(assistant).toHaveProperty('reasoning_content', '');
  });
});
