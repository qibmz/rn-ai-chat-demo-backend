const URL_RE = /https?:\/\/[^\s。，、；：！？）】》]+/gi;
const TRAILING_CN_PUNCT_RE = /[。，、；：！？）】》]+$/;

export function extractUrlsFromText(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(TRAILING_CN_PUNCT_RE, '');
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    urls.push(url);
  }
  return urls;
}
