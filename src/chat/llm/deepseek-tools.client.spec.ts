import {
  DeepSeekToolsClient,
  toolsApiOrigin,
} from './deepseek-tools.client.js';

describe('toolsApiOrigin', () => {
  it('returns origin when base URL includes /v1 path', () => {
    expect(toolsApiOrigin('https://api.deepseek.com/v1')).toBe(
      'https://api.deepseek.com',
    );
  });
});

describe('DeepSeekToolsClient', () => {
  it('builds tools URL from origin when LLM_BASE_URL ends with /v1', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
    const client = new DeepSeekToolsClient({
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.com/v1',
      fetchImpl: fetchMock,
    });
    await client.search({ query: 'hello', count: 1 });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.deepseek.com/v1/tools/search',
    );
  });

  it('forwards abortSignal to fetch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
    const ac = new AbortController();
    const client = new DeepSeekToolsClient({
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.com/v1',
      fetchImpl: fetchMock,
    });
    await client.search({ query: 'hello' }, ac.signal);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: ac.signal });
  });

  it('resolves empty results array', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
    const client = new DeepSeekToolsClient({
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.com/v1',
      fetchImpl: fetchMock,
    });
    await expect(client.search({ query: 'none' })).resolves.toEqual({
      results: [],
    });
  });

  it('throws Chinese error on 4xx', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('bad request', { status: 400 }));
    const client = new DeepSeekToolsClient({
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.com/v1',
      fetchImpl: fetchMock,
    });
    await expect(client.search({ query: 'x' })).rejects.toThrow(
      /DeepSeek Tools 请求失败/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once on 429 then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
    const client = new DeepSeekToolsClient({
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.com/v1',
      fetchImpl: fetchMock,
    });
    await expect(client.search({ query: 'retry' })).resolves.toEqual({
      results: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries once on 5xx then throws if still failing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('server error', { status: 503 }));
    const client = new DeepSeekToolsClient({
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.com/v1',
      fetchImpl: fetchMock,
    });
    await expect(client.search({ query: 'fail' })).rejects.toThrow(
      /DeepSeek Tools 请求失败/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('POSTs fetchPage to /v1/tools/fetch with Bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ title: 'T', content: 'C' }), {
        status: 200,
      }),
    );
    const client = new DeepSeekToolsClient({
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.com/v1',
      fetchImpl: fetchMock,
    });
    await expect(
      client.fetchPage({ url: 'https://example.com/page' }),
    ).resolves.toEqual({ title: 'T', content: 'C' });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.deepseek.com/v1/tools/fetch',
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer sk-test',
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ url: 'https://example.com/page' }),
    });
  });
});
