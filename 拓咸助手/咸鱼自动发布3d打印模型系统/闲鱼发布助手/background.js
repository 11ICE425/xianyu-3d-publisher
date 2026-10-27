/* 闲鱼 3D 模型发布助手 · background.js
 * 版本：0.8.0
 * 作用：注入面板、转发 AI 请求（本地服务优先，失败可回落直连）、检测本地服务。
 */
'use strict';

const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-flash';
const LOCAL_URL = 'http://127.0.0.1:8765/polish';
const REQUEST_TIMEOUT_MS = 60000;
// 本地服务每次最多等 DeepSeek 30 秒、最多重试一次（约 60 秒），客户端要比它久，
// 避免「服务端还在跑、客户端先超时又去直连」花两份钱
const LOCAL_TIMEOUT_MS = 75000;
// 本地服务要求的客户端标识，普通网页无法在不触发预检的情况下伪造这个请求头
const LOCAL_CLIENT_HEADER = 'X-XY-Client';
const LOCAL_CLIENT_VALUE = 'xy3d-publisher';
const XIANYU_HOST_RE = /(^|\.)(goofish\.com|xianyu\.com)$/i;

function isXianyuUrl(url) {
  try {
    return XIANYU_HOST_RE.test(new URL(url).hostname);
  } catch (e) {
    return false;
  }
}

function notifyUnsupported(tabId) {
  try {
    chrome.action.setBadgeText({ tabId, text: '!' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#c44444' });
    chrome.action.setTitle({ tabId, title: '请先打开闲鱼发布页再使用' });
    setTimeout(() => {
      try {
        chrome.action.setBadgeText({ tabId, text: '' });
        chrome.action.setTitle({ tabId, title: '闲鱼3D发布助手' });
      } catch (e) { /* 标签页可能已关闭 */ }
    }, 4000);
  } catch (e) { /* 忽略 UI 提示失败 */ }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  if (!isXianyuUrl(tab.url)) {
    notifyUnsupported(tab.id);
    return;
  }
  try {
    // 不依赖旧标签页中可能残留的 content.js：每次点击先执行磁盘上的最新版。
    try {
      await chrome.scripting.removeCSS({ target: { tabId: tab.id }, files: ['panel.css'] });
    } catch (e) { /* 没注入过就忽略 */ }
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['panel.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'XY7_TOGGLE' });
  } catch (error) {
    console.warn('Xianyu publisher injection/toggle failed', error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'XY_AI_REQUEST' || message?.type === 'XY7_AI') {
    handleAi(message.payload)
      .then((out) => sendResponse({ ok: true, ...out }))
      .catch((err) => sendResponse({ ok: false, error: friendly(err) }));
    return true;
  }
  if (message?.type === 'XY_CHECK_LOCAL' || message?.type === 'XY7_HEALTH') {
    health(message.localUrl)
      .then((out) => sendResponse({ ok: true, result: out }))
      .catch((err) => sendResponse({ ok: false, error: friendly(err) }));
    return true;
  }
});

async function handleAi(payload = {}) {
  const config = payload.config || {};
  const draft = cleanDraft(payload.draft || {});
  const mode = ['smart', 'local', 'direct'].includes(config.mode) ? config.mode : 'smart';
  const key = String(config.apiKey || '').trim();
  const url = localUrl(config.localUrl || LOCAL_URL);
  if (!draft.title && !draft.description) throw Error('草稿内容为空');

  if (mode === 'local') {
    // 本地服务端可能配置了 DEEPSEEK_API_KEY 环境变量，没填 Key 也让请求过去
    return { result: await callLocal(url, key, draft), via: 'local' };
  }
  if (mode === 'direct') {
    if (!key) throw Error('请先填写 DeepSeek API Key');
    return { result: await callDeepSeek(key, draft), via: 'direct' };
  }

  // 智能模式：先本地，只有“本地服务连不上”才回落直连，避免同一个错误请求被收费两次
  try {
    return { result: await callLocal(url, key, draft), via: 'local' };
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    if (!key) throw Error('本地服务未启动，且没有填写 DeepSeek API Key');
    return { result: await callDeepSeek(key, draft), via: 'direct-fallback' };
  }
}

async function health(value) {
  const response = await fetchTimeout(localUrl(value).replace(/\/polish\/?$/i, '/health'), { method: 'GET' }, 3000);
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  return json(response);
}

async function callLocal(url, key, draft) {
  const response = await fetchTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [LOCAL_CLIENT_HEADER]: LOCAL_CLIENT_VALUE },
    body: JSON.stringify({ apiKey: key, model: MODEL, draft }),
  }, LOCAL_TIMEOUT_MS);
  const data = await json(response);
  if (!response.ok || data?.ok === false) throw Error(data?.error || `HTTP ${response.status}`);
  return normalizeResult(data, draft);
}

async function callDeepSeek(key, draft) {
  let lastError = null;
  // DeepSeek 的 JSON 模式偶尔会返回空内容，这里重试一次
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetchTimeout(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt(draft.customRules) },
          { role: 'user', content: userPrompt(draft) },
        ],
        stream: false,
        temperature: 0.55,
        max_tokens: 1600,
        response_format: { type: 'json_object' },
        // 文案任务不需要长时间思考：关掉思考模式，温度和速度才生效
        thinking: { type: 'disabled' },
      }),
    });
    const data = await json(response);
    if (!response.ok) throw Error(data?.error?.message || data?.message || `HTTP ${response.status}`);
    const content = data?.choices?.[0]?.message?.content;
    if (!content) { lastError = Error('DeepSeek 没有返回文案'); continue; }
    try {
      return parseResult(content, draft);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || Error('AI 返回格式异常，请重试');
}

function systemPrompt(editableRules = '') {
  const fixed = [
    '你是闲鱼3D打印商品文案编辑器。',
    '只处理用户提供的资料，不虚构材质、尺寸、库存、授权、发货时间或功能。',
    '只输出一个JSON对象，不要Markdown或解释；字段固定为title、description、price、risk_notes。',
    '示例输出：{"title":"模型名 3D打印桌面摆件","description":"自然口语的宝贝描述","price":"88","risk_notes":"需要人工确认的要点"}',
    '不得引导绕过平台审核、规则或验证。',
  ].join('\n');
  const rules = String(editableRules || '').trim();
  if (!rules) return fixed;
  return `${fixed}\n\n以下是用户在插件中编辑的文案规则，请在不虚构事实的前提下遵守：\n${rules}`;
}

function userPrompt(draft) {
  const raw = draft.raw || {};
  const get = (keys) => first(raw, keys);
  const compact = {
    '当前标题': draft.title,
    '当前描述': draft.description,
    '当前价格': draft.price,
    '文案风格': draft.tone || '自然简洁',
    '模型名称': get(['model_title', 'safe_title', 'title', 'name']),
    '作者': get(['author', 'creator', 'designer']),
    '耗材克数': get(['filament_grams', 'filament_g', 'grams', 'material_g', 'weight_g']),
    '打印时间': get(['print_time', 'printing_time', 'time']),
    '分类标签': get(['tags', 'category', 'categories']),
    '来源链接': get(['source_url', 'url', 'model_url']),
    '已知风险提示': get(['risk_notes', 'risk_words']),
    '命名授权规则': '卖家已确认原始模型/IP/系列/作者名称可保留使用。',
    '用户补充规则': String(draft.customRules || '').trim(),
  };
  return `请根据以下资料润色闲鱼文案。没有的信息不要补造。\n${JSON.stringify(compact, null, 2)}`;
}

function cleanDraft(draft) {
  return {
    title: String(draft.title || '').trim(),
    description: String(draft.description || '').trim(),
    price: price(draft.price),
    tone: String(draft.tone || '自然简洁'),
    customRules: String(draft.customRules || '').trim(),
    raw: draft.raw && typeof draft.raw === 'object' ? draft.raw : {},
  };
}

function parseResult(content, fallback) {
  let text = String(content || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  try {
    return normalizeResult(JSON.parse(text), fallback);
  } catch (error) {
    throw Error('AI 返回格式异常，请重试');
  }
}

function normalizeResult(value, fallback) {
  const out = value?.result && typeof value.result === 'object' ? value.result : value;
  return {
    title: Array.from(String(out?.title || fallback.title || '').trim()).slice(0, 30).join(''),
    description: String(out?.description || fallback.description || '').trim(),
    price: price(out?.price || fallback.price || ''),
    risk_notes: String(out?.risk_notes || '').trim(),
  };
}

function price(value) {
  const hit = String(value ?? '').replace(/,/g, '').match(/\d+(?:\.\d{1,2})?/);
  return hit ? hit[0] : '';
}

function localUrl(value) {
  const url = String(value || LOCAL_URL).trim().replace(/\/+$/, '');
  return url.endsWith('/polish') ? url : `${url}/polish`;
}

function first(obj, keys) {
  for (const key of keys) {
    if (obj?.[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return '';
}

async function fetchTimeout(url, options, timeout = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw Error('请求超时，请检查网络或服务状态');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function json(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    return { message: text.slice(0, 300) };
  }
}

function isNetworkError(error) {
  const message = String((error && error.message) || error || '');
  return /请求超时|Failed to fetch|NetworkError|ECONNREFUSED|ERR_CONNECTION|ERR_ADDRESS|载入失败/i.test(message);
}

function friendly(err) {
  const msg = String(err?.message || err || '未知错误');
  if (/401|authentication|unauthorized|invalid.*key/i.test(msg)) return 'API Key 无效或没有权限';
  if (/402|balance|insufficient/i.test(msg)) return 'DeepSeek 账户余额不足';
  if (/429|rate.?limit/i.test(msg)) return '请求过于频繁，请稍后再试';
  if (/model.*not.*exist|model_not_found|Model Not Exist/i.test(msg)) return '模型名不可用，请检查 deepseek-flash';
  if (/Failed to fetch|NetworkError/i.test(msg)) return '网络连接失败';
  return msg;
}
