function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

type PageKind = 'ok' | 'err';

function layout(options: {
  title: string;
  appName: string;
  kind: PageKind;
  heading: string;
  detailHtml: string;
  hint: string;
}): string {
  const { title, appName, kind, heading, detailHtml, hint } = options;
  const brand = escapeHtml(appName);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · ${brand}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,650&family=Noto+Sans+SC:wght@400;500;600&display=swap" rel="stylesheet" />
  <style>
    :root {
      --ink: #14231f;
      --muted: #5c6b66;
      --paper: #f3efe6;
      --panel: rgba(255, 252, 247, 0.78);
      --line: rgba(20, 35, 31, 0.1);
      --ok: #1f6b4a;
      --ok-soft: #d8efe4;
      --err: #9a3412;
      --err-soft: #fce8df;
      --glow-a: #c8e6d8;
      --glow-b: #e8d5b5;
      --glow-c: #b9d4e8;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: var(--ink);
      background: var(--paper);
      overflow-x: hidden;
    }

    .scene {
      position: relative;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: clamp(24px, 5vw, 48px);
      isolation: isolate;
    }

    .scene::before,
    .scene::after {
      content: "";
      position: absolute;
      inset: auto;
      border-radius: 50%;
      filter: blur(60px);
      opacity: 0.7;
      z-index: -2;
      animation: drift 14s ease-in-out infinite alternate;
    }

    .scene::before {
      width: min(70vw, 520px);
      height: min(70vw, 520px);
      top: -8%;
      left: -6%;
      background: radial-gradient(circle at 30% 30%, var(--glow-a), transparent 65%);
    }

    .scene::after {
      width: min(65vw, 480px);
      height: min(65vw, 480px);
      right: -8%;
      bottom: -12%;
      background: radial-gradient(circle at 60% 40%, var(--glow-b), var(--glow-c) 45%, transparent 70%);
      animation-delay: -4s;
    }

    .grain {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: -1;
      opacity: 0.35;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.45'/%3E%3C/svg%3E");
      mix-blend-mode: multiply;
    }

    .panel {
      width: min(100%, 440px);
      padding: clamp(28px, 5vw, 40px) clamp(24px, 4vw, 36px) clamp(32px, 5vw, 44px);
      text-align: center;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 28px;
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      box-shadow:
        0 1px 0 rgba(255, 255, 255, 0.65) inset,
        0 24px 60px rgba(20, 35, 31, 0.08);
      animation: rise 0.7s cubic-bezier(0.22, 1, 0.36, 1) both;
    }

    .brand {
      margin: 0 0 28px;
      font-family: "Fraunces", "Noto Serif SC", Georgia, serif;
      font-size: clamp(1.55rem, 4.5vw, 1.9rem);
      font-weight: 650;
      letter-spacing: -0.02em;
      line-height: 1.15;
      animation: rise 0.7s cubic-bezier(0.22, 1, 0.36, 1) 0.05s both;
    }

    .mark {
      width: 72px;
      height: 72px;
      margin: 0 auto 22px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      animation: pop 0.55s cubic-bezier(0.22, 1, 0.36, 1) 0.12s both;
    }

    .mark svg {
      width: 34px;
      height: 34px;
      stroke-width: 2.4;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .ok .mark {
      background: var(--ok-soft);
      color: var(--ok);
      box-shadow: 0 0 0 10px rgba(31, 107, 74, 0.06);
    }

    .err .mark {
      background: var(--err-soft);
      color: var(--err);
      box-shadow: 0 0 0 10px rgba(154, 52, 18, 0.06);
    }

    .ok .mark svg { stroke: var(--ok); }
    .err .mark svg { stroke: var(--err); }

    .ok .mark svg path {
      stroke-dasharray: 36;
      stroke-dashoffset: 36;
      animation: draw 0.45s ease forwards 0.35s;
    }

    .err .mark svg path {
      stroke-dasharray: 28;
      stroke-dashoffset: 28;
      animation: draw 0.35s ease forwards 0.3s;
    }

    h1 {
      margin: 0 0 12px;
      font-family: "Fraunces", "Noto Serif SC", Georgia, serif;
      font-size: clamp(1.35rem, 3.8vw, 1.6rem);
      font-weight: 650;
      letter-spacing: -0.02em;
      animation: rise 0.7s cubic-bezier(0.22, 1, 0.36, 1) 0.18s both;
    }

    .ok h1 { color: var(--ok); }
    .err h1 { color: var(--err); }

    .detail, .hint {
      margin: 0;
      line-height: 1.7;
      color: var(--muted);
      font-size: 0.95rem;
      animation: rise 0.7s cubic-bezier(0.22, 1, 0.36, 1) 0.26s both;
    }

    .hint {
      margin-top: 14px;
      font-size: 0.88rem;
      opacity: 0.92;
      animation-delay: 0.34s;
    }

    .email {
      color: var(--ink);
      font-weight: 600;
      word-break: break-all;
    }

    @keyframes rise {
      from { opacity: 0; transform: translateY(14px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes pop {
      from { opacity: 0; transform: scale(0.72); }
      to { opacity: 1; transform: scale(1); }
    }

    @keyframes draw {
      to { stroke-dashoffset: 0; }
    }

    @keyframes drift {
      from { transform: translate(0, 0) scale(1); }
      to { transform: translate(18px, 12px) scale(1.06); }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }
    }
  </style>
</head>
<body>
  <div class="grain" aria-hidden="true"></div>
  <div class="scene">
    <main class="panel ${kind}">
      <p class="brand">${brand}</p>
      <div class="mark" aria-hidden="true">
        ${
          kind === 'ok'
            ? `<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>`
            : `<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>`
        }
      </div>
      <h1>${escapeHtml(heading)}</h1>
      <p class="detail">${detailHtml}</p>
      <p class="hint">${escapeHtml(hint)}</p>
    </main>
  </div>
</body>
</html>`;
}

export function renderVerifyEmailSuccessPage(
  email: string,
  appName: string,
): string {
  return layout({
    title: '邮箱验证成功',
    appName,
    kind: 'ok',
    heading: '邮箱验证成功',
    detailHtml: `账号 <span class="email">${escapeHtml(email)}</span> 已完成验证。`,
    hint: '可以关闭此页面，返回应用继续使用。',
  });
}

export function renderVerifyEmailFailurePage(
  message: string,
  appName: string,
): string {
  return layout({
    title: '邮箱验证失败',
    appName,
    kind: 'err',
    heading: '邮箱验证失败',
    detailHtml: escapeHtml(message),
    hint: '请重新获取验证邮件后再试。',
  });
}
