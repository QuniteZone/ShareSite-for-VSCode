import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, '..');

const configPath = process.env.QGZ_SHARE_CONFIG
  ? path.resolve(process.env.QGZ_SHARE_CONFIG)
  : path.join(projectRoot, 'config.json');

function fail(message) {
  throw new Error(`[share-site] ${message}`);
}

function readConfig() {
  if (!fs.existsSync(configPath)) {
    fail(`配置文件不存在：${configPath}`);
  }

  let raw;
  try {
    const text = fs.readFileSync(configPath, 'utf8').replace(/^﻿/, '');
    raw = JSON.parse(text);
  } catch (error) {
    fail(`配置文件不是合法 JSON：${error.message}`);
  }

  const token = String(raw.token || '').trim();
  if (token.length < 24) {
    fail('config.json 的 token 至少需要 24 个字符');
  }

  const configuredRoots = Array.isArray(raw.roots) ? raw.roots : [];
  const roots = [];

  for (const item of configuredRoots) {
    if (!item || typeof item !== 'object') continue;

    const name = String(item.name || '').trim();
    const dir = String(item.path || '').trim();
    if (!name || !dir) continue;

    let realPath;
    try {
      realPath = fs.realpathSync(path.resolve(dir));
      if (!fs.statSync(realPath).isDirectory()) {
        console.warn(`[share-site] 跳过非目录：${dir}`);
        continue;
      }
    } catch {
      console.warn(`[share-site] 跳过不存在的目录：${dir}`);
      continue;
    }

    roots.push({
      name,
      path: realPath,
      enabled: item.enabled !== false,
      description: String(item.description || '').trim(),
    });
  }

  const enabledRoots = roots.filter((root) => root.enabled);
  if (enabledRoots.length === 0) {
    fail('config.json 里没有启用的 roots');
  }

  const exclude = new Set(
    (Array.isArray(raw.exclude) ? raw.exclude : [])
      .map((value) => String(value).trim().toLowerCase())
      .filter(Boolean)
  );

  return {
    host: String(raw.host || '127.0.0.1'),
    port: Number(raw.port || 8010),
    baseUrl: String(raw.baseUrl || '').replace(/\/+$/, ''),
    token,
    siteName: String(raw.siteName || 'QuniteZone 文件阅读'),
    siteDescription: String(raw.siteDescription || '只读文件浏览与 Markdown 阅读'),
    roots,
    enabledRoots,
    exclude,
    maxMarkdownBytes: Number(raw.maxMarkdownBytes || 8 * 1024 * 1024),
    maxTextBytes: Number(raw.maxTextBytes || 2 * 1024 * 1024),
    configPath,
  };
}

export const config = readConfig();
