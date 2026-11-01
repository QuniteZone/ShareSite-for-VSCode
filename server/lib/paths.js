import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { idFor } from './links.js';
import { kindOf } from './util.js';

const DEFAULT_EXCLUDES = new Set([
  '.git', '.svn', '.hg', '.obsidian', '.venv', 'venv', 'node_modules',
  '__pycache__', '.idea', '.vscode', '$recycle.bin', 'system volume information',
  'thumbs.db', 'desktop.ini', '.ds_store',
]);

export function isExcludedName(name) {
  const lower = String(name).toLowerCase();
  return lower.startsWith('.') || DEFAULT_EXCLUDES.has(lower) || config.exclude.has(lower);
}

function normalizeVirtualPath(value) {
  const raw = String(value || '')
    .replaceAll('\\', '/')
    .replace(/^\/+|\/+$/g, '');

  if (!raw) return { raw: '', parts: [] };

  const parts = raw.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') return null;
    if (part.includes('\0') || part.includes(':')) return null;
    if (isExcludedName(part)) return null;
  }

  return { raw: parts.join('/'), parts };
}

function rootByName(name) {
  return config.enabledRoots.find(
    (root) => root.name.toLowerCase() === String(name).toLowerCase()
  );
}

function inside(base, target) {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveVirtual(value, { allowMissing = false } = {}) {
  const normalized = normalizeVirtualPath(value);
  if (!normalized) return null;

  if (normalized.parts.length === 0) {
    return {
      root: null,
      rel: '',
      vpath: '',
      abs: null,
      real: null,
      stat: null,
      isDir: true,
      missing: false,
    };
  }

  const root = rootByName(normalized.parts[0]);
  if (!root) return null;

  const rel = normalized.parts.slice(1).join('/');
  const abs = path.resolve(root.path, rel.split('/').join(path.sep));
  if (!inside(root.path, abs)) return null;

  let real;
  let stat;
  try {
    real = fs.realpathSync(abs);
    if (!inside(root.path, real)) return null;
    stat = fs.statSync(real);
  } catch {
    if (!allowMissing) return null;
    return {
      root,
      rel,
      vpath: [root.name, rel].filter(Boolean).join('/'),
      abs,
      real: null,
      stat: null,
      isDir: false,
      missing: true,
    };
  }

  return {
    root,
    rel,
    vpath: [root.name, rel].filter(Boolean).join('/'),
    abs: real,
    real,
    stat,
    isDir: stat.isDirectory(),
    missing: false,
  };
}

export function virtualFromAbsolute(absolutePath) {
  const resolved = path.resolve(absolutePath);
  let best = null;

  for (const root of config.enabledRoots) {
    if (!inside(root.path, resolved)) continue;
    if (!best || root.path.length > best.root.path.length) {
      best = { root, rel: path.relative(root.path, resolved) };
    }
  }

  if (!best) return null;
  const rel = best.rel.split(path.sep).join('/');
  return [best.root.name, rel].filter(Boolean).join('/');
}

export async function listDirectory(vpath) {
  const entry = resolveVirtual(vpath);
  if (!entry || !entry.isDir) return null;

  const dirents = await fsp.readdir(entry.abs, { withFileTypes: true });
  const visible = dirents
    .filter((dirent) => !isExcludedName(dirent.name))
    .slice(0, 5000);

  const items = await Promise.all(
    visible.map(async (dirent) => {
      if (dirent.isSymbolicLink()) return null;

      const abs = path.join(entry.abs, dirent.name);
      let stat;
      try {
        stat = await fsp.stat(abs);
      } catch {
        return null;
      }

      const isDir = stat.isDirectory();
      const relative = [entry.rel, dirent.name].filter(Boolean).join('/');
      return {
        name: dirent.name,
        isDir,
        size: stat.size,
        mtime: stat.mtime,
        kind: kindOf(dirent.name, isDir),
        vpath: [entry.root.name, relative].filter(Boolean).join('/'),
      };
    })
  );

  return {
    entry,
    items: items
      .filter(Boolean)
      .sort((left, right) => {
        if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
        return left.name.localeCompare(right.name, 'zh-CN', {
          numeric: true,
          sensitivity: 'base',
        });
      }),
  };
}

export async function rootSummary() {
  return Promise.all(
    config.enabledRoots.map(async (root) => {
      let names = [];
      try {
        const entries = await fsp.readdir(root.path, { withFileTypes: true });
        names = entries
          .filter((entry) => !isExcludedName(entry.name))
          .map((entry) => ({
            name: entry.name,
            isDir: entry.isDirectory(),
          }))
          .sort((left, right) => {
            if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
            return left.name.localeCompare(right.name, 'zh-CN', {
              numeric: true,
              sensitivity: 'base',
            });
          });
      } catch {
        names = [];
      }

      return {
        name: root.name,
        description: root.description,
        itemCount: names.length,
        preview: names.slice(0, 6),
        dirCount: names.filter((item) => item.isDir).length,
        fileCount: names.filter((item) => !item.isDir).length,
      };
    })
  );
}

export function shareBase(token) {
  return `/s/${encodeURIComponent(token)}`;
}

// 短链接：/s/<token>/<8位id>，id 由 lib/links.js 分配并持久化。
export function shortHref(token, vpath) {
  return `${shareBase(token)}/${idFor(vpath)}`;
}

export function browseHref(token, vpath = '') {
  return vpath ? shortHref(token, vpath) : `${shareBase(token)}/`;
}

export function viewHref(token, vpath) {
  return shortHref(token, vpath);
}

export function rawHref(token, vpath) {
  return `${shareBase(token)}/r/${idFor(vpath)}`;
}

export function downloadHref(token, vpath) {
  return `${shareBase(token)}/d/${idFor(vpath)}`;
}
