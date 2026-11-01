import fs from 'node:fs';
import path from 'node:path';
import { config, projectRoot } from './config.js';
import {
  browseHref,
  downloadHref,
  rawHref,
  shareBase,
  viewHref,
} from './paths.js';
import {
  escapeHtml,
  formatBytes,
  formatDate,
  icon,
  kindOf,
} from './util.js';

// 静态资源带版本号：改了 CSS/JS 后浏览器和 Cloudflare 都能立刻拿到新文件。
function assetVersion(name) {
  try {
    return String(Math.floor(fs.statSync(path.join(projectRoot, 'public', name)).mtimeMs));
  } catch {
    return '0';
  }
}

const assetVersions = {
  css: assetVersion('style.css'),
  app: assetVersion('app.js'),
  theme: assetVersion('theme-init.js'),
  icon: assetVersion('favicon.svg'),
};

function layout({ title, token, body, bodyClass = '', showTocButton = false }) {
  const home = token ? `${shareBase(token)}/` : '#';
  const pageTitle = title ? `${title} · ${config.siteName}` : config.siteName;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(pageTitle)}</title>
<link rel="icon" href="/assets/favicon.svg?v=${assetVersions.icon}" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/favicon.svg?v=${assetVersions.icon}">
<script src="/assets/theme-init.js?v=${assetVersions.theme}"></script>
<link rel="stylesheet" href="/vendor/katex/katex.min.css">
<link rel="stylesheet" href="/assets/style.css?v=${assetVersions.css}">
</head>
<body class="${escapeHtml(bodyClass)}">
<div class="reading-progress" id="reading-progress"></div>
<header class="topbar">
  <a class="brand" href="${escapeHtml(home)}">
    <span class="brand-mark">Q</span>
    <span class="brand-text">${escapeHtml(config.siteName)}</span>
  </a>
  <div class="top-actions">
    ${showTocButton ? `<button class="icon-button toc-toggle" type="button" data-toc-toggle aria-label="显示目录" title="目录">${icon('toc')}</button>` : ''}
    <a class="icon-button" href="${escapeHtml(home)}" aria-label="首页" title="首页">${icon('home')}</a>
    <button class="icon-button theme-toggle" type="button" data-theme-toggle aria-label="切换深浅色" title="切换深浅色">
      <span class="theme-icon-light">${icon('sun')}</span>
      <span class="theme-icon-dark">${icon('moon')}</span>
    </button>
  </div>
</header>
${showTocButton ? '<div class="toc-backdrop" data-toc-backdrop aria-hidden="true"></div>' : ''}
${body}
<footer class="site-footer">
  <span>${escapeHtml(config.siteName)}</span>
  <span class="dot">·</span>
  <span>只读分享，不会修改文件</span>
</footer>
<script src="/vendor/katex/katex.min.js" defer></script>
<script src="/vendor/katex/contrib/auto-render.min.js" defer></script>
<script src="/assets/app.js?v=${assetVersions.app}" defer></script>
</body>
</html>`;
}

function cardPreview(preview) {
  if (!preview.length) {
    return '<span class="muted">空目录</span>';
  }

  return preview
    .map((item) => {
      const kind = kindOf(item.name, item.isDir);
      return `<span class="preview-chip">${icon(kind, 14)}<span>${escapeHtml(item.name)}</span></span>`;
    })
    .join('');
}

export function homePage(token, roots) {
  const cards = roots
    .map((root) => {
      const href = browseHref(token, root.name);
      const meta = root.itemCount
        ? `${root.dirCount} 个文件夹 · ${root.fileCount} 个文件`
        : '空目录';

      return `<a class="root-card" href="${escapeHtml(href)}">
        <span class="root-icon">${icon('dir', 28)}</span>
        <span class="root-body">
          <span class="root-name">${escapeHtml(root.name)}</span>
          ${root.description ? `<span class="root-desc">${escapeHtml(root.description)}</span>` : ''}
          <span class="root-meta">${escapeHtml(meta)}</span>
          <span class="root-preview">${cardPreview(root.preview)}</span>
        </span>
        <span class="root-arrow">${icon('external', 18)}</span>
      </a>`;
    })
    .join('');

  const body = `<main class="home">
    <section class="hero">
      <p class="eyebrow">READ ONLY · FILE READER</p>
      <h1>${escapeHtml(config.siteName)}</h1>
      <p class="hero-copy">${escapeHtml(config.siteDescription)}。Markdown 会自动排版，代码、表格、图片与公式均可直接阅读。</p>
    </section>
    <section class="root-grid" aria-label="资料库">
      ${cards}
    </section>
    <p class="home-note">此链接为只读分享。请勿将地址转发给不信任的人；地址本身即访问凭证。</p>
  </main>`;

  return layout({ title: '', token, body, bodyClass: 'page-home' });
}

function breadcrumbs(token, vpath, { file = false } = {}) {
  const parts = String(vpath || '').split('/').filter(Boolean);
  const items = [];

  items.push(`<a href="${escapeHtml(`${shareBase(token)}/`)}">首页</a>`);

  let accumulated = '';
  const visibleParts = file ? parts.slice(0, -1) : parts;
  visibleParts.forEach((part, index) => {
    accumulated = [accumulated, part].filter(Boolean).join('/');
    const href = browseHref(token, accumulated);
    const isLast = index === visibleParts.length - 1;
    items.push(
      isLast
        ? `<span aria-current="page">${escapeHtml(part)}</span>`
        : `<a href="${escapeHtml(href)}">${escapeHtml(part)}</a>`
    );
  });

  if (file && parts.length) {
    items.push(`<span aria-current="page">${escapeHtml(parts[parts.length - 1])}</span>`);
  }

  return `<nav class="breadcrumbs" aria-label="位置">${items.join('<span class="crumb-sep">/</span>')}</nav>`;
}

function entryRow(token, item) {
  const href = item.isDir ? browseHref(token, item.vpath) : viewHref(token, item.vpath);
  const meta = item.isDir ? '文件夹' : formatBytes(item.size);
  const className = `entry kind-${item.kind}`;

  return `<a class="${className}" href="${escapeHtml(href)}" data-name="${escapeHtml(item.name.toLowerCase())}">
    <span class="entry-icon">${icon(item.kind, 22)}</span>
    <span class="entry-main">
      <span class="entry-name">${escapeHtml(item.name)}</span>
      <span class="entry-meta">${escapeHtml(meta)} · ${escapeHtml(formatDate(item.mtime))}</span>
    </span>
    <span class="entry-action">${item.isDir ? '浏览' : '阅读'}</span>
    <span class="entry-chevron">${icon('back', 16)}</span>
  </a>`;
}

export function browsePage(token, { entry, items, parentVpath }) {
  const currentName = entry.rel ? entry.rel.split('/').pop() : entry.root.name;
  const title = entry.rel ? currentName : `${entry.root.name}`;
  const rows = items.map((item) => entryRow(token, item)).join('');
  const parentRow = parentVpath
    ? `<a class="entry parent-row" href="${escapeHtml(browseHref(token, parentVpath))}">
        <span class="entry-icon">${icon('arrowUp', 22)}</span>
        <span class="entry-main"><span class="entry-name">返回上一级</span></span>
      </a>`
    : '';

  const body = `<main class="browse">
    <div class="page-head">
      ${breadcrumbs(token, entry.vpath)}
      <div class="page-title-row">
        <div>
          <p class="eyebrow">${entry.rel ? 'DIRECTORY' : 'LIBRARY'}</p>
          <h1>${escapeHtml(title)}</h1>
        </div>
        <span class="page-count">${items.length} 项</span>
      </div>
    </div>
    <div class="browse-toolbar">
      <label class="search-box">
        ${icon('file', 17)}
        <input type="search" id="entry-filter" placeholder="筛选当前目录…" autocomplete="off" spellcheck="false">
        <kbd>/</kbd>
      </label>
    </div>
    <div class="entry-list" id="entry-list">
      ${parentRow}
      ${rows || `<div class="empty-state">${icon('dir', 34)}<p>这个目录是空的。</p></div>`}
    </div>
    <p class="list-hint" id="filter-empty" hidden>没有匹配的项目。</p>
  </main>`;

  return layout({ title, token, body, bodyClass: 'page-browse' });
}

function docMeta(entry, stats) {
  const parts = [formatBytes(entry.stat.size), formatDate(entry.stat.mtime)];
  if (stats) {
    parts.push(`约 ${stats.minutes} 分钟阅读`);
    if (stats.words) parts.push(`${stats.words} 字`);
  }
  return parts.map((part) => `<span>${escapeHtml(part)}</span>`).join('<span class="dot">·</span>');
}

function mediaBody(entry, token) {
  const name = entry.rel.split('/').pop();
  const raw = rawHref(token, entry.vpath);
  const download = downloadHref(token, entry.vpath);
  const kind = kindOf(name);

  if (kind === 'image') {
    return `<figure class="media-view">
      <img src="${escapeHtml(raw)}" alt="${escapeHtml(name)}">
      <figcaption>点击图片可在新标签打开原图</figcaption>
    </figure>`;
  }

  if (kind === 'pdf') {
    return `<div class="pdf-view">
      <iframe src="${escapeHtml(raw)}#view=FitH" title="${escapeHtml(name)}"></iframe>
      <p class="media-fallback">PDF 无法显示？<a href="${escapeHtml(raw)}" target="_blank" rel="noopener">在新标签打开</a></p>
    </div>`;
  }

  if (kind === 'video') {
    return `<div class="media-view"><video controls preload="metadata" src="${escapeHtml(raw)}"></video></div>`;
  }

  if (kind === 'audio') {
    return `<div class="media-view audio-view"><audio controls preload="metadata" src="${escapeHtml(raw)}"></audio></div>`;
  }

  return `<div class="download-card">
    <span class="download-icon">${icon(kind, 36)}</span>
    <h2>${escapeHtml(name)}</h2>
    <p>此文件类型不能在线预览。</p>
    <a class="primary-button" href="${escapeHtml(download)}">${icon('download', 18)} 下载文件</a>
  </div>`;
}

export function viewPage(token, { entry, kind, content, stats, textInfo }) {
  const name = entry.rel.split('/').pop();
  const title = name.replace(/\.[^.]+$/, '') || name;
  const raw = rawHref(token, entry.vpath);
  const download = downloadHref(token, entry.vpath);
  const parent = entry.vpath.split('/').slice(0, -1).join('/');

  let article = '';
  if (kind === 'markdown') {
    article = `<article class="markdown-body" id="article">${content}</article>`;
  } else if (kind === 'code') {
    article = `<article class="markdown-body text-body" id="article">
      <div class="text-info">${escapeHtml(textInfo.language || '纯文本')} · ${textInfo.lines} 行</div>
      ${content}
    </article>`;
  } else {
    article = mediaBody(entry, token);
  }

  // 文档自己已经有 H1 时不再重复显示标题（和 MD Editor Plus 的预览一致）
  const hasOwnTitle = /^\s*<h1[\s>]/i.test(content);
  const titleBlock =
    kind === 'markdown' && hasOwnTitle
      ? ''
      : `<h1>${escapeHtml(title)}</h1>`;

  const hasToc = kind === 'markdown' || kind === 'code';

  const tocPanel = hasToc
    ? `<aside class="toc-panel" id="toc-panel" aria-label="文章目录">
        <div class="toc-head">
          <span class="toc-label">${icon('toc', 16)} 目录</span>
          <button class="toc-close" type="button" data-toc-close aria-label="关闭目录" title="关闭">×</button>
        </div>
        <nav class="toc-nav" id="toc"></nav>
      </aside>`
    : '';

  const body = `<main class="view">
    <div class="reader-layout${hasToc ? '' : ' no-toc'}">
      ${tocPanel}
      <div class="reader-main">
        <div class="page-head view-head">
          ${breadcrumbs(token, entry.vpath, { file: true })}
          <div class="doc-title-row">
            <div class="doc-title-text">
              ${titleBlock}
              <div class="doc-meta">${docMeta(entry, stats)}</div>
            </div>
            <div class="doc-actions">
              <a class="soft-button" href="${escapeHtml(browseHref(token, parent))}">${icon('back', 16)} 目录</a>
              <a class="soft-button" href="${escapeHtml(raw)}" target="_blank" rel="noopener">${icon('external', 16)} 源文件</a>
              <a class="soft-button" href="${escapeHtml(download)}">${icon('download', 16)} 下载</a>
            </div>
          </div>
        </div>
        ${article}
        <div class="doc-footer">
          <a href="${escapeHtml(browseHref(token, parent))}">${icon('back', 15)} 返回目录</a>
          <span>只读分享 · 不会修改文件</span>
        </div>
      </div>
    </div>
  </main>`;

  return layout({
    title,
    token,
    body,
    bodyClass: `page-view kind-${kind}`,
    showTocButton: hasToc,
  });
}

export function errorPage(token, { status = 404, message = '页面不存在' } = {}) {
  const home = token ? `${shareBase(token)}/` : '';
  const body = `<main class="error-page">
    <p class="error-code">${escapeHtml(status)}</p>
    <h1>${escapeHtml(message)}</h1>
    <p class="muted">链接可能已失效，或文件已经被移动 / 删除。</p>
    ${home ? `<a class="primary-button" href="${escapeHtml(home)}">${icon('home', 18)} 返回首页</a>` : ''}
  </main>`;

  return layout({ title: `${status}`, token: token || '', body, bodyClass: 'page-error' });
}
