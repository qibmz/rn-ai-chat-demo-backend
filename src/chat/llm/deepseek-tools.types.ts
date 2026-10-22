export type DeepSeekSearchRequest = {
  query: string;
  count?: number;
  ori_question?: string | null;
  localization?: string;
  need_content?: boolean;
};

export type DeepSeekSearchResult = {
  rerank_score: number;
  title: string;
  url: string;
  snippet: string;
  summary: string;
  content: string;
  site_name: string | null;
  site_icon: string | null;
  date: string | null;
  authority: number;
};

export type DeepSeekSearchResponse = { results: DeepSeekSearchResult[] };

export type DeepSeekFetchRequest = { url: string };
export type DeepSeekFetchResponse = { title: string; content: string };
