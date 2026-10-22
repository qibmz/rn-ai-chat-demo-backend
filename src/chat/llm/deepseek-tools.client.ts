import type {
  DeepSeekFetchRequest,
  DeepSeekFetchResponse,
  DeepSeekSearchRequest,
  DeepSeekSearchResponse,
} from './deepseek-tools.types.js';

export function toolsApiOrigin(llmBaseUrl: string): string {
  return new URL(llmBaseUrl).origin;
}

type ToolsPath = '/v1/tools/search' | '/v1/tools/fetch';

export class DeepSeekToolsClient {
  constructor(
    private readonly opts: {
      apiKey: string;
      baseURL: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  private url(path: ToolsPath): string {
    return `${toolsApiOrigin(this.opts.baseURL)}${path}`;
  }

  async search(
    body: DeepSeekSearchRequest,
    signal?: AbortSignal,
  ): Promise<DeepSeekSearchResponse> {
    return this.post<DeepSeekSearchResponse>('/v1/tools/search', body, signal);
  }

  async fetchPage(
    body: DeepSeekFetchRequest,
    signal?: AbortSignal,
  ): Promise<DeepSeekFetchResponse> {
    return this.post<DeepSeekFetchResponse>('/v1/tools/fetch', body, signal);
  }

  private async post<T>(
    path: ToolsPath,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    };

    const maxAttempts = 2;
    let lastStatus: number | undefined;
    let lastBody = '';

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const res = await fetchImpl(this.url(path), init);
      if (res.ok) {
        return (await res.json()) as T;
      }

      lastStatus = res.status;
      lastBody = await res.text().catch(() => '');

      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw toolsHttpError(res.status, lastBody);
      }

      if (
        attempt < maxAttempts - 1 &&
        (res.status === 429 || res.status >= 500)
      ) {
        continue;
      }

      throw toolsHttpError(lastStatus, lastBody);
    }

    throw toolsHttpError(lastStatus ?? 0, lastBody);
  }
}

function toolsHttpError(status: number, body: string): Error {
  const detail = body.trim() ? `: ${body.trim()}` : '';
  return new Error(`DeepSeek Tools 请求失败 (${status})${detail}`);
}
