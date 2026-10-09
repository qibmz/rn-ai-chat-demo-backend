import { sanitizeRequestPath } from './sanitize-request-path.js';

describe('sanitizeRequestPath', () => {
  it('redacts token query param', () => {
    expect(sanitizeRequestPath('/auth/verify-email?token=abc123secret')).toBe(
      '/auth/verify-email?token=%5BREDACTED%5D',
    );
  });

  it('leaves unrelated paths unchanged', () => {
    expect(sanitizeRequestPath('/auth/me')).toBe('/auth/me');
    expect(sanitizeRequestPath('/auth/login?foo=1')).toBe('/auth/login?foo=1');
  });
});
