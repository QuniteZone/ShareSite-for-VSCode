const vscode = require('vscode');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// 配置查找顺序：设置项 → 环境变量 → ~/.qgz-share/config.json → 旧版写死路径
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.qgz-share', 'config.json');
const LEGACY_CONFIG_PATH = 'D:\\software\\qgz_code-server\\share-site\\config.json';
const API_TIMEOUT_MS = 1200;

function settings() {
  return vscode.workspace.getConfiguration('qgzShare');
}

function configPath() {
  const configured = String(settings().get('configPath') || '').trim();
  if (configured) {
    return configured;
  }
  const fromEnv = String(process.env.QGZ_SHARE_CONFIG || '').trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
    return DEFAULT_CONFIG_PATH;
  }
  return LEGACY_CONFIG_PATH;
}

function realPath(target) {
  try {
    return fs.realpathSync(target);
  } catch (_) {
    return path.resolve(target);
  }
}

function readShareConfig() {
  const file = configPath();
  let raw;
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `读取分享配置失败：${file}（${error.message}）。` +
        '请在设置 qgzShare.configPath 里指向 config.json，或设置环境变量 QGZ_SHARE_CONFIG。'
    );
  }

  const token = String(raw.token || '').trim();
  if (token.length < 24) {
    throw new Error('分享配置里的 token 无效，请检查 config.json');
  }

  const port = Number(raw.port) > 0 ? Number(raw.port) : 8010;

  const baseUrl = String(
    settings().get('baseUrl') || raw.baseUrl || `http://127.0.0.1:${port}`
  )
    .trim()
    .replace(/\/+$/, '');

  const roots = (Array.isArray(raw.roots) ? raw.roots : [])
    .filter((item) => item && typeof item === 'object' && item.path)
    .map((item) => ({
      name: String(item.name || path.basename(String(item.path))),
      path: realPath(String(item.path)),
      enabled: item.enabled !== false,
    }));

  if (roots.length === 0) {
    throw new Error('分享配置里没有可用的目录（roots）');
  }

  return { file, token, baseUrl, port, roots };
}

function normalizeFs(target) {
  const normalized = path.normalize(path.resolve(target)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function uriToFsPath(uri) {
  if (uri.scheme === 'file') {
    return uri.fsPath;
  }
  let value = uri.path || '';
  try {
    value = decodeURIComponent(value);
  } catch (_) {
    // keep raw path
  }
  if (/^\/[A-Za-z]:/.test(value)) {
    value = value.slice(1);
  }
  return value.replace(/\//g, path.sep);
}

function relativeToRoot(rootPath, targetPath) {
  const root = normalizeFs(rootPath);
  const target = normalizeFs(targetPath);
  if (target === root) {
    return '';
  }
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!target.startsWith(prefix)) {
    return null;
  }
  return target.slice(prefix.length).split(path.sep).join('/');
}

function locate(fsPath, config) {
  const resolved = realPath(fsPath);
  for (const root of config.roots) {
    const rel = relativeToRoot(root.path, resolved);
    if (rel !== null) {
      return { root, vpath: rel };
    }
  }
  return null;
}

function shortLinksEnabled() {
  return settings().get('shortLinks') !== false;
}

/**
 * 本机 share-site 上的 /api/link 把「根目录/相对路径」换成 8 位 id。
 * 服务没起、超时、返回异常时静默失败，调用方回退到带路径的长链接。
 */
function fetchShortId(config, vpath) {
  if (!vpath) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let request;
    try {
      const url =
        `http://127.0.0.1:${config.port}/api/link` +
        `?vpath=${encodeURIComponent(vpath)}&token=${encodeURIComponent(config.token)}`;

      request = http.get(url, { timeout: API_TIMEOUT_MS }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          return done(null);
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > 4096) {
            request.destroy();
            done(null);
          }
        });
        response.on('end', () => {
          try {
            const payload = JSON.parse(body);
            done(payload && typeof payload.id === 'string' && payload.id ? payload : null);
          } catch (_) {
            done(null);
          }
        });
        response.on('error', () => done(null));
      });
    } catch (_) {
      return done(null);
    }

    request.on('timeout', () => {
      request.destroy();
      done(null);
    });
    request.on('error', () => done(null));
  });
}

function shareBase(config) {
  return `${config.baseUrl}/s/${encodeURIComponent(config.token)}`;
}

function browseUrl(config, vpath) {
  if (!vpath) {
    return homeUrl(config);
  }
  return `${shareBase(config)}/browse?p=${encodeURIComponent(vpath)}`;
}

function viewUrl(config, vpath) {
  return `${shareBase(config)}/view?p=${encodeURIComponent(vpath)}`;
}

function homeUrl(config) {
  return `${shareBase(config)}/`;
}

function isDirectory(fsPath) {
  try {
    return fs.statSync(fsPath).isDirectory();
  } catch (_) {
    return false;
  }
}

function isUsableUri(candidate) {
  return Boolean(candidate && candidate.scheme && candidate.scheme !== 'untitled');
}

/**
 * 自定义编辑器（例如 MD Editor Plus 的 webview）下 activeTextEditor 是 undefined，
 * 这时从活动标签页的 input 里取 URI 才能定位到当前文件。
 */
function uriFromActiveTab() {
  try {
    const groups = vscode.window.tabGroups;
    const tab = groups && groups.activeTabGroup && groups.activeTabGroup.activeTab;
    const input = tab && tab.input;
    if (!input) {
      return undefined;
    }
    const candidates = [input.uri, input.modified, input.original];
    for (const candidate of candidates) {
      if (isUsableUri(candidate)) {
        return candidate;
      }
    }
  } catch (_) {
    // tab API 不可用时安静降级
  }
  return undefined;
}

function pickTargetUri(uri) {
  if (isUsableUri(uri)) {
    return uri;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && isUsableUri(editor.document.uri)) {
    return editor.document.uri;
  }
  return uriFromActiveTab();
}

async function buildLink(uri, mode) {
  const config = readShareConfig();
  const target = pickTargetUri(uri);

  if (!target) {
    vscode.window.showWarningMessage(
      '请先在编辑器里打开一个文件，或在资源管理器中右键选择一个文件/文件夹。'
    );
    return undefined;
  }

  const fsPath = uriToFsPath(target);
  const located = locate(fsPath, config);

  if (!located) {
    const names = config.roots.filter((root) => root.enabled).map((root) => root.name).join('、');
    vscode.window.showWarningMessage(`这个位置不在分享目录内，无法生成阅读链接。当前分享目录：${names}`);
    return undefined;
  }

  if (!located.root.enabled) {
    vscode.window.showWarningMessage(
      `「${located.root.name}」在分享配置里未启用，请先把 config.json 中该目录的 enabled 改为 true。`
    );
    return undefined;
  }

  const directory = mode === 'folder' ? true : isDirectory(fsPath);
  if (!located.vpath) {
    return { url: homeUrl(config), label: '目录浏览链接' };
  }

  if (shortLinksEnabled()) {
    // /api/link 的 vpath 以根目录名开头（和页面里的内部链接一致），这里补上根名。
    const short = await fetchShortId(config, `${located.root.name}/${located.vpath}`);
    if (short && short.id) {
      return {
        url: `${shareBase(config)}/${short.id}`,
        label: directory ? '目录浏览链接' : '阅读链接',
      };
    }
  }

  return directory
    ? { url: browseUrl(config, located.vpath), label: '目录浏览链接' }
    : { url: viewUrl(config, located.vpath), label: '阅读链接' };
}

async function copyLink(uri, mode) {
  let link;
  try {
    link = await buildLink(uri, mode);
  } catch (error) {
    vscode.window.showErrorMessage(String(error && error.message ? error.message : error));
    return;
  }
  if (!link) {
    return;
  }

  try {
    await vscode.env.clipboard.writeText(link.url);
    vscode.window.showInformationMessage(`${link.label}已复制到剪贴板。`);
  } catch (error) {
    vscode.window.showErrorMessage(`复制失败：${error}`);
    const doc = await vscode.workspace.openTextDocument({ content: link.url, language: 'text' });
    await vscode.window.showTextDocument(doc, { preview: true });
  }
}

async function openInBrowser(uri) {
  let link;
  try {
    link = await buildLink(uri, 'file');
  } catch (error) {
    vscode.window.showErrorMessage(String(error && error.message ? error.message : error));
    return;
  }
  if (!link) {
    return;
  }

  const opened = await vscode.env.openExternal(vscode.Uri.parse(link.url, true));
  if (opened === false) {
    await vscode.env.clipboard.writeText(link.url);
    vscode.window.showWarningMessage('浏览器没有打开，链接已复制到剪贴板。');
  }
}

async function copyFolderLink(uri) {
  const target = pickTargetUri(uri);
  if (!target) {
    return copyLink(uri, 'folder');
  }
  const fsPath = uriToFsPath(target);
  const parent = isDirectory(fsPath) ? fsPath : path.dirname(fsPath);
  return copyLink(vscode.Uri.file(parent), 'folder');
}

async function copyHomeLink() {
  try {
    const config = readShareConfig();
    await vscode.env.clipboard.writeText(homeUrl(config));
    vscode.window.showInformationMessage('阅读站点首页链接已复制到剪贴板。');
  } catch (error) {
    vscode.window.showErrorMessage(String(error && error.message ? error.message : error));
  }
}

function activate(context) {
  const register = (id, handler) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  register('qgzShare.openReader', (uri) => openInBrowser(uri));
  register('qgzShare.copyReaderLink', (uri) => copyLink(uri, 'file'));
  register('qgzShare.copyFolderLink', (uri) => copyFolderLink(uri));
  register('qgzShare.copyHomeLink', () => copyHomeLink());
}

function deactivate() {}

module.exports = { activate, deactivate };
