// 用最小 vscode mock 验证 share-link 扩展的链接生成逻辑。
// 运行：node tests/extension.test.cjs
//
// 测试自己建一个临时目录当分享根目录，不依赖本机任何真实文件，
// 所以 clone 下来就能直接跑。
const Module = require('node:module');
const EventEmitter = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const extensionPath = path.resolve(__dirname, '..', '..', 'extension', 'extension.js');

// ── 临时目录与配置 ───────────────────────────────────────────────
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qgz-share-test-'));
const notesDir = path.join(fixtureRoot, 'notes');
const filesDir = path.join(fixtureRoot, 'files');
const archiveDir = path.join(fixtureRoot, 'archive');
for (const dir of [notesDir, filesDir, archiveDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const TOKEN = 'test-token-0123456789abcdef';
const BASE_URL = 'https://share.example.com';
const configPath = path.join(fixtureRoot, 'config.json');
fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      token: TOKEN,
      baseUrl: BASE_URL,
      port: 8010,
      roots: [
        { name: 'notes', path: notesDir, enabled: true },
        { name: 'files', path: filesDir, enabled: true },
        { name: 'archive', path: archiveDir, enabled: false },
      ],
    },
    null,
    2
  ),
  'utf8'
);

const shareBase = `${BASE_URL}/s/${TOKEN}`;
const noteFile = path.join(notesDir, '测试', '示例.md');
const imageFile = path.join(filesDir, 'image_1.png');
const disabledFile = path.join(archiveDir, '某文件.md');
const outsideFile = path.join(fixtureRoot, '无主文件.md');
const noteFolder = path.join(notesDir, '20260803记事情况');
fs.mkdirSync(noteFolder, { recursive: true });

// ── vscode mock ─────────────────────────────────────────────────
const messages = [];
const commands = new Map();

function makeUri(fsPath, scheme = 'file') {
  return {
    scheme,
    fsPath,
    path: scheme === 'file' ? fsPath : '/' + fsPath.replace(/\\/g, '/'),
  };
}

const SHORT_ID = 'AbCd1234';
// 模拟本机 share-site 的 /api/link：'ok' 返回短 id，'fail' 模拟服务没起
const linkApi = { mode: 'ok', requests: [] };
const overrides = {};

function makeHttpMock() {
  return {
    get(url, options, callback) {
      const request = new EventEmitter();
      request.destroy = () => {};
      const vpath = new URL(url).searchParams.get('vpath');
      linkApi.requests.push(vpath);

      if (linkApi.mode === 'fail') {
        process.nextTick(() => request.emit('error', new Error('connect ECONNREFUSED 127.0.0.1')));
        return request;
      }

      const response = new EventEmitter();
      response.statusCode = 200;
      response.setEncoding = () => {};
      response.resume = () => {};
      const payload = JSON.stringify({ id: SHORT_ID, vpath, isDir: false });
      process.nextTick(() => {
        callback(response);
        response.emit('data', payload);
        response.emit('end');
      });
      return request;
    },
  };
}

const vscodeMock = {
  workspace: {
    getConfiguration: () => ({
      get: (key) => {
        if (key in overrides) return overrides[key];
        return key === 'configPath' ? configPath : '';
      },
    }),
  },
  window: {
    activeTextEditor: undefined,
    tabGroups: { activeTabGroup: { activeTab: undefined } },
    showInformationMessage: (msg) => messages.push(['info', msg]),
    showWarningMessage: (msg) => messages.push(['warn', msg]),
    showErrorMessage: (msg) => messages.push(['error', msg]),
    showTextDocument: async () => undefined,
  },
  env: {
    clipboard: { writeText: async () => undefined },
    openExternal: async (uri) => messages.push(['open', uri.toString()]),
  },
  commands: {
    registerCommand: (id, handler) => {
      commands.set(id, handler);
      return { dispose() {} };
    },
  },
  Uri: {
    file: (p) => makeUri(p),
    parse: (value) => ({ scheme: 'https', toString: () => value }),
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  if (request === 'http' || request === 'node:http') return makeHttpMock();
  return originalLoad.call(this, request, parent, isMain);
};

const extension = require(extensionPath);
extension.activate({ subscriptions: [] });

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log(`      期望: ${expected}`);
    console.log(`      实际: ${actual}`);
  }
}

async function run() {
  const copy = commands.get('qgzShare.copyReaderLink');
  const copyFolder = commands.get('qgzShare.copyFolderLink');
  const open = commands.get('qgzShare.openReader');
  const home = commands.get('qgzShare.copyHomeLink');

  check('命令已注册', [copy, copyFolder, open, home].every(Boolean), true);

  let lastCopied = '';
  vscodeMock.env.clipboard.writeText = async (text) => {
    lastCopied = text;
  };

  await copy(makeUri(noteFile));
  check('notes 内的 Markdown 生成短阅读链接', lastCopied, `${shareBase}/${SHORT_ID}`);

  await copy(makeUri(imageFile));
  check('files 内的图片生成短阅读链接', lastCopied, `${shareBase}/${SHORT_ID}`);

  check(
    '短 id 由 /api/link 按 vpath 申请',
    JSON.stringify(linkApi.requests.slice(-2)),
    JSON.stringify(['notes/测试/示例.md', 'files/image_1.png'])
  );

  messages.length = 0;
  await copy(makeUri(disabledFile));
  check('未启用目录给出提示', String((messages[0] && messages[0][1]) || '').includes('未启用'), true);

  messages.length = 0;
  await copy(makeUri(outsideFile));
  check('分享目录外给出提示', String((messages[0] && messages[0][1]) || '').includes('不在分享目录内'), true);

  await copyFolder(makeUri(noteFolder));
  check('文件夹生成短浏览链接', lastCopied, `${shareBase}/${SHORT_ID}`);

  await copyFolder(makeUri(noteFile));
  check('文件所在目录生成短浏览链接', lastCopied, `${shareBase}/${SHORT_ID}`);

  await home();
  check('首页链接', lastCopied, `${shareBase}/`);

  messages.length = 0;
  await open(makeUri(path.join(filesDir, 'a.pdf')));
  check('在浏览器打开短链接', (messages[0] && messages[0][1]) || '', `${shareBase}/${SHORT_ID}`);

  // 自定义编辑器（如 MD Editor Plus）打开时 activeTextEditor 为空，需要从活动标签页取 URI
  vscodeMock.window.tabGroups.activeTabGroup.activeTab = { input: { uri: makeUri(noteFile) } };
  messages.length = 0;
  await open(undefined);
  check('自定义编辑器下仍能在浏览器打开', (messages[0] && messages[0][1]) || '', `${shareBase}/${SHORT_ID}`);

  // 差异编辑器（TabInputTextDiff）取 modified 一侧
  vscodeMock.window.tabGroups.activeTabGroup.activeTab = {
    input: { original: makeUri(path.join(notesDir, '旧.md')), modified: makeUri(noteFile) },
  };
  messages.length = 0;
  await open(undefined);
  check('差异编辑器取修改后一侧', (messages[0] && messages[0][1]) || '', `${shareBase}/${SHORT_ID}`);

  vscodeMock.window.tabGroups.activeTabGroup.activeTab = undefined;

  // 本机 share-site 没起：自动回退成带路径的长链接
  linkApi.mode = 'fail';
  await copy(makeUri(noteFile));
  check(
    '服务不可用时回退长链接',
    lastCopied,
    `${shareBase}/view?p=` + encodeURIComponent('测试/示例.md')
  );
  linkApi.mode = 'ok';

  // 手动关掉短链接
  overrides.shortLinks = false;
  await copy(makeUri(noteFile));
  check(
    '关闭短链接设置后走长链接',
    lastCopied,
    `${shareBase}/view?p=` + encodeURIComponent('测试/示例.md')
  );
  delete overrides.shortLinks;

  const remoteUri = {
    scheme: 'vscode-remote',
    fsPath: noteFile,
    path: '/' + noteFile.replace(/\\/g, '/').replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase()),
  };
  await copy(remoteUri);
  check('vscode-remote 路径可映射', lastCopied, `${shareBase}/${SHORT_ID}`);

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
