/**
 * Transactional email HTML — table layout + inline styles for client compatibility.
 * Visual language aligned with verify-email landing page (warm paper / ink / green).
 */

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function emailShell(options: {
  appName: string;
  preheader: string;
  title: string;
  bodyHtml: string;
}): string {
  const brand = escapeHtml(options.appName);
  const preheader = escapeHtml(options.preheader);
  const title = escapeHtml(options.title);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>${title} · ${brand}</title>
</head>
<body style="margin:0;padding:0;background-color:#f3efe6;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    ${preheader}
  </div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f3efe6;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;border-collapse:collapse;">
          <tr>
            <td style="padding:0 8px 20px;font-family:'Segoe UI',Helvetica,Arial,'PingFang SC','Microsoft YaHei',sans-serif;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#5c6b66;">
              ${brand}
            </td>
          </tr>
          <tr>
            <td style="background-color:#fffcf7;border:1px solid rgba(20,35,31,0.1);border-radius:20px;padding:36px 32px 40px;font-family:'Segoe UI',Helvetica,Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#14231f;box-shadow:0 18px 40px rgba(20,35,31,0.06);">
              <h1 style="margin:0 0 16px;font-size:22px;line-height:1.35;font-weight:650;color:#14231f;">
                ${title}
              </h1>
              ${options.bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:24px 8px 0;font-family:'Segoe UI',Helvetica,Arial,'PingFang SC','Microsoft YaHei',sans-serif;font-size:12px;line-height:1.6;color:#5c6b66;">
              此邮件由 ${brand} 自动发送，请勿直接回复。<br />
              如非本人操作，可安全忽略。
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function primaryButton(href: string, label: string): string {
  const safeHref = escapeHtml(href);
  const safeLabel = escapeHtml(label);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 8px;border-collapse:collapse;">
  <tr>
    <td align="center" bgcolor="#1f6b4a" style="border-radius:999px;background-color:#1f6b4a;">
      <a href="${safeHref}" style="display:inline-block;padding:14px 28px;font-family:'Segoe UI',Helvetica,Arial,'PingFang SC','Microsoft YaHei',sans-serif;font-size:15px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:999px;">
        ${safeLabel}
      </a>
    </td>
  </tr>
</table>`;
}

export function renderVerifyEmailHtml(options: {
  appName: string;
  verifyUrl: string;
  expiresIn: string;
}): string {
  const { appName, verifyUrl, expiresIn } = options;
  const safeUrl = escapeHtml(verifyUrl);
  const safeExpires = escapeHtml(expiresIn);

  return emailShell({
    appName,
    preheader: `请在 ${expiresIn} 内完成邮箱验证`,
    title: '请验证你的邮箱',
    bodyHtml: `
      <p style="margin:0 0 12px;font-size:15px;line-height:1.7;color:#14231f;">
        欢迎使用 <strong>${escapeHtml(appName)}</strong>。点击下方按钮完成邮箱验证，即可继续使用账号。
      </p>
      ${primaryButton(verifyUrl, '验证邮箱')}
      <p style="margin:20px 0 8px;font-size:13px;line-height:1.6;color:#5c6b66;">
        链接有效期为 <strong style="color:#14231f;">${safeExpires}</strong>。若按钮无法打开，请复制以下地址到浏览器：
      </p>
      <p style="margin:0;padding:12px 14px;background-color:#f3efe6;border-radius:12px;font-size:12px;line-height:1.55;word-break:break-all;">
        <a href="${safeUrl}" style="color:#1f6b4a;text-decoration:underline;">${safeUrl}</a>
      </p>
    `,
  });
}

export function renderPasswordResetEmailHtml(options: {
  appName: string;
  code: string;
  expiresIn: string;
}): string {
  const { appName, code, expiresIn } = options;
  const safeCode = escapeHtml(code);
  const safeExpires = escapeHtml(expiresIn);

  return emailShell({
    appName,
    preheader: `密码重置验证码 ${code}，${expiresIn} 内有效`,
    title: '重置密码验证码',
    bodyHtml: `
      <p style="margin:0 0 12px;font-size:15px;line-height:1.7;color:#14231f;">
        你正在重置 <strong>${escapeHtml(appName)}</strong> 账号密码。请使用下面的验证码完成操作：
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:24px 0;border-collapse:collapse;">
        <tr>
          <td align="center" style="padding:20px 16px;background-color:#f3efe6;border-radius:16px;border:1px solid rgba(20,35,31,0.08);">
            <span style="display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:0.35em;color:#14231f;line-height:1.2;">
              ${safeCode}
            </span>
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#5c6b66;">
        验证码有效期为 <strong style="color:#14231f;">${safeExpires}</strong>。如非本人操作，请忽略本邮件，账号不会被更改。
      </p>
    `,
  });
}
