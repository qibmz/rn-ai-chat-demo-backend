import { jsonSchema, tool, type ToolSet } from 'ai';
import type { DeepSeekToolsClient } from './deepseek-tools.client.js';
import { extractUrlsFromText } from './extract-urls-from-text.js';

export type WebSource = {
  title: string;
  url: string;
  snippet: string;
  siteName?: string | null;
  fetched?: boolean;
};

export type WebToolsSession = {
  allowedFetchUrls: Set<string>;
  searchCount: number;
  fetchCount: number;
  billableSearchCount: number;
  billableFetchCount: number;
  sources: WebSource[];
  writeQueue: Promise<void>;
};

export type WebToolsConfig = {
  searchMaxPerTurn: number;
  fetchMaxPerTurn: number;
  searchDefaultCount: number;
  searchCountCap: number;
  fetchMaxChars: number;
};

export type CreateWebToolsParams = {
  client: DeepSeekToolsClient;
  writer: { write: (part: unknown) => void };
  userText: string;
  oriQuestion: string;
  config: WebToolsConfig;
};

const SEARCH_OVER_LIMIT = '本轮搜索次数已达上限';
const FETCH_OVER_LIMIT = '本轮抓取次数已达上限';
const FETCH_NOT_ALLOWED = '只能抓取本轮用户给出的链接或搜索结果中的链接';
const SEARCH_FAILED = '网页搜索失败';
const FETCH_FAILED = '网页抓取失败';

function truncateCodepoints(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('');
}

function clampSearchCount(
  raw: unknown,
  defaultCount: number,
  cap: number,
): number {
  const max = Math.min(50, cap);
  const n =
    typeof raw === 'number' && Number.isFinite(raw)
      ? Math.trunc(raw)
      : defaultCount;
  return Math.min(max, Math.max(1, n));
}

function chineseError(err: unknown, fallback: string): string {
  if (err instanceof Error && err.name === 'AbortError') {
    return '请求已取消';
  }
  if (err instanceof Error && /[\u4e00-\u9fff]/.test(err.message)) {
    return err.message;
  }
  return fallback;
}

function escapeAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;');
}

function wrapUntrustedContent(url: string, content: string): string {
  const safe = content.replaceAll('</untrusted_web_content>', '');
  return `<untrusted_web_content url="${escapeAttr(url)}">${safe}</untrusted_web_content>`;
}

function enqueueWrite(session: WebToolsSession, fn: () => void): Promise<void> {
  session.writeQueue = session.writeQueue.then(fn, fn);
  return session.writeQueue;
}

function upsertSource(session: WebToolsSession, next: WebSource): void {
  const index = session.sources.findIndex((item) => item.url === next.url);
  if (index >= 0) {
    session.sources[index] = { ...session.sources[index], ...next };
    return;
  }
  session.sources.push(next);
}

export function createWebTools(ctx: CreateWebToolsParams): {
  tools: ToolSet;
  session: WebToolsSession;
} {
  const { client, writer, config } = ctx;
  const session: WebToolsSession = {
    allowedFetchUrls: new Set(extractUrlsFromText(ctx.userText)),
    searchCount: 0,
    fetchCount: 0,
    billableSearchCount: 0,
    billableFetchCount: 0,
    sources: [],
    writeQueue: Promise.resolve(),
  };

  const web_search = tool({
    description:
      '搜索网页。仅在需要最新资料、核实事实或用户明确要求联网时使用。',
    inputSchema: jsonSchema<{ query: string; count?: number }>({
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        count: { type: 'integer', description: '返回条数' },
      },
      required: ['query'],
      additionalProperties: false,
    }),
    execute: async ({ query, count }, options) => {
      session.searchCount += 1;
      if (session.searchCount > config.searchMaxPerTurn) {
        await enqueueWrite(session, () => {
          writer.write({
            type: 'data-webSearch',
            data: { status: 'error', query, errorText: SEARCH_OVER_LIMIT },
          });
        });
        return { error: SEARCH_OVER_LIMIT };
      }

      await enqueueWrite(session, () => {
        writer.write({
          type: 'data-webSearch',
          data: { status: 'searching', query },
        });
      });

      const ori = truncateCodepoints(ctx.oriQuestion, 128);
      try {
        const response = await client.search(
          {
            query,
            count: clampSearchCount(
              count,
              config.searchDefaultCount,
              config.searchCountCap,
            ),
            ori_question: ori.length > 0 ? ori : null,
            need_content: false,
          },
          options.abortSignal,
        );
        const results = response.results ?? [];
        for (const item of results) {
          session.allowedFetchUrls.add(item.url);
          upsertSource(session, {
            title: item.title,
            url: item.url,
            snippet: item.snippet,
            siteName: item.site_name,
          });
        }
        if (results.length > 0) {
          session.billableSearchCount += 1;
        }
        await enqueueWrite(session, () => {
          writer.write({
            type: 'data-webSearch',
            data: { status: 'done', query },
          });
        });
        if (results.length > 0) {
          await enqueueWrite(session, () => {
            writer.write({
              type: 'data-webSources',
              data: { sources: session.sources.map((item) => ({ ...item })) },
            });
          });
        }
        return {
          results: results.map((item) => ({
            title: item.title,
            url: item.url,
            snippet: item.snippet,
            siteName: item.site_name,
          })),
        };
      } catch (err) {
        const error = chineseError(err, SEARCH_FAILED);
        await enqueueWrite(session, () => {
          writer.write({
            type: 'data-webSearch',
            data: { status: 'error', query, errorText: error },
          });
        });
        return { error };
      }
    },
  });

  const web_fetch = tool({
    description:
      '抓取网页正文。url 必须是本轮用户给出的链接或搜索结果中的链接。',
    inputSchema: jsonSchema<{ url: string }>({
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的网页 URL' },
      },
      required: ['url'],
      additionalProperties: false,
    }),
    execute: async ({ url }, options) => {
      if (!session.allowedFetchUrls.has(url)) {
        await enqueueWrite(session, () => {
          writer.write({
            type: 'data-webFetch',
            data: { status: 'error', url, errorText: FETCH_NOT_ALLOWED },
          });
        });
        return { error: FETCH_NOT_ALLOWED };
      }

      session.fetchCount += 1;
      if (session.fetchCount > config.fetchMaxPerTurn) {
        await enqueueWrite(session, () => {
          writer.write({
            type: 'data-webFetch',
            data: { status: 'error', url, errorText: FETCH_OVER_LIMIT },
          });
        });
        return { error: FETCH_OVER_LIMIT };
      }

      await enqueueWrite(session, () => {
        writer.write({
          type: 'data-webFetch',
          data: { status: 'fetching', url },
        });
      });

      try {
        const response = await client.fetchPage({ url }, options.abortSignal);
        const raw = response.content ?? '';
        const truncated = raw.slice(0, config.fetchMaxChars);
        const content = wrapUntrustedContent(url, truncated);
        const title = response.title || url;
        if (raw.length > 0) {
          session.billableFetchCount += 1;
        }
        upsertSource(session, {
          title,
          url,
          snippet:
            session.sources.find((item) => item.url === url)?.snippet ?? '',
          fetched: true,
        });
        await enqueueWrite(session, () => {
          writer.write({
            type: 'data-webFetch',
            data: { status: 'done', url, title },
          });
        });
        await enqueueWrite(session, () => {
          writer.write({
            type: 'data-webSources',
            data: { sources: session.sources.map((item) => ({ ...item })) },
          });
        });
        return { title, content };
      } catch (err) {
        const error = chineseError(err, FETCH_FAILED);
        await enqueueWrite(session, () => {
          writer.write({
            type: 'data-webFetch',
            data: { status: 'error', url, errorText: error },
          });
        });
        return { error };
      }
    },
  });

  return { tools: { web_search, web_fetch }, session };
}
