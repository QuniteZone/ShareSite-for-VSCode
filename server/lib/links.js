// 短链接表：把 "根目录/相对路径" 映射成 8 位短 id，避免链接里出现一长串中文路径。
// 数据存在 share-site/data/links.json，进程重启后仍然有效。
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './config.js';

const DATA_DIR = path.join(projectRoot, 'data');
const STORE_FILE = path.join(DATA_DIR, 'links.json');
// 去掉了 0/O/1/l/I 这些容易看错的字符
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const ID_LENGTH = 8;
const MAX_ENTRIES = 50000;

const byId = new Map();
const byPath = new Map();

let saveTimer = null;
let saveRunning = false;
let savePending = false;

function load() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[share-site] 读取 links.json 失败：', error.message);
    }
    return;
  }

  const links = raw && typeof raw.links === 'object' && raw.links ? raw.links : {};
  for (const [id, vpath] of Object.entries(links)) {
    if (typeof vpath !== 'string' || !vpath || !id) continue;
    byId.set(id, vpath);
    byPath.set(vpath, id);
  }
}

function randomId() {
  const bytes = crypto.randomBytes(ID_LENGTH);
  let id = '';
  for (let index = 0; index < ID_LENGTH; index += 1) {
    id += ALPHABET[bytes[index] % ALPHABET.length];
  }
  return id;
}

function newId() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = randomId();
    if (!byId.has(id)) return id;
  }
  return crypto.randomBytes(12).toString('base64url').slice(0, 12);
}

function evictIfNeeded() {
  if (byId.size <= MAX_ENTRIES) return;
  // 超出上限时按插入顺序裁掉最老的一批，保留 95%
  const target = Math.floor(MAX_ENTRIES * 0.95);
  let removed = 0;
  for (const [id, vpath] of byId) {
    byId.delete(id);
    byPath.delete(vpath);
    removed += 1;
    if (byId.size <= target) break;
  }
  if (removed) {
    console.log(`[share-site] links.json 超过上限，清理了 ${removed} 条`);
  }
}

async function flush() {
  if (saveRunning) {
    savePending = true;
    return;
  }
  saveRunning = true;
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const payload = JSON.stringify({ version: 1, links: Object.fromEntries(byId) });
    const tmp = `${STORE_FILE}.tmp`;
    await fsp.writeFile(tmp, payload, 'utf8');
    await fsp.rename(tmp, STORE_FILE);
  } catch (error) {
    console.warn('[share-site] 保存 links.json 失败：', error.message);
  } finally {
    saveRunning = false;
    if (savePending) {
      savePending = false;
      scheduleSave();
    }
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flush();
  }, 400);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

export function idFor(vpath) {
  const key = String(vpath || '');
  const existing = byPath.get(key);
  if (existing) return existing;

  const id = newId();
  byId.set(id, key);
  byPath.set(key, id);
  evictIfNeeded();
  scheduleSave();
  return id;
}

export function vpathFor(id) {
  return byId.get(String(id || '')) || null;
}

export function linkCount() {
  return byId.size;
}

load();
