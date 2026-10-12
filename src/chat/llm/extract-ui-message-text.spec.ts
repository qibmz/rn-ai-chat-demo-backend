import { extractUiMessageText } from './extract-ui-message-text.js';

describe('extractUiMessageText', () => {
  it('joins text and reasoning parts', () => {
    expect(
      extractUiMessageText({
        id: 'a',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: '想一想' },
          { type: 'text', text: '你好' },
          { type: 'text', text: '世界' },
        ],
      }),
    ).toEqual({ text: '你好世界', reasoningText: '想一想' });
  });

  it('returns empty text and null reasoning when parts empty', () => {
    expect(
      extractUiMessageText({ id: 'a', role: 'assistant', parts: [] }),
    ).toEqual({ text: '', reasoningText: null });
  });
});
