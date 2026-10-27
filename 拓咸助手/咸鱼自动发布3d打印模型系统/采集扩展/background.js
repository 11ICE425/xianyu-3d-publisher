/* 3D 模型一键采集扩展 · background.js
 * 版本：0.9.0
 * 作用：接收 content.js 采集到的数据，保存 JSON + 当前页面截图 + 最多 10 张图片。
 * 安全：只允许在 MakerWorld 页面采集；非模型页拒绝保存，避免把任意页面截图/正文落盘。
 */
'use strict';

const VERSION = '0.9.0';
const ALLOWED_HOST_RE = /(^|\.)makerworld\.(com|com\.cn|bblmw\.cn)$/i;
const DOWNLOAD_TIMEOUT_MS = 30000; // 单个文件最多等 30 秒
const IMAGE_CONCURRENCY = 3; // 图片下载并发数

function pad2(n) {
  return String(n).padStart(2, '0');
}

function safeName(value) {
  return String(value || 'model')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80) || 'model';
}

function isMakerWorldUrl(url) {
  try {
    return ALLOWED_HOST_RE.test(new URL(url).hostname);
  } catch (e) {
    return false;
  }
}

/** 文件夹名带毫秒和模型 ID，避免两个标签页同一秒采集时混进同一个文件夹。 */
function timestampFolderName(modelId) {
  const d = new Date();
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}-${ms}_${safeName(modelId || 'model').slice(0, 12)}`;
}

function extFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]{3,5})$/);
    const ext = match ? match[1].toLowerCase() : 'jpg';
    if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  } catch (e) { /* 忽略解析失败 */ }
  return 'jpg';
}

function errorText(error) {
  return String((error && error.message) || error || '未知错误');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function notifyUnsupported(tabId, title) {
  try {
    chrome.action.setBadgeText({ tabId, text: '!' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#c44444' });
    chrome.action.setTitle({ tabId, title });
    setTimeout(() => {
      try {
        chrome.action.setBadgeText({ tabId, text: '' });
        chrome.action.setTitle({ tabId, title: '采集当前3D模型' });
      } catch (e) { /* 标签页可能已关闭 */ }
    }, 4000);
  } catch (e) { /* 忽略 UI 提示失败 */ }
}

async function sendCollect(tab) {
  if (!tab || !tab.id) return;
  if (!isMakerWorldUrl(tab.url)) {
    notifyUnsupported(tab.id, '请先打开 MakerWorld 模型详情页再采集');
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'MW_COLLECT' });
  } catch (e) {
    // 页面在扩展更新前打开时，content script 可能还没注入：手动补一次
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'MW_COLLECT' });
    } catch (error) {
      console.warn('采集失败：请刷新 MakerWorld 页面后重试', error);
    }
  }
}

chrome.action.onClicked.addListener(sendCollect);

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'collect-model') return;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  await sendCollect(tabs[0]);
});

/** 等下载真正完成（complete）或失败（interrupted），而不是只等任务被受理。 */
async function waitDownload(id, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let items = [];
    try {
      items = await chrome.downloads.search({ id });
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
    const item = items && items[0];
    if (!item) return { ok: false, error: '下载任务不存在' };
    if (item.state === 'complete') return { ok: true };
    if (item.state === 'interrupted') return { ok: false, error: item.error || '下载中断' };
    await sleep(200);
  }
  return { ok: false, error: '下载超时' };
}

async function downloadAndWait(options, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const id = await chrome.downloads.download(options);
  if (id === undefined) throw new Error('Chrome 未受理下载任务');
  const result = await waitDownload(id, timeoutMs);
  if (!result.ok) throw new Error(result.error);
  return id;
}

/** 限制并发的批量任务（图片下载用，10 张图并行容易把浏览器打满）。 */
async function runLimited(items, limit, worker) {
  let next = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: size }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

let saving = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'MW_SAVE_COLLECTION') return;
  if (saving) {
    sendResponse({ ok: false, jsonOk: false, imageOk: 0, imageTotal: 0, screenshotOk: false, errors: ['上一次保存还没结束'] });
    return;
  }
  saving = true;
  saveCollection(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, jsonOk: false, imageOk: 0, imageTotal: 0, screenshotOk: false, errors: [errorText(error)] }))
    .finally(() => { saving = false; });
  return true;
});

async function saveCollection(message, sender) {
  const modelId = safeName(message.model_id || '');
  // 二次校验：content 已拦住非模型页，这里再防一次（防止旧 content / 其它页面误发）
  if (!modelId || modelId === 'model' || modelId === 'unknown') {
    throw new Error('当前页面不是模型详情页，已取消保存');
  }

  const data = message.data && typeof message.data === 'object' ? { ...message.data } : {};
  const folder = `模型发布信息采集/${timestampFolderName(modelId)}`;
  const imageUrls = Array.isArray(message.images)
    ? [...new Set(message.images.filter((url) => typeof url === 'string' && url))]
    : [];
  const errors = [];
  const result = { jsonOk: false, imageOk: 0, imageTotal: imageUrls.length, screenshotOk: false, folder, errors };

  data.collection_folder = folder;
  data.collection_time_folder = folder.split('/').pop();
  data.image_download_mode = 'bulk_images_plus_screenshot';
  data.collector_version = data.collector_version || VERSION;

  // 先截图：此刻标签页一定还是用户正在看的那个页面
  try {
    const windowId = sender && sender.tab ? sender.tab.windowId : undefined;
    const shot = typeof windowId === 'number'
      ? await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
      : await chrome.tabs.captureVisibleTab({ format: 'png' });
    await downloadAndWait({ url: shot, filename: `${folder}/screenshot_visible.png`, conflictAction: 'uniquify', saveAs: false });
    result.screenshotOk = true;
  } catch (error) {
    errors.push('screenshot: ' + errorText(error));
  }

  // 再存 JSON
  try {
    const json = JSON.stringify(data, null, 2);
    const jsonUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
    await downloadAndWait({ url: jsonUrl, filename: `${folder}/model_${modelId}.json`, conflictAction: 'uniquify', saveAs: false });
    result.jsonOk = true;
  } catch (error) {
    errors.push('json: ' + errorText(error));
  }

  // 最后下载图片（并发 3，每张等真正 complete 再计数）
  await runLimited(imageUrls, IMAGE_CONCURRENCY, async (url, index) => {
    const filename = `${folder}/images/image_${String(index + 1).padStart(2, '0')}.${extFromUrl(url)}`;
    try {
      await downloadAndWait({ url, filename, conflictAction: 'uniquify', saveAs: false });
      result.imageOk++;
    } catch (error) {
      errors.push(`image_${index + 1}: ${errorText(error)}`);
    }
  });

  return result;
}
