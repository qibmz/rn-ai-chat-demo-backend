import { describe, expect, it } from 'vitest';
import {
  renderPasswordResetEmailHtml,
  renderVerifyEmailHtml,
} from './email-templates.js';

describe('email-templates', () => {
  it('renders verify email with CTA and escaped app name', () => {
    const html = renderVerifyEmailHtml({
      appName: 'Demo <App>',
      verifyUrl: 'https://example.com/auth/verify-email?token=abc',
      expiresIn: '24h',
    });

    expect(html).toContain('请验证你的邮箱');
    expect(html).toContain('验证邮箱');
    expect(html).toContain('Demo &lt;App&gt;');
    expect(html).toContain('https://example.com/auth/verify-email?token=abc');
    expect(html).toContain('24h');
    expect(html).not.toContain('<script');
  });

  it('renders password reset email with monospace code block', () => {
    const html = renderPasswordResetEmailHtml({
      appName: 'Demo',
      code: '12345678',
      expiresIn: '15m',
    });

    expect(html).toContain('重置密码验证码');
    expect(html).toContain('12345678');
    expect(html).toContain('letter-spacing:0.35em');
    expect(html).toContain('15m');
  });
});
