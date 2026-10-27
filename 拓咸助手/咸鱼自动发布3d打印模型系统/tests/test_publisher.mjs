/**
 * 闲鱼发布助手 content.js 的回归测试（不需要浏览器）。
 * 重点验证：草稿清洗、扫描表单不再因变量遮蔽崩溃。
 * 运行：node tests/test_publisher.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..', '..');
const systemDir = path.resolve(here, '..');
const publisherFile = path.join(systemDir, '闲鱼发布助手', 'content.js');

if (!fs.existsSync(publisherFile)) {
  console.log(`跳过：找不到 ${publisherFile}`);
  process.exit(0);
}

function makeElement(extra = {}) {
  const element = {
    style: {},
    dataset: {},
    className: '',
    id: '',
    textContent: '',
    innerText: '',
    innerHTML: '',
    value: '',
    type: 'text',
    files: null,
    checked: false,
    disabled: false,
    isContentEditable: false,
    tagName: 'INPUT',
    children: [],
    childNodes: [],
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    getBoundingClientRect: () => ({ width: 100, height: 20, top: 0, left: 0 }),
    getAttribute: () => null,
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
    ...extra,
  };
  return element;
}

function loadPublisher() {
  const panel = makeElement({ id: 'xy3d-panel' });
  const elements = new Map();
  const code = fs.readFileSync(publisherFile, 'utf8');
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
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
    DataTransfer: class DataTransfer { constructor() { this.items = { add() {} }; this.files = []; } },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    location: { href: 'https://www.goofish.com/publish', hostname: 'www.goofish.com' },
    document: {
      title: '闲鱼',
      body: { appendChild() {} },
      addEventListener() {},
      getElementById: (id) => (id === 'xy3d-panel' ? panel : null),
      // 同一个选择器复用同一个元素，方便断言 textContent/className 的变化
      querySelector: (selector) => {
        if (!elements.has(selector)) elements.set(selector, makeElement());
        return elements.get(selector);
      },
      querySelectorAll: () => [],
      createElement: () => makeElement(),
      _elements: elements,
    },
    chrome: {
      runtime: {
        getManifest: () => ({ version: '0.8.0' }),
        onMessage: { addListener() {} },
        sendMessage: async () => ({ ok: true }),
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: publisherFile });
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

console.log('闲鱼发布助手 content.js');
const sandbox = loadPublisher();
const api = sandbox.__xyTest;
assert(api, 'content.js 应暴露 __xyTest 调试入口');

test('版本号来自 manifest', () => {
  assert.equal(api.version, '0.8.0');
});

test('MakerWorld 标题后缀会被清洗', () => {
  assert.equal(
    api.cleanTitleText('链锯人电次：释放终极链锯人Q版 - 免费 3D 打印模型 - MakerWorld'),
    '链锯人电次：释放终极链锯人Q版',
  );
});

test('描述去掉下载前缀、助力段和 HTML 实体', () => {
  const raw = '免费下载由 Dario 设计的 3D 打印模型文件。🩸 Q版链锯人 &amp; 单色版。为我助力 支持我的作品！';
  const cleaned = api.cleanDescriptionText(raw);
  assert.ok(cleaned.startsWith('🩸 Q版链锯人 & 单色版'), cleaned);
  assert.ok(!cleaned.includes('为我助力'), cleaned);
  assert.ok(!cleaned.includes('&amp;'), cleaned);
});

const fixturesDir = path.join(here, 'fixtures');
const collectorSample = fs.existsSync(path.join(projectRoot, '3D模型一键采集扩展', '信息储存'))
  ? path.join(projectRoot, '3D模型一键采集扩展', '信息储存', '2026-08-01_23-35-04', 'model_2479285.json')
  : path.join(fixturesDir, 'sample_model.json');
const expectFixture = !collectorSample.includes(path.join('3D模型一键采集扩展'));
test('读取采集 JSON：标题/描述/价格字段都能映射', () => {
  if (!fs.existsSync(collectorSample)) {
    console.log('    （跳过：没有采集样例）');
    return;
  }
  const draft = api.normalizeDraft(JSON.parse(fs.readFileSync(collectorSample, 'utf8')));
  assert.equal(draft.title, expectFixture ? '示例机甲摆件' : '链锯人电次：释放终极链锯人Q版');
  assert.ok(!draft.desc.includes('&amp;'), '描述不应残留 HTML 实体');
  assert.ok(!draft.title.includes('MakerWorld'), '标题不应包含 MakerWorld');
  assert.equal(draft.price, '');
});

const extractedSample = path.join(systemDir, 'data', 'processed', 'makerworld-model-2430111_1.extracted.json');
test('读取提取结果 JSON：优先使用 xianyu_title_safe / xianyu_copy_safe', () => {
  if (!fs.existsSync(extractedSample)) {
    console.log('    （跳过：没有提取样例）');
    return;
  }
  const draft = api.normalizeDraft(JSON.parse(fs.readFileSync(extractedSample, 'utf8')));
  assert.equal(draft.title, '科幻重型机甲灰模 3D打印桌面摆件 涂装练习模型');
  assert.ok(draft.desc.includes('3D 打印模型'));
  assert.ok(Array.from(draft.manual).length >= 1, '应带出待人工确认字段');
});

test('扫描表单不再崩溃（旧版 const scan = scan() 会抛 ReferenceError）', () => {
  const items = api.scanForm();
  assert.equal(Array.from(items).length, 17);
});

test('原生 select 可直接选中目标文案', () => {
  let events = 0;
  const select = makeElement({
    tagName: 'SELECT',
    value: '',
    options: [
      { textContent: '全新', value: 'new' },
      { textContent: '几乎全新', value: 'almost-new' },
    ],
    dispatchEvent() { events++; return true; },
  });
  const ok = api.selectNativeOption(select, '几乎全新');
  assert.equal(ok, true);
  assert.equal(select.value, 'almost-new');
  assert.equal(events, 2, '应派发 input + change 事件');
  assert.equal(api.selectNativeOption(select, '不存在'), false);
});

test('扫描上下文可缓存，重复扫描不报错', () => {
  const first = api.scan();
  const second = api.scan();
  assert.equal(Array.from(first).length, Array.from(second).length);
});

test('超长标题自动截断到 30 字', () => {
  const draft = api.normalizeDraft({ title: '很长很长的模型标题'.repeat(6) });
  assert.equal(Array.from(draft.title).length, 30);
});

test('manual 为空数组时清除旧的“待人工确认”', () => {
  api.setDraft({ title: 't', desc: 'd', price: '1', manual: ['耗材克数'] });
  const riskText = sandbox.document.querySelector('#xy3d-panel [data-r="riskText"]');
  assert.ok(riskText.textContent.includes('待人工确认'), riskText.textContent);
  api.setDraft({ title: 't', desc: 'd', price: '1', manual: [] });
  assert.equal(riskText.textContent, '');
});

test('text 字段不会误选 select（控件按 kind 排序）', () => {
  const input = makeElement({ tagName: 'INPUT', type: 'text' });
  const select = makeElement({ tagName: 'SELECT' });
  const container = {
    querySelectorAll: (selector) => {
      if (selector === 'select') return [select];
      if (selector === 'input[type=text]') return [input];
      return [];
    },
  };
  assert.equal(api.controlIn(container, 'text', null), input);
  assert.equal(api.controlIn(container, 'select', null), select);
});

test('闲鱼域名识别', () => {
  assert.equal(api.isXianyuHost(), true);
});

console.log(`\n发布助手测试通过：${passed} 项`);
