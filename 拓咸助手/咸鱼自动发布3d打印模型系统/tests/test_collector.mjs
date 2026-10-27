/**
 * 采集扩展 content.js 的纯逻辑回归测试（不需要浏览器）。
 * 运行：node tests/test_collector.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..', '..');
const systemDir = path.resolve(here, '..');
const candidates = [
  path.join(projectRoot, '3D模型一键采集扩展', 'content.js'),
  path.join(systemDir, '采集扩展', 'content.js'),
];
const collectorFile = candidates.find((file) => fs.existsSync(file)) || candidates[0];

if (!fs.existsSync(collectorFile)) {
  console.log(`跳过：找不到 ${collectorFile}`);
  process.exit(0);
}

function makeElement(attrs = {}) {
  const element = {
    style: {},
    dataset: {},
    className: '',
    id: '',
    textContent: '',
    innerText: '',
    innerHTML: '',
    content: '',
    children: [],
    childNodes: [],
    value: '',
    currentSrc: '',
    tagName: 'DIV',
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    getBoundingClientRect: () => ({ width: 10, height: 10, top: 0, left: 0 }),
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    setAttribute() {},
    addEventListener() {},
    appendChild(child) { element.children.push(child); return child; },
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    dispatchEvent: () => true,
    focus() {},
    blur() {},
    scrollIntoView() {},
    click() {},
    ...attrs.extra,
  };
  return element;
}

function makeDocument(overrides = {}) {
  const document = {
    title: '链锯人电次：释放终极链锯人Q版 - 免费 3D 打印模型 - MakerWorld',
    body: { innerText: '耗材 PLA 730 g，打印 143.9 h', appendChild() {} },
    documentElement: { outerHTML: '', appendChild() {} },
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => makeElement(),
    ...overrides,
  };
  return document;
}

function loadCollector(documentOverrides = {}, locationOverrides = {}) {
  const code = fs.readFileSync(collectorFile, 'utf8');
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    Map,
    Set,
    Math,
    Date,
    JSON,
    RegExp,
    String,
    Number,
    Array,
    Object,
    Promise,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    Event: class Event { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    MouseEvent: class MouseEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    InputEvent: class InputEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    getComputedStyle: () => ({ backgroundImage: '', display: 'block', visibility: 'visible', opacity: '1', position: 'static', zIndex: '0' }),
    performance: { getEntriesByType: () => [] },
    location: {
      href: 'https://makerworld.com.cn/zh/models/2479285-abc',
      hostname: 'makerworld.com.cn',
      pathname: '/zh/models/2479285-abc',
      hash: '',
      ...locationOverrides,
    },
    document: makeDocument(documentOverrides),
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: async () => ({ ok: true, jsonOk: true, imageOk: 2, imageTotal: 2, screenshotOk: true, errors: [] }),
      },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: collectorFile });
  return sandbox;
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  OK   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  OK   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}

console.log('采集扩展 content.js');
const sandbox = loadCollector();
const api = sandbox.__mwTest;
assert(api, 'content.js 应暴露 __mwTest 调试入口');

test('标题去掉 MakerWorld 后缀', () => {
  assert.equal(
    api.cleanTitle('链锯人电次：释放终极链锯人Q版 - 免费 3D 打印模型 - MakerWorld'),
    '链锯人电次：释放终极链锯人Q版',
  );
  assert.equal(api.cleanTitle('无职转生Q版挂件 - MakerWorld'), '无职转生Q版挂件');
});

test('HTML 实体解码', () => {
  assert.equal(api.decodeEntities('AMS &amp; 单色版 &#39;' + 'x&#39;'), "AMS & 单色版 'x'");
  assert.equal(api.decodeEntities('&#x1F9B8;'), '🦸');
});

test('打印时长不再把跨行数字识别成时长', () => {
  const polluted = [
    '1 m 143.9 h 0.2m 7.7 h 3.5 h 3M',
    '494293576\nh',
    '703h',
    '801\nm',
    '1\nh',
    '2479285\nh',
    '322412019\nh',
  ].join(' ');
  const times = Array.from(api.extractTimes(polluted));
  assert.deepEqual(times, ['143.9 h', '7.7 h', '3.5 h']);
});

test('带分钟的时长归一化', () => {
  assert.deepEqual(Array.from(api.extractTimes('4.5 h')), ['4.5 h']);
  assert.deepEqual(Array.from(api.extractTimes('2 小时 30 分')), ['2 h 30 min']);
});

test('耗材克数只取合理范围', () => {
  assert.deepEqual(Array.from(api.extractGrams('PLA｜730 g\n189 g\n0.16mm\n43g\n99999 g')), ['730 g', '189 g', '43 g']);
});

test('同一设计图的不同分辨率共用 key，且高清优先', () => {
  const base = 'https://makerworld.bblmw.cn/makerworld/model/CNa1de29ad059f9/design/ebda2a779a82de10.png';
  const high = `${base}?x-oss-process=image/resize,w_1200/ignore-error,1`;
  const low = `${base}?x-oss-process=image%2Fresize%2Cw_400%2Fformat%2Cwebp%2Fignore-error%2C1`;
  assert.equal(api.imageKey(high), api.imageKey(low));
  assert.ok(api.imageScore(high) > api.imageScore(low));
});

test('pickImages 会按设计图去重并优先高清图', () => {
  const base = 'https://makerworld.bblmw.cn/makerworld/model/CNa1de29ad059f9/design';
  const og = `${base}/ebda2a779a82de10.png?x-oss-process=image/resize,w_1200/ignore-error,1`;
  const nodes = [
    makeElement({ src: `${base}/ebda2a779a82de10.png?x-oss-process=image/resize,w_400/format,webp/ignore-error,1` }),
    makeElement({ src: `${base}/6eeff579ddcbf495.png?x-oss-process=image/resize,w_1000/format,webp/ignore-error,1` }),
    makeElement({ src: `${base}/6eeff579ddcbf495.png?x-oss-process=image+resize,w_400/format,webp/ignore-error,1` }),
    makeElement({ src: 'https://public-cdn.bblmw.cn/avatar/abc.jpg' }),
  ];
  const doc = makeDocument({
    querySelector: (selector) => {
      if (selector === 'meta[property="og:image"]') return { content: og };
      return null;
    },
    querySelectorAll: (selector) => (selector === 'img, source, a' ? nodes : []),
  });
  const loaded = loadCollector(doc);
  const images = loaded.__mwTest.pickImages();
  assert.equal(images.length, 2, `应去重成 2 张，实际 ${images.length}`);
  assert.ok(images.includes(og), '第一张应为最高清的 og:image');
  assert.ok(images.every((url) => !url.includes('/avatar/')), '不应包含头像');
});

await asyncTest('Alt+M 双触发只采集一次（冷却/并发保护）', async () => {
  let calls = 0;
  const doc = makeDocument({
    body: { innerText: '', appendChild() {} },
    createElement: () => makeElement(),
  });
  const loaded = loadCollector(doc);
  loaded.chrome.runtime.sendMessage = async () => {
    calls++;
    return { ok: true, jsonOk: true, imageOk: 0, imageTotal: 0, screenshotOk: true, errors: [] };
  };
  await Promise.all([loaded.__mwCollectModel(), loaded.__mwCollectModel()]);
  assert.equal(calls, 1, `同时触发两次应只保存一次，实际 ${calls}`);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  await loaded.__mwCollectModel();
  assert.equal(calls, 2, '冷却结束后应能再次采集');
});

test('srcset 里带逗号的 OSS 参数不会被切断', () => {
  const srcset = 'https://makerworld.bblmw.cn/a.png?x-oss-process=image/resize,w_1200/ignore-error,1 1x, https://makerworld.bblmw.cn/b.png?x-oss-process=image/resize,w_400/ignore-error,1 2x';
  const urls = Array.from(api.srcsetUrls(srcset));
  assert.equal(urls.length, 2, JSON.stringify(urls));
  assert.ok(urls[0].includes('w_1200/ignore-error,1'), urls[0]);
  assert.ok(urls[1].endsWith('w_400/ignore-error,1'), urls[1]);
});

test('兜底图片能识别 JSON 里的 \\/ 转义 URL，并过滤头像', () => {
  const escaped = '<div data-json="https:\\/\\/makerworld.bblmw.cn\\/makerworld\\/model\\/CNabc123456\\/design\\/aaaa.png?x-oss-process=image/resize,w_1200/ignore-error,1"></div>';
  const doc = makeDocument({
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: { outerHTML: escaped + '<img src="https://makerworld.bblmw.cn/avatar/abc.jpg">' },
  });
  const loaded = loadCollector(doc);
  const images = Array.from(loaded.__mwTest.pickImages());
  assert.equal(images.length, 1, JSON.stringify(images));
  assert.ok(images[0].includes('aaaa.png'), images[0]);
  assert.ok(!images[0].includes('avatar'), images[0]);
});

await asyncTest('非 MakerWorld 页面不会采集/截图', async () => {
  let calls = 0;
  const loaded = loadCollector({ createElement: () => makeElement() }, { hostname: 'mail.example.com' });
  loaded.chrome.runtime.sendMessage = async () => { calls++; return {}; };
  await loaded.__mwCollectModel();
  assert.equal(calls, 0, '非 MakerWorld 页面不应发送保存请求');
});

await asyncTest('MakerWorld 非模型页（首页/搜索页）不会采集', async () => {
  let calls = 0;
  const loaded = loadCollector({ createElement: () => makeElement() }, { pathname: '/zh/3d-models', hash: '' });
  loaded.chrome.runtime.sendMessage = async () => { calls++; return {}; };
  await loaded.__mwCollectModel();
  assert.equal(calls, 0, '没有 /models/数字 的页面不应保存');
});

console.log(`\n采集扩展测试通过：${passed} 项`);
