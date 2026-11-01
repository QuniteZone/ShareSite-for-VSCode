import fs from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import sanitizeHtml from 'sanitize-html';
import { config } from './config.js';
import {
  escapeHtml,
  extOf,
  isImage,
  isMarkdown,
} from './util.js';
import {
  browseHref,
  isExcludedName,
  rawHref,
  resolveVirtual,
  viewHref,
  virtualFromAbsolute,
} from './paths.js';

const LANGUAGE_BY_EXT = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.jsx': 'javascript',
  '.py': 'python', '.pyw': 'python',
  '.java': 'java', '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.go': 'go', '.rs': 'rust', '.php': 'php', '.rb': 'ruby',
  '.pl': 'perl', '.lua': 'lua', '.r': 'r', '.sql': 'sql',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.ps1': 'powershell',
  '.bat': 'dos', '.cmd': 'dos',
  '.json': 'json', '.jsonc': 'json', '.json5': 'json',
  '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'ini', '.ini': 'ini',
  '.html': 'xml', '.htm': 'xml', '.xml': 'xml', '.svg': 'xml',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.md': 'markdown', '.markdown': 'markdown',
  '.tex': 'latex', '.latex': 'latex',
};

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripEscapes(value) {
  return String(value).replace(/\\([\\`*_{}\[\]()#+\-.!])/g, '$1');
}

function splitUrl(value) {
  let rest = String(value || '');
  let fragment = '';
  let query = '';

  const hashIndex = rest.indexOf('#');
  if (hashIndex >= 0) {
    fragment = rest.slice(hashIndex);
    rest = rest.slice(0, hashIndex);
  }

  const queryIndex = rest.indexOf('?');
  if (queryIndex >= 0) {
    query = rest.slice(queryIndex);
    rest = rest.slice(0, queryIndex);
  }

  return { pathname: rest, query, fragment };
}

function targetToVirtual(href, fromVpath) {
  const raw = String(href || '').trim();
  if (!raw) return null;

  if (/^file:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      let filePath = safeDecode(url.pathname);
      if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1);
      return virtualFromAbsolute(filePath);
    } catch {
      return null;
    }
  }

  if (/^[A-Za-z]:[\\/]/.test(raw)) {
    return virtualFromAbsolute(raw);
  }

  if (raw.startsWith('/api/files/download')) {
    try {
      const url = new URL(raw, 'http://local.invalid');
      const target = url.searchParams.get('path');
      if (!target) return null;
      return String(target).replace(/^\/+/, '');
    } catch {
      return null;
    }
  }

  if (raw.startsWith('/')) {
    return stripEscapes(safeDecode(raw)).replace(/^\/+/, '');
  }

  const { pathname } = splitUrl(raw);
  if (!pathname) return null;

  const decoded = stripEscapes(safeDecode(pathname)).replaceAll('\\', '/');
  const baseDir = path.posix.dirname(fromVpath);
  return path.posix.normalize(path.posix.join(baseDir, decoded));
}

function mappedHref(href, fromVpath, token, { forImage = false } = {}) {
  const raw = String(href || '').trim();
  if (!raw) return null;

  if (/^(https?:|mailto:|tel:|data:)/i.test(raw)) {
    return { href: raw, external: /^https?:/i.test(raw) };
  }

  if (raw.startsWith('#')) {
    return { href: raw, external: false };
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[A-Za-z]:[\\/]/.test(raw)) {
    return { href: '#', external: false, unsafe: true };
  }

  const { fragment } = splitUrl(raw);
  const virtual = targetToVirtual(raw, fromVpath);
  if (!virtual) return { href: '#', external: false, missing: true };

  const target = resolveVirtual(virtual);
  if (!target) return { href: '#', external: false, missing: true };

  if (target.isDir) {
    return { href: browseHref(token, target.vpath), external: false };
  }

  if (forImage) {
    if (!isImage(target.rel)) {
      return { href: rawHref(token, target.vpath), external: false };
    }
    return { href: rawHref(token, target.vpath), external: false };
  }

  if (isMarkdown(target.rel)) {
    return {
      href: `${viewHref(token, target.vpath)}${fragment || ''}`,
      external: false,
    };
  }

  return { href: `${rawHref(token, target.vpath)}${fragment || ''}`, external: false };
}

// —— 图片兜底 ——
// 笔记里的相对路径常常因为文件被移动/重组而失效（例如整本笔记被挪进「20260802以前记事本」）。
// 这里按文件名在已启用目录里建一个轻量索引，唯一命中同名图片时就地补上，避免整页都是「图片无法加载」。

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;
const IMAGE_INDEX_TTL_MS = 120000;
const IMAGE_INDEX_MAX_FILES = 60000;
const IMAGE_INDEX_MAX_DEPTH = 16;

let imageIndex = { at: 0, byName: new Map() };

function collectImages(absDir, rootName, relDir, byName, state) {
  if (state.count >= IMAGE_INDEX_MAX_FILES) return;

  let dirents;
  try {
    dirents = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const dirent of dirents) {
    if (isExcludedName(dirent.name) || dirent.isSymbolicLink()) continue;
    const abs = path.join(absDir, dirent.name);

    if (dirent.isDirectory()) {
      if (state.depth >= IMAGE_INDEX_MAX_DEPTH) continue;
      state.depth += 1;
      collectImages(abs, rootName, relDir ? `${relDir}/${dirent.name}` : dirent.name, byName, state);
      state.depth -= 1;
      continue;
    }

    if (!IMAGE_EXT.test(dirent.name)) continue;
    state.count += 1;

    const key = dirent.name.toLowerCase();
    const vpath = `${rootName}/${relDir ? `${relDir}/${dirent.name}` : dirent.name}`;
    const bucket = byName.get(key);
    if (bucket) {
      bucket.push(vpath);
    } else {
      byName.set(key, [vpath]);
    }
  }
}

function buildImageIndex() {
  const byName = new Map();
  for (const root of config.enabledRoots) {
    collectImages(root.path, root.name, '', byName, { count: 0, depth: 0 });
  }
  return { at: Date.now(), byName };
}

function getImageIndex() {
  if (Date.now() - imageIndex.at > IMAGE_INDEX_TTL_MS) {
    imageIndex = buildImageIndex();
  }
  return imageIndex.byName;
}

// 越靠后的目录层级重合越多，越可能是同一批文件
function pathAffinity(vpath, fromVpath) {
  const left = String(vpath).split('/');
  const right = String(fromVpath || '').split('/');
  let same = 0;
  while (
    same < left.length &&
    same < right.length &&
    left[left.length - 1 - same] === right[right.length - 1 - same]
  ) {
    same += 1;
  }
  return same;
}

function rescueImagePath(href, fromVpath) {
  // 先还原成虚拟路径：这样 /api/files/download?path=... 这种老链接也能取到真正的文件名
  const virtual = targetToVirtual(href, fromVpath) || splitUrl(String(href || '').trim()).pathname;
  const base = stripEscapes(safeDecode(virtual)).replaceAll('\\', '/').split('/').filter(Boolean).pop();
  if (!base || !IMAGE_EXT.test(base)) return null;

  const candidates = getImageIndex().get(base.toLowerCase());
  if (!candidates || candidates.length === 0) return null;

  let best = candidates[0];
  let bestScore = pathAffinity(best, fromVpath);
  for (const candidate of candidates.slice(1)) {
    const score = pathAffinity(candidate, fromVpath);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

// 图片地址统一在这里落地：能直接解析就解析，解析不了再按文件名兜底找一次
function resolveImageSrc(href, fromVpath, token) {
  const mapped = mappedHref(href, fromVpath, token, { forImage: true });
  if (mapped && !mapped.unsafe && !mapped.missing) {
    return mapped.href;
  }
  if (/^(https?:|data:)/i.test(String(href || '').trim())) {
    return mapped && mapped.href ? mapped.href : null;
  }

  const rescued = rescueImagePath(href, fromVpath);
  const entry = rescued ? resolveVirtual(rescued) : null;
  if (entry && !entry.isDir) {
    return rawHref(token, entry.vpath);
  }
  return null;
}

function createMarked(token, fromVpath) {
  const instance = new Marked({
    gfm: true,
    breaks: false,
    pedantic: false,
  });

  instance.use(
    markedHighlight({
      emptyLangClass: 'hljs',
      langPrefix: 'hljs language-',
      highlight(code, lang) {
        const language = String(lang || '').trim().toLowerCase();
        if (language && hljs.getLanguage(language)) {
          try {
            return hljs.highlight(code, { language, ignoreIllegals: true }).value;
          } catch {
            // fall through to escaped text
          }
        }
        return escapeHtml(code);
      },
    })
  );

  instance.use({
    renderer: {
      link({ href, title, text, tokens }) {
        const label = this.parser.parseInline(tokens) || escapeHtml(text || '');
        const mapped = mappedHref(href, fromVpath, token);
        if (!mapped || mapped.unsafe) {
          return `<span class="broken-link">${label}</span>`;
        }

        const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
        const external = mapped.external
          ? ' target="_blank" rel="noopener noreferrer"'
          : '';
        const missing = mapped.missing ? ' class="broken-link"' : '';
        return `<a href="${escapeHtml(mapped.href)}"${titleAttr}${external}${missing}>${label}</a>`;
      },

      image({ href, title, text }) {
        const alt = String(text || '');
        const src = resolveImageSrc(href, fromVpath, token);
        if (!src) {
          return `<span class="broken-image">${escapeHtml(alt || '图片无法加载')}</span>`;
        }

        const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${titleAttr} loading="lazy" decoding="async">`;
      },
    },
  });

  return instance;
}

// ── 内联标注色归一 ───────────────────────────────────────────────
// 笔记里的「文字颜色 / 高亮」是编辑器写进去的内联样式：
//   <span style="color: rgb(229, 87, 87);">…</span>
//   <mark data-color="#ff8c0066" style="background-color: rgba(255, 140, 0, 0.4);">…</mark>
// 原样放行有两个毛病：同一篇里能出现十种红十种黄；深色主题下又常常看不清。
// 这里按色相把颜色归到一组固定语义色，输出 md-tc-* / md-hl-* 类，色值统一由 CSS 变量决定。
const INK_HUES = [
  { name: 'red', hue: 0 },
  { name: 'orange', hue: 30 },
  { name: 'yellow', hue: 52 },
  { name: 'green', hue: 130 },
  { name: 'blue', hue: 215 },
  { name: 'purple', hue: 272 },
];

function parseColor(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;

  let match = text.match(/^#([0-9a-f]{3,8})$/);
  if (match) {
    let hex = match[1];
    if (hex.length === 3 || hex.length === 4) {
      hex = hex.split('').map((c) => c + c).join('');
    }
    if (hex.length !== 6 && hex.length !== 8) return null;
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
  }

  match = text.match(/^rgba?\(([^)]+)\)$/);
  if (!match) return null;
  const parts = match[1].split(/[,/\s]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

function hueOf({ r, g, b }) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (!delta || !max) return { hue: 0, sat: 0 };

  let hue;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return { hue, sat: delta / max };
}

function classifyInk(value, kind) {
  const color = parseColor(value);
  if (!color) return null;
  if (kind === 'text' && color.a < 0.35) return null;
  if (kind === 'bg' && color.a < 0.05) return null;

  const { hue, sat } = hueOf(color);
  if (sat < 0.1) {
    // 中性色只认「灰」；白、近白、黑都不算标注
    const luma = (0.299 * color.r + 0.587 * color.g + 0.114 * color.b) / 255;
    return luma > 0.15 && luma < 0.85 ? 'grey' : null;
  }

  let best = INK_HUES[0];
  let bestDistance = Infinity;
  for (const ink of INK_HUES) {
    let distance = Math.abs(ink.hue - hue);
    if (distance > 180) distance = 360 - distance;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = ink;
    }
  }
  return best.name;
}

function readDeclarations(style) {
  const result = {};
  for (const part of String(style || '').split(';')) {
    const index = part.indexOf(':');
    if (index < 0) continue;
    result[part.slice(0, index).trim().toLowerCase()] = part.slice(index + 1).trim();
  }
  return result;
}

// span / mark 走这里：把内联颜色换成类名，顺手把所有 style、data-color 丢掉
function transformAnnotatedTag(tagName, attribs) {
  const declarations = readDeclarations(attribs.style);
  const classes = String(attribs.class || '').split(/\s+/).filter(Boolean);

  if (tagName === 'span') {
    const ink = classifyInk(declarations.color, 'text');
    if (ink) classes.push(`md-tc-${ink}`);
  } else if (tagName === 'mark') {
    const ink =
      classifyInk(attribs['data-color'], 'bg') ||
      classifyInk(declarations['background-color'], 'bg');
    if (ink) classes.push(`md-hl-${ink}`);
  }

  const { style, 'data-color': dataColor, class: _cls, ...rest } = attribs;
  return {
    tagName,
    attribs: classes.length ? { ...rest, class: [...new Set(classes)].join(' ') } : rest,
  };
}

const SANITIZE_OPTIONS = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    'img', 'details', 'summary', 'figure', 'figcaption', 'mark', 'kbd',
    'sup', 'sub', 'ins', 'del', 'input', 'video', 'audio', 'source', 'picture',
  ],
  allowedAttributes: {
    '*': ['id', 'class', 'title', 'align'],
    a: ['href', 'name', 'target', 'rel', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'decoding'],
    input: ['type', 'checked', 'disabled'],
    ol: ['start'],
    code: ['class'],
    th: ['align'],
    td: ['align'],
    video: ['src', 'controls', 'poster', 'width', 'height'],
    audio: ['src', 'controls'],
    source: ['src', 'type'],
  },
  allowedClasses: {
    '*': [
      'hljs', /^hljs-/, /^language-/, 'katex', /^katex-/,
      'broken-link', 'broken-image',
      /^md-tc-/, /^md-hl-/,
    ],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: {
    img: ['http', 'https', 'data'],
    a: ['http', 'https', 'mailto', 'tel'],
  },
  allowProtocolRelative: false,
  transformTags: {
    span: transformAnnotatedTag,
    mark: transformAnnotatedTag,
    a: (tagName, attribs) => {
      const href = attribs.href || '';
      if (/^https?:/i.test(href) && !attribs.rel) {
        return {
          tagName,
          attribs: { ...attribs, rel: 'noopener noreferrer' },
        };
      }
      return { tagName, attribs };
    },
  },
};

// 笔记里直接写的 <img src="…"> 不会经过 marked 的 renderer，这里在消毒阶段补做地址重写
function sanitizeOptionsFor(token, fromVpath) {
  return {
    ...SANITIZE_OPTIONS,
    transformTags: {
      ...SANITIZE_OPTIONS.transformTags,
      img: (tagName, attribs) => {
        const src = String(attribs.src || '').trim();
        if (!src || /^\/(s|assets|vendor)\//i.test(src)) {
          return { tagName, attribs };
        }
        const resolved = resolveImageSrc(src, fromVpath, token);
        if (resolved) {
          return { tagName, attribs: { ...attribs, src: resolved } };
        }
        return { tagName, attribs: { ...attribs, src: '' } };
      },
    },
  };
}

function countReading(text) {
  const plain = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ');

  const cjk = (plain.match(/[぀-ヿ㐀-鿿豈-﫿]/g) || []).length;
  const latin = (plain.replace(/[぀-ヿ㐀-鿿豈-﫿]/g, ' ')
    .match(/[A-Za-z0-9_]+/g) || []).length;

  const characters = cjk + latin * 5;
  return {
    characters,
    words: cjk + latin,
    minutes: Math.max(1, Math.ceil(characters / 500)),
  };
}

export function renderMarkdown(markdown, { token, vpath }) {
  const instance = createMarked(token, vpath);
  const rawHtml = instance.parse(String(markdown || ''));
  const html = sanitizeHtml(rawHtml, sanitizeOptionsFor(token, vpath));
  return {
    html,
    stats: countReading(markdown),
  };
}

export function renderPlainText(text, name) {
  const language = LANGUAGE_BY_EXT[extOf(name)] || '';
  let html;
  let className = 'hljs';

  if (language && hljs.getLanguage(language)) {
    try {
      html = hljs.highlight(String(text), {
        language,
        ignoreIllegals: true,
      }).value;
      className = `hljs language-${language}`;
    } catch {
      html = escapeHtml(text);
    }
  } else {
    html = escapeHtml(text);
  }

  const lines = String(text).split(/\r?\n/).length;
  return {
    html: `<pre class="code-view"><code class="${className}">${html}</code></pre>`,
    language,
    lines,
  };
}
