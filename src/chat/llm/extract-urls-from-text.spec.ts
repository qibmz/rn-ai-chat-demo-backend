import { extractUrlsFromText } from './extract-urls-from-text.js';

describe('extractUrlsFromText', () => {
  it('extracts http(s) URLs and strips trailing Chinese punctuation', () => {
    expect(
      extractUrlsFromText('看 https://a.com/x。还有 http://b.com'),
    ).toEqual(['https://a.com/x', 'http://b.com']);
  });

  it('returns an empty array when there are no links', () => {
    expect(extractUrlsFromText('无链接')).toEqual([]);
  });

  it('deduplicates URLs while preserving first-seen order', () => {
    expect(
      extractUrlsFromText('https://a.com 再看 https://b.com 和 https://a.com'),
    ).toEqual(['https://a.com', 'https://b.com']);
  });
});
