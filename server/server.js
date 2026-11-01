import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { config, projectRoot } from './lib/config.js';
import { renderMarkdown, renderPlainText } from './lib/markdown.js';
import { idFor, vpathFor } from './lib/links.js';
import {
  browseHref,
  listDirectory,
  resolveVirtual,
  rootSummary,
} from './lib/paths.js';
import { browsePage, errorPage, homePage, viewPage } from './lib/templates.js';
import {
  formatBytes,
  isMarkdown,
  isText,
  kindOf,
  mimeOf,
} from './lib/util.js';

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "img-src 'self' data: https:",
      "font-src 'self'",
      "media-src 'self'",
      "frame-src 'self'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "object-src 'none'",
    ].join('; ')
  );
  if (!req.path.startsWith('/assets/') && !req.path.startsWith('/vendor/')) {
    res.setHeader('Cache-Control', 'private, no-store');
  }
  next();
});

function tokenMatches(candidate) {
  const supplied = Buffer.from(String(candidate || ''));
  const expected = Buffer.from(config.token);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function sendError(res, status, message) {
  res.status(status).type('html').send(errorPage(null, { status, message }));
}

function queryPath(req) {
  return typeof req.query.p === 'string' ? req.query.p : '';
}

/**
 * 旧链接 `?p=` 里可能只有相对路径（没有根目录名），例如 `测试/示例.md`。
 * 这种写法以前一律 404，现在按启用顺序补上根名再解析，保证老链接还能打开。
 */
function resolveQueryEntry(value) {
  const vpath = String(value || '');
  const direct = resolveVirtual(vpath);
  if (direct) return direct;

  for (const root of config.enabledRoots) {
    const entry = resolveVirtual(`${root.name}/${vpath}`);
    if (entry) return entry;
  }
  return null;
}

function contentDisposition(name, download) {
  const fallback = String(name)
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replaceAll("'", '%27');
  return `${download ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function isInlineSafe(name) {
  return (
    kindOf(name) === 'image' ||
    kindOf(name) === 'pdf' ||
    kindOf(name) === 'audio' ||
    kindOf(name) === 'video' ||
    isMarkdown(name) ||
    isText(name)
  );
}

app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'share-site' });
});

// 本地 API：VS Code 扩展用它把「根目录/相对路径」换成 8 位短 id。
// 只在本机 127.0.0.1 上被调用；公网虽然也能到，但同样要带 token。
app.get('/api/link', (req, res) => {
  if (!tokenMatches(req.query.token)) {
    return res.status(404).json({ error: '分享链接无效' });
  }

  const vpath = typeof req.query.vpath === 'string' ? req.query.vpath : '';
  if (!vpath) return res.status(400).json({ error: '缺少 vpath' });

  const entry = resolveQueryEntry(vpath);
  if (!entry) return res.status(404).json({ error: '不在分享目录内' });

  res.json({ id: idFor(entry.vpath), vpath: entry.vpath, isDir: entry.isDir });
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

app.get('/favicon.ico', (req, res) => {
  res.redirect(301, '/assets/favicon.svg');
});

app.use('/assets', express.static(path.join(projectRoot, 'public'), {
  etag: true,
  maxAge: '1h',
}));

app.use('/vendor/katex', express.static(path.join(projectRoot, 'node_modules', 'katex', 'dist'), {
  etag: true,
  maxAge: '7d',
}));

app.use('/s/:token', (req, res, next) => {
  if (!tokenMatches(req.params.token)) {
    return sendError(res, 404, '分享链接无效');
  }
  req.shareToken = req.params.token;
  next();
});

app.get('/s/:token', async (req, res, next) => {
  try {
    const roots = await rootSummary();
    res.type('html').send(homePage(req.shareToken, roots));
  } catch (error) {
    next(error);
  }
});

async function sendBrowsePage(res, token, listing) {
  const parentVpath = listing.entry.rel
    ? listing.entry.vpath.split('/').slice(0, -1).join('/')
    : '';

  res.type('html').send(
    browsePage(token, {
      entry: listing.entry,
      items: listing.items,
      parentVpath,
    })
  );
}

async function sendViewPage(res, token, entry) {
  const name = entry.rel.split('/').pop();
  const kind = kindOf(name);
  let content = '';
  let stats;
  let textInfo;

  if (kind === 'markdown') {
    if (entry.stat.size > config.maxMarkdownBytes) {
      return res.status(413).type('html').send(
        errorPage(token, {
          status: 413,
          message: `Markdown 文件超过 ${formatBytes(config.maxMarkdownBytes)}`,
        })
      );
    }
    const markdown = await fsp.readFile(entry.abs, 'utf8');
    const rendered = renderMarkdown(markdown, { token, vpath: entry.vpath });
    content = rendered.html;
    stats = rendered.stats;
  } else if (kind === 'code') {
    if (entry.stat.size > config.maxTextBytes) {
      return res.status(413).type('html').send(
        errorPage(token, {
          status: 413,
          message: `文本文件超过 ${formatBytes(config.maxTextBytes)}`,
        })
      );
    }
    const text = await fsp.readFile(entry.abs, 'utf8');
    const rendered = renderPlainText(text, name);
    content = rendered.html;
    textInfo = rendered;
  }

  res.type('html').send(
    viewPage(token, { entry, kind, content, stats, textInfo })
  );
}

function sendRawFile(res, next, entry, { download }) {
  const name = entry.rel.split('/').pop();
  res.setHeader('Content-Type', mimeOf(name));
  res.setHeader('Content-Disposition', contentDisposition(name, download));
  res.setHeader('Cache-Control', 'private, no-store');

  if (kindOf(name) === 'image' && name.toLowerCase().endsWith('.svg')) {
    res.setHeader(
      'Content-Security-Policy',
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
    );
  }

  res.sendFile(entry.abs, (error) => {
    if (error && !res.headersSent) next(error);
  });
}

function notFoundPage(res, token, message) {
  return res
    .status(404)
    .type('html')
    .send(errorPage(token, { status: 404, message }));
}

app.get('/s/:token/browse', async (req, res, next) => {
  try {
    const vpath = queryPath(req);
    if (!vpath) {
      return res.redirect(302, `/s/${encodeURIComponent(req.shareToken)}/`);
    }

    let listing = await listDirectory(vpath);
    if (!listing) {
      // 旧链接只有相对路径，补上根目录名再试
      for (const root of config.enabledRoots) {
        listing = await listDirectory(`${root.name}/${vpath}`);
        if (listing) break;
      }
    }
    if (!listing) {
      return notFoundPage(res, req.shareToken, '目录不存在');
    }

    await sendBrowsePage(res, req.shareToken, listing);
  } catch (error) {
    next(error);
  }
});

app.get('/s/:token/view', async (req, res, next) => {
  try {
    const entry = resolveQueryEntry(queryPath(req));
    if (!entry) {
      return notFoundPage(res, req.shareToken, '文件不存在');
    }
    if (entry.isDir) {
      return res.redirect(302, browseHref(req.shareToken, entry.vpath));
    }

    await sendViewPage(res, req.shareToken, entry);
  } catch (error) {
    next(error);
  }
});

app.get('/s/:token/raw', async (req, res, next) => {
  try {
    const entry = resolveQueryEntry(queryPath(req));
    if (!entry || entry.isDir) {
      return res.status(404).type('text/plain').send('Not found');
    }
    const name = entry.rel.split('/').pop();
    const download = req.query.download === '1' || !isInlineSafe(name);
    sendRawFile(res, next, entry, { download });
  } catch (error) {
    next(error);
  }
});

app.get('/s/:token/download', async (req, res, next) => {
  try {
    const entry = resolveQueryEntry(queryPath(req));
    if (!entry || entry.isDir) {
      return res.status(404).type('text/plain').send('Not found');
    }
    sendRawFile(res, next, entry, { download: true });
  } catch (error) {
    next(error);
  }
});

// 短链接：/s/<token>/r/<id> —— 原文件（图片、PDF 内嵌用）
app.get('/s/:token/r/:id', (req, res, next) => {
  try {
    const vpath = vpathFor(req.params.id);
    const entry = vpath ? resolveVirtual(vpath) : null;
    if (!entry || entry.isDir) {
      return res.status(404).type('text/plain').send('Not found');
    }
    const name = entry.rel.split('/').pop();
    sendRawFile(res, next, entry, { download: !isInlineSafe(name) });
  } catch (error) {
    next(error);
  }
});

// 短链接：/s/<token>/d/<id> —— 强制下载
app.get('/s/:token/d/:id', (req, res, next) => {
  try {
    const vpath = vpathFor(req.params.id);
    const entry = vpath ? resolveVirtual(vpath) : null;
    if (!entry || entry.isDir) {
      return res.status(404).type('text/plain').send('Not found');
    }
    sendRawFile(res, next, entry, { download: true });
  } catch (error) {
    next(error);
  }
});

// 短链接：/s/<token>/<id> —— 目录走浏览页，文件走阅读页
app.get('/s/:token/:id', async (req, res, next) => {
  try {
    const vpath = vpathFor(req.params.id);
    if (!vpath) {
      return notFoundPage(res, req.shareToken, '链接不存在或已失效');
    }

    const entry = resolveVirtual(vpath);
    if (!entry) {
      return notFoundPage(res, req.shareToken, '文件不存在');
    }

    if (entry.isDir) {
      const listing = await listDirectory(vpath);
      if (!listing) {
        return notFoundPage(res, req.shareToken, '目录不存在');
      }
      return sendBrowsePage(res, req.shareToken, listing);
    }

    return sendViewPage(res, req.shareToken, entry);
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  sendError(res, 404, '页面不存在');
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error('[share-site]', error.message);
  sendError(res, 500, '读取文件时出错');
});

const server = app.listen(config.port, config.host, () => {
  const base = config.baseUrl || `http://${config.host}:${config.port}`;
  console.log(`[share-site] listening on ${config.host}:${config.port}`);
  console.log(`[share-site] public base: ${base}`);
  console.log(`[share-site] enabled roots: ${config.enabledRoots.map((root) => root.name).join(', ')}`);
});

function shutdown(signal) {
  console.log(`[share-site] ${signal}, closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 4000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
