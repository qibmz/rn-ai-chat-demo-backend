import type { ModelMessage } from 'ai';
import { createWebTools } from './create-web-tools.js';
import type { DeepSeekToolsClient } from './deepseek-tools.client.js';
import type { DeepSeekSearchResult } from './deepseek-tools.types.js';

const defaultConfig = {
  searchMaxPerTurn: 2,
  fetchMaxPerTurn: 3,
  searchDefaultCount: 10,
  searchCountCap: 10,
  fetchMaxChars: 8000,
};

type WritePart = { type: string; data: Record<string, unknown> };

function searchHit(
  overrides: Partial<DeepSeekSearchResult> & { url: string },
): DeepSeekSearchResult {
  return {
    rerank_score: 2,
    title: '标题',
    snippet: '摘要',
    summary: '',
    content: '',
    site_name: 'example',
    site_icon: null,
    date: null,
    authority: 1,
    ...overrides,
  };
}

function mockClient() {
  return {
    search: vi.fn(),
    fetchPage: vi.fn(),
  };
}

function setup(opts?: {
  userText?: string;
  oriQuestion?: string;
  config?: Partial<typeof defaultConfig>;
  client?: ReturnType<typeof mockClient>;
}) {
  const client = opts?.client ?? mockClient();
  const writes: WritePart[] = [];
  const writer = {
    write: (part: unknown) => {
      writes.push(part as WritePart);
    },
  };
  const created = createWebTools({
    client: client as unknown as DeepSeekToolsClient,
    writer,
    userText: opts?.userText ?? '',
    oriQuestion: opts?.oriQuestion ?? '原问题',
    config: { ...defaultConfig, ...opts?.config },
  });
  return { ...created, client, writes };
}

async function exec(
  tool: {
    execute?: (
      input: unknown,
      options: {
        toolCallId: string;
        messages: ModelMessage[];
        abortSignal?: AbortSignal;
        context: unknown;
      },
    ) => unknown;
  },
  input: unknown,
  abortSignal?: AbortSignal,
) {
  if (!tool.execute) {
    throw new Error('tool.execute missing');
  }
  return tool.execute(input, {
    toolCallId: 'call-1',
    messages: [] as ModelMessage[],
    abortSignal,
    context: {},
  }) as Promise<unknown>;
}

describe('createWebTools', () => {
  it('rejects search over the per-turn cap without calling the client', async () => {
    const { tools, client } = setup();
    client.search.mockResolvedValue({
      results: [searchHit({ url: 'https://a.com' })],
    });

    await exec(tools.web_search, { query: '一' });
    await exec(tools.web_search, { query: '二' });
    const third = await exec(tools.web_search, { query: '三' });

    expect(client.search).toHaveBeenCalledTimes(2);
    expect(third).toEqual({ error: expect.stringMatching(/[\u4e00-\u9fff]/) });
    expect((third as { error: string }).error).toMatch(/上限/);
  });

  it('rejects fetch URLs outside the whitelist without calling the client', async () => {
    const { tools, client } = setup();
    const result = await exec(tools.web_fetch, {
      url: 'https://evil.example/x',
    });
    expect(client.fetchPage).not.toHaveBeenCalled();
    expect(result).toEqual({
      error: '只能抓取本轮用户给出的链接或搜索结果中的链接',
    });
  });

  it('allows fetch of URLs present in the user message', async () => {
    const { tools, client } = setup({
      userText: '请总结 https://a.com/x',
    });
    client.fetchPage.mockResolvedValue({ title: 'A', content: '正文' });
    const result = await exec(tools.web_fetch, { url: 'https://a.com/x' });
    expect(client.fetchPage).toHaveBeenCalledTimes(1);
    expect(result).not.toMatchObject({ error: expect.anything() });
  });

  it('increments billableSearchCount only when search returns results', async () => {
    const { tools, session, client } = setup();
    client.search
      .mockResolvedValueOnce({ results: [searchHit({ url: 'https://a.com' })] })
      .mockResolvedValueOnce({ results: [] });

    await exec(tools.web_search, { query: '有结果' });
    expect(session.billableSearchCount).toBe(1);

    await exec(tools.web_search, { query: '空' });
    expect(session.billableSearchCount).toBe(1);
  });

  it('truncates fetch content, wraps it, and marks the source fetched with title override', async () => {
    const { tools, session, client } = setup({
      userText: 'https://a.com/x',
      config: { fetchMaxChars: 8 },
    });
    client.fetchPage.mockResolvedValue({
      title: '新标题',
      content: 'abcdefghijklmnop',
    });

    const result = (await exec(tools.web_fetch, {
      url: 'https://a.com/x',
    })) as {
      title: string;
      content: string;
    };

    expect(result.title).toBe('新标题');
    expect(result.content).toBe(
      '<untrusted_web_content url="https://a.com/x">abcdefgh</untrusted_web_content>',
    );
    expect(session.sources).toEqual([
      expect.objectContaining({
        url: 'https://a.com/x',
        title: '新标题',
        fetched: true,
      }),
    ]);
    expect(session.billableFetchCount).toBe(1);
  });

  it('emits data-webSearch searching then done (or error) through the write queue', async () => {
    const { tools, session, client, writes } = setup();
    client.search.mockResolvedValue({
      results: [searchHit({ url: 'https://a.com' })],
    });

    await exec(tools.web_search, { query: 'ok' });
    await session.writeQueue;

    const searchWrites = writes.filter((w) => w.type === 'data-webSearch');
    expect(searchWrites.map((w) => w.data.status)).toEqual([
      'searching',
      'done',
    ]);
    expect(searchWrites.every((w) => w.data.query === 'ok')).toBe(true);

    writes.length = 0;
    client.search.mockRejectedValueOnce(
      new Error('DeepSeek Tools 请求失败 (500)'),
    );
    const failed = await exec(tools.web_search, { query: 'boom' });
    await session.writeQueue;

    expect(failed).toEqual({
      error: expect.stringMatching(/[\u4e00-\u9fff]/),
    });
    const errorWrites = writes.filter((w) => w.type === 'data-webSearch');
    expect(errorWrites.map((w) => w.data.status)).toEqual([
      'searching',
      'error',
    ]);
  });

  it('idempotently rewrites data-webSources after successful search and fetch', async () => {
    const { tools, client, writes, session } = setup();
    client.search.mockResolvedValue({
      results: [
        searchHit({
          url: 'https://a.com',
          title: '旧标题',
          snippet: '摘',
          site_name: 'a',
        }),
      ],
    });
    client.fetchPage.mockResolvedValue({ title: '新标题', content: '正文' });

    await exec(tools.web_search, { query: 'q' });
    await session.writeQueue;
    const afterSearch = writes.filter((w) => w.type === 'data-webSources');
    expect(afterSearch).toHaveLength(1);
    expect(afterSearch[0].data.sources).toEqual([
      expect.objectContaining({
        url: 'https://a.com',
        title: '旧标题',
        snippet: '摘',
        siteName: 'a',
      }),
    ]);

    await exec(tools.web_fetch, { url: 'https://a.com' });
    await session.writeQueue;
    const afterFetch = writes.filter((w) => w.type === 'data-webSources');
    expect(afterFetch).toHaveLength(2);
    expect(afterFetch[1].data.sources).toEqual([
      expect.objectContaining({
        url: 'https://a.com',
        title: '新标题',
        fetched: true,
      }),
    ]);
  });

  it('rejects fetch over the per-turn cap without calling the client', async () => {
    const { tools, client } = setup({
      userText:
        'https://a.com/1 https://a.com/2 https://a.com/3 https://a.com/4',
      config: { fetchMaxPerTurn: 3 },
    });
    client.fetchPage.mockResolvedValue({ title: 'T', content: 'C' });
    await exec(tools.web_fetch, { url: 'https://a.com/1' });
    await exec(tools.web_fetch, { url: 'https://a.com/2' });
    await exec(tools.web_fetch, { url: 'https://a.com/3' });
    const fourth = await exec(tools.web_fetch, { url: 'https://a.com/4' });
    expect(client.fetchPage).toHaveBeenCalledTimes(3);
    expect(fourth).toEqual({ error: expect.stringMatching(/上限/) });
  });

  it('does not bill empty fetch content', async () => {
    const { tools, session, client } = setup({
      userText: 'https://a.com/x',
    });
    client.fetchPage.mockResolvedValue({ title: '空', content: '' });
    await exec(tools.web_fetch, { url: 'https://a.com/x' });
    expect(session.billableFetchCount).toBe(0);
  });

  it('forwards execute abortSignal to the client', async () => {
    const { tools, client } = setup();
    client.search.mockResolvedValue({ results: [] });
    const ac = new AbortController();
    await exec(tools.web_search, { query: 'q' }, ac.signal);
    expect(client.search.mock.calls[0][1]).toBe(ac.signal);
  });

  it('truncates ori_question to 128 code points and clamps count', async () => {
    const { tools, client } = setup({
      oriQuestion: '你'.repeat(200),
      config: { searchDefaultCount: 10, searchCountCap: 4 },
    });
    client.search.mockResolvedValue({ results: [] });
    await exec(tools.web_search, { query: 'q', count: 99 });
    expect(client.search.mock.calls[0][0]).toMatchObject({
      query: 'q',
      count: 4,
      need_content: false,
      ori_question: '你'.repeat(128),
    });
  });
});
