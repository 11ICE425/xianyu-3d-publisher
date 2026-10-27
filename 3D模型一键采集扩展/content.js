/* 3D 模型一键采集扩展 · content.js
 * 版本：0.9.0
 * 作用：在 MakerWorld 模型页采集标题/简介/耗材/打印时长/图片直链/许可信息，
 *      交给 background.js 保存为 JSON + 截图 + 最多 10 张图片。
 * 说明：只读取当前页面已经渲染出来的内容，不调用需要登录的私有接口。
 */
(function () {
  'use strict';

  if (window.__mwCollectorV09) return;
  window.__mwCollectorV09 = true;

  const VERSION = '0.9.0';
  const MAX_IMAGES = 10;
  const COLLECT_COOLDOWN_MS = 1500;

  let collecting = false;
  let lastCollectAt = 0;

  /* ------------------------------------------------------------------ *
   * 基础文本工具
   * ------------------------------------------------------------------ */
  function uniq(items) {
    const seen = new Set();
    const out = [];
    for (const item of items || []) {
      const value = String(item == null ? '' : item).trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
  }

  function cleanText(input) {
    return String(input == null ? '' : input)
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  function decodeEntities(input) {
    return String(input == null ? '' : input)
      .replace(/&#x([0-9a-f]+);/gi, function (match, hex) {
        try { return String.fromCodePoint(parseInt(hex, 16)); } catch (e) { return match; }
      })
      .replace(/&#(\d+);/g, function (match, dec) {
        try { return String.fromCodePoint(parseInt(dec, 10)); } catch (e) { return match; }
      })
      .replace(/&([a-z][a-z0-9]*);/gi, function (match, name) {
        const key = name.toLowerCase();
        return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : match;
      });
  }

  function textOf(selector) {
    const el = document.querySelector(selector);
    if (!el) return '';
    const content = typeof el.content === 'string' ? el.content : '';
    return cleanText(content || el.innerText || el.textContent || '');
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  /** 页面标题清洗：去掉 MakerWorld 的商品后缀、HTML 实体。 */
  function cleanTitle(raw) {
    let title = decodeEntities(cleanText(raw));
    title = title.replace(/\s*[-|｜]\s*(?:免费\s*)?3D\s*打印模型\s*[-|｜]\s*MakerWorld.*$/i, '');
    title = title.replace(/\s*[-|｜]\s*MakerWorld.*$/i, '');
    title = title.replace(/\s*[-|｜]\s*Bambu\s*Lab.*$/i, '');
    return title.trim();
  }

  /** 从大段文本里截取 startWord 到 stopWords 之间的内容。 */
  function sectionBetween(text, startWord, stopWords) {
    const lines = String(text || '').split(/\n+/);
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (cleanText(lines[i]) === startWord) { start = i + 1; break; }
    }
    if (start < 0) return '';
    const out = [];
    for (let i = start; i < lines.length; i++) {
      const line = cleanText(lines[i]);
      if (stopWords.some(function (word) { return line.indexOf(word) === 0; })) break;
      if (line) out.push(line);
    }
    return out.join('\n').trim();
  }

  /* ------------------------------------------------------------------ *
   * 耗材克数 / 打印时长
   * ------------------------------------------------------------------ */
  const GRAM_RE = /(?<![\d./])(\d{1,4}(?:\.\d{1,2})?)[ \t]*(grams?|g|克)(?![a-z0-9])/gi;
  const TIME_RE = /(?<![\d./])(\d{1,4}(?:\.\d{1,2})?)[ \t]*(hrs|hr|h|小时)(?![a-z0-9])/gi;
  const TIME_MIN_RE = /^[ \t]*(\d{1,3})[ \t]*(?:mins?|min|m|分钟|分)(?![a-z0-9])/;

  function formatNumber(value) {
    return String(Math.round(Number(value) * 100) / 100);
  }

  /**
   * 提取耗材克数候选值。
   * 旧版 `\s*` 会跨行匹配，把 URL 里的数字也当成克数，这里改成只允许空格/制表符。
   */
  function extractGrams(text) {
    const source = String(text || '');
    const out = [];
    let match;
    GRAM_RE.lastIndex = 0;
    while ((match = GRAM_RE.exec(source)) !== null) {
      const value = parseFloat(match[1]);
      if (!isFinite(value) || value < 1 || value > 5000) continue;
      out.push(formatNumber(value) + ' g');
    }
    return uniq(out);
  }

  /**
   * 提取打印时长候选值。
   * 只接受 0.2~500 小时，避免把模型 ID、URL 里的数字识别成“xxxx h”。
   */
  function extractTimes(text) {
    const source = String(text || '');
    const out = [];
    let match;
    TIME_RE.lastIndex = 0;
    while ((match = TIME_RE.exec(source)) !== null) {
      const hours = parseFloat(match[1]);
      if (!isFinite(hours) || hours < 0.2 || hours > 500) continue;
      const rest = source.slice(match.index + match[0].length, match.index + match[0].length + 12);
      const minMatch = rest.match(TIME_MIN_RE);
      const label = minMatch
        ? formatNumber(hours) + ' h ' + minMatch[1] + ' min'
        : formatNumber(hours) + ' h';
      out.push(label);
    }
    return uniq(out);
  }

  /* ------------------------------------------------------------------ *
   * 图片链接收集与去重
   * ------------------------------------------------------------------ */
  const IMAGE_EXT_RE = /\.(?:jpe?g|png|webp|gif)$/i;
  const IMAGE_BLOCK_RE = /avatar|logo|favicon|icon|sprite|placeholder|qrcode|creativecommons|static\//i;

  function normalizeUrl(raw) {
    if (!raw) return '';
    const value = String(raw).trim();
    if (!value || /^(data|blob|javascript|chrome-extension):/i.test(value)) return '';
    try {
      const url = new URL(value, location.href);
      if (!/^https?:$/.test(url.protocol)) return '';
      return url.href;
    } catch (e) {
      return '';
    }
  }

  /** 同一张设计图的 w_1200 / w_1000 / w_400 变体共用一个 key。 */
  function imageKey(url) {
    try {
      const parsed = new URL(url);
      return parsed.host + parsed.pathname.replace(/\.[a-z0-9]+$/i, '');
    } catch (e) {
      return String(url);
    }
  }

  /** 同一张图多个分辨率时，优先选宽度最大、非 webp 压缩的版本。 */
  function imageScore(url) {
    try {
      const parsed = new URL(url);
      const query = decodeURIComponent(parsed.search || '');
      let score = 0;
      const width = query.match(/w_(\d{2,5})/);
      if (width) score += Math.min(Number(width[1]), 2400) / 100;
      if (/format,?webp/i.test(query)) score -= 3;
      if (/\.png$/i.test(parsed.pathname)) score += 3;
      else if (/\.jpe?g$/i.test(parsed.pathname)) score += 2;
      else if (/\.webp$/i.test(parsed.pathname)) score += 1;
      return score;
    } catch (e) {
      return 0;
    }
  }

  /**
   * srcset 解析：MakerWorld 图片 URL 的查询参数里本身带逗号
   * （x-oss-process=image/resize,w_1200/...），不能直接按逗号 split。
   * 这里只在“逗号后面紧跟新 URL 起始”时切分。
   */
  function srcsetUrls(srcset) {
    if (!srcset) return [];
    return String(srcset)
      .split(/,\s*(?=(?:https?:)?\/\/|\/)/)
      .map(function (part) { return part.trim().split(/\s+/)[0]; })
      .filter(Boolean);
  }

  function isMakerWorldHost() {
    return /(^|\.)makerworld\.(com|com\.cn|bblmw\.cn)$/i.test(location.hostname || '');
  }

  function collectCandidateUrls() {
    const candidates = [];
    const ogImage = textOf('meta[property="og:image"]') || textOf('meta[property="og:image:url"]');
    if (ogImage) candidates.push(ogImage);

    document.querySelectorAll('img, source, a').forEach(function (el) {
      const attrs = ['src', 'data-src', 'href', 'data-origin-src', 'data-large', 'data-url', 'data-image'];
      attrs.forEach(function (attr) {
        const value = el.getAttribute && el.getAttribute(attr);
        if (value) candidates.push(value);
      });
      if (el.currentSrc) candidates.push(el.currentSrc);
      srcsetUrls(el.getAttribute('srcset')).forEach(function (url) { candidates.push(url); });
      srcsetUrls(el.getAttribute('data-srcset')).forEach(function (url) { candidates.push(url); });
    });

    // 背景图只扫内联样式：避免对整页每个元素调用 getComputedStyle（大页面会明显卡顿）
    document.querySelectorAll('[style*="background" i]').forEach(function (el) {
      const background = (el.style && el.style.backgroundImage) || getComputedStyle(el).backgroundImage || '';
      for (const match of background.matchAll(/url\(["']?([^"')]+)["']?\)/g)) candidates.push(match[1]);
    });

    try {
      performance.getEntriesByType('resource').forEach(function (entry) {
        if (entry && entry.name) candidates.push(entry.name);
      });
    } catch (e) { /* 部分页面不允许读 performance */ }

    return candidates;
  }

  function imageContainerOf(url) {
    try {
      const pathname = new URL(url).pathname;
      const match = pathname.match(/\/(CN[0-9a-zA-Z]{6,}|DSM\d+)\//);
      return match ? match[1] : '';
    } catch (e) {
      return '';
    }
  }

  /** 统一候选图片：只保留图片扩展名、过滤头像/logo，同一设计图只留最高清版本。 */
  function rankImages(candidates) {
    const best = new Map();
    const order = [];
    (candidates || []).forEach(function (raw) {
      const url = normalizeUrl(raw);
      if (!url) return;
      let pathname = '';
      try { pathname = new URL(url).pathname; } catch (e) { return; }
      if (!IMAGE_EXT_RE.test(pathname)) return;
      if (IMAGE_BLOCK_RE.test(pathname)) return;
      const key = imageKey(url);
      if (!best.has(key)) {
        best.set(key, url);
        order.push(key);
      } else if (imageScore(url) > imageScore(best.get(key))) {
        best.set(key, url);
      }
    });
    return order.map(function (key) { return best.get(key); });
  }

  /** 页面源码里的图片 URL（JSON 里常带 \/ 转义，先还原再匹配）。 */
  function collectFallbackUrls() {
    const html = String(document.documentElement.outerHTML || '').replaceAll('\\/', '/');
    const urls = [];
    for (const match of html.matchAll(/https?:\/\/[^"'\\)<>\s]+\.(?:jpe?g|png|webp|gif)(?:\?[^"'\\)<>\s]*)?/gi)) {
      urls.push(match[0]);
    }
    return urls;
  }

  /**
   * 选出当前模型的图片：按设计图去重、优先高分辨率、优先和 og:image 同一模型目录。
   */
  function pickImages() {
    let ogImage = '';
    try { ogImage = normalizeUrl(textOf('meta[property="og:image"]')); } catch (e) { ogImage = ''; }

    const container = imageContainerOf(ogImage);
    let urls = rankImages(collectCandidateUrls());
    if (!urls.length) urls = rankImages(collectFallbackUrls());

    if (container) {
      const sameModel = urls.filter(function (url) { return url.indexOf('/' + container + '/') >= 0; });
      // 只要确认了本模型目录，就丢弃其它目录（相关模型）的图片
      if (sameModel.length) urls = sameModel;
    }

    return urls.slice(0, MAX_IMAGES);
  }

  /** 页面里的 3MF/STL/ZIP 等文件直链（有就记，没有就空数组）。 */
  function collectFileLinks() {
    const links = [];
    document.querySelectorAll('a[href]').forEach(function (anchor) {
      const href = anchor.getAttribute('href') || '';
      if (/\.(3mf|stl|obj|step|stp|zip|gcode)(\?|#|$)/i.test(href)) links.push(normalizeUrl(href));
    });
    try {
      const html = document.documentElement.outerHTML || '';
      for (const match of html.matchAll(/["'](https?:\/\/[^"']{0,300}?\.(?:3mf|stl|obj|step|stp|zip|gcode))["']/gi)) {
        links.push(match[1]);
      }
    } catch (e) { /* 忽略 */ }
    return uniq(links).slice(0, 10);
  }

  /* ------------------------------------------------------------------ *
   * 页面可见浮层（悬停打印配置时出现 PLA｜xxx g）
   * ------------------------------------------------------------------ */
  const OVERLAY_HINT_SELECTOR = '[role="tooltip"],[class*="tooltip" i],[class*="popover" i],[class*="hover" i],[class*="popper" i],[class*="float" i]';

  function overlayTextFrom(elements) {
    const out = [];
    elements.forEach(function (el) {
      if (!el || el.id === 'mw-collect-tip') return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const style = getComputedStyle(el);
      const zIndex = parseInt(style.zIndex || '0', 10);
      const text = cleanText(el.innerText || el.textContent || '');
      if (!text || text.length >= 2000) return;
      if (style.position !== 'fixed' && style.position !== 'absolute' && !(zIndex >= 10)) return;
      if (!/(PLA|PETG|ABS|TPU|ASA|耗材|材料|\d+\s*g|\d+\s*克|\d+(?:\.\d+)?\s*h|小时|层高|填充)/i.test(text)) return;
      out.push(text);
    });
    return uniq(out).join('\n---overlay---\n');
  }

  function visibleOverlayText() {
    // 先只扫提示框/浮层候选，避免大页面每次采集都遍历 body 下所有元素
    const hinted = overlayTextFrom([...document.querySelectorAll(OVERLAY_HINT_SELECTOR)]);
    if (hinted) return hinted;
    // 候选没找到时退回旧的全页扫描，保证不漏抓
    return overlayTextFrom([...document.querySelectorAll('body *')]);
  }

  function collectAttributeText() {
    const attrs = ['title', 'aria-label', 'alt', 'data-title', 'data-tooltip', 'data-original-title', 'data-tip', 'data-content'];
    const out = [];
    document.querySelectorAll('[title],[aria-label],[alt],[data-title],[data-tooltip],[data-original-title],[data-tip],[data-content]').forEach(function (el) {
      for (const attr of attrs) {
        const value = el.getAttribute && el.getAttribute(attr);
        if (value) out.push(value);
      }
    });
    return out.join('\n');
  }

  /* ------------------------------------------------------------------ *
   * 采集主流程
   * ------------------------------------------------------------------ */
  function currentModelId() {
    const match = location.pathname.match(/models\/(\d+)/i);
    return match ? match[1] : '';
  }

  function currentProfileId() {
    const match = location.hash.match(/profileId-?=?([0-9]+)/i);
    return match ? match[1] : '';
  }

  function guessPublishedAt(text) {
    const match = String(text || '').match(/发布于\s*(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : '';
  }

  function buildTitle() {
    const fromMeta = cleanTitle(textOf('meta[property="og:title"]'));
    if (fromMeta) return fromMeta;
    const fromH1 = cleanTitle(textOf('h1'));
    if (fromH1) return fromH1;
    return cleanTitle(document.title || '');
  }

  function buildDescription(bodyText) {
    const meta = decodeEntities(cleanText(
      textOf('meta[name="description"]') || textOf('meta[property="og:description"]')
    ));
    if (meta) return meta;
    return sectionBetween(bodyText, '描述', ['为我助力', '助力', '评论', '许可证', '相关模型']);
  }

  async function collectModel() {
    // 双重保护：Alt+M 同时被页面快捷键和 chrome.commands 接收时，只采集一次
    if (collecting) return;
    if (!isMakerWorldHost()) {
      showTip('请在 MakerWorld 页面使用 Alt+M（当前页面不是 MakerWorld）');
      return;
    }
    const modelId = currentModelId();
    if (!modelId) {
      showTip('请先打开一个模型详情页（网址里要有 /models/数字）');
      return;
    }
    if (Date.now() - lastCollectAt < COLLECT_COOLDOWN_MS) return;
    collecting = true;

    try {
      const bodyText = cleanText((document.body && document.body.innerText) || '');
      const attributeText = cleanText(collectAttributeText());
      const overlayText = cleanText(visibleOverlayText());
      const combinedText = cleanText(bodyText + '\n' + attributeText + '\n' + overlayText);

      const profileId = currentProfileId();
      const title = buildTitle();
      const description = buildDescription(bodyText);
      const images = pickImages();
      const fileLinks = collectFileLinks();

      const licenseLines = uniq(
        combinedText.split(/\n+/)
          .filter(function (line) {
            return /(license|许可证|授权|商用|commercial|creative commons|standard digital file license)/i.test(line);
          })
          .map(cleanText)
      ).slice(0, 10);

      const grams = extractGrams(combinedText).slice(0, 40);
      const times = extractTimes(combinedText).slice(0, 40);
      const printConfigs = uniq(
        (overlayText + '\n' + bodyText).split(/\n+/)
          .map(cleanText)
          .filter(function (line) { return line.length > 0 && line.length <= 120 && /(层高|填充|层墙|墙数|wall|infill)/i.test(line); })
      ).slice(0, 8);

      const data = {
        source: 'makerworld',
        collector_version: VERSION,
        collected_at: new Date().toISOString(),
        url: location.href,
        model_id: modelId,
        profile_id: profileId,
        title: title,
        description: description,
        published_at: guessPublishedAt(combinedText),
        guessed_filament_grams: grams,
        guessed_print_times: times,
        print_configs: printConfigs,
        license_related_lines: licenseLines,
        images: images,
        file_links: fileLinks,
        visible_text_preview: bodyText.slice(0, 8000),
        attribute_text_preview: attributeText.slice(0, 2000),
        overlay_text_preview: overlayText.slice(0, 5000),
        notes: {
          commercial_authorization: 'unverified',
          image_usage: 'only_use_author_images_if_author_explicitly_authorized',
          authorization_note: '采集不判断授权；商用、改名、使用原图前请人工确认作者许可。',
          tip: '采集最多 10 张图片（已按设计图去重，同一张图只留最高清版本）+ screenshot_visible.png。'
        }
      };

      let saveResult = null;
      try {
        saveResult = await chrome.runtime.sendMessage({
          type: 'MW_SAVE_COLLECTION',
          model_id: modelId,
          title: title,
          images: images,
          data: data
        });
      } catch (error) {
        saveResult = null;
      }

      showTip(buildTip(grams, times, images, saveResult));
    } finally {
      collecting = false;
      // 冷却从采集结束开始算：扫描超过 1.5 秒时，第二次触发也不会紧接着再采一遍
      lastCollectAt = Date.now();
    }
  }

  function buildTip(grams, times, images, result) {
    const parts = [];
    if (grams.length) parts.push('耗材 ' + grams.slice(0, 3).join(' / '));
    if (times.length) parts.push('时长 ' + times.slice(0, 2).join(' / '));
    if (!result) {
      parts.push('保存失败，请到扩展页点「刷新」后重试');
      return parts.join('；');
    }
    parts.push('图片 ' + (result.imageOk || 0) + '/' + (result.imageTotal || images.length));
    parts.push('截图 ' + (result.screenshotOk ? '已保存' : '失败'));
    if (result.jsonOk === false) parts.push('JSON 保存失败');
    if (Array.isArray(result.errors) && result.errors.length) parts.push('失败项 ' + result.errors.length + ' 个');
    return parts.join('；');
  }

  function showTip(message) {
    const old = document.getElementById('mw-collect-tip');
    if (old) old.remove();
    const tip = document.createElement('div');
    tip.id = 'mw-collect-tip';
    tip.textContent = message;
    tip.style.cssText = 'position:fixed;z-index:2147483647;right:20px;top:20px;background:#111;color:#fff;padding:12px 16px;border-radius:10px;font-size:14px;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:560px;line-height:1.5;cursor:pointer;';
    tip.title = '点击关闭';
    tip.addEventListener('click', function () { tip.remove(); });
    (document.body || document.documentElement).appendChild(tip);
    setTimeout(function () { tip.remove(); }, 6000);
  }

  window.__mwCollectModel = collectModel;

  // 页面内快捷键（chrome.commands 也会触发一次，靠上面的冷却合并成一次采集）
  document.addEventListener('keydown', function (event) {
    const isAltM = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
      && ((event.key && String(event.key).toLowerCase() === 'm') || event.code === 'KeyM');
    if (isAltM) {
      event.preventDefault();
      collectModel();
    }
  }, true);

  chrome.runtime.onMessage.addListener(function (message) {
    if (message && message.type === 'MW_COLLECT') collectModel();
  });

  // 调试/自测入口（不影响正常使用）
  window.__mwTest = {
    version: VERSION,
    cleanText: cleanText,
    cleanTitle: cleanTitle,
    decodeEntities: decodeEntities,
    sectionBetween: sectionBetween,
    extractGrams: extractGrams,
    extractTimes: extractTimes,
    normalizeUrl: normalizeUrl,
    imageKey: imageKey,
    imageScore: imageScore,
    srcsetUrls: srcsetUrls,
    rankImages: rankImages,
    collectFallbackUrls: collectFallbackUrls,
    pickImages: pickImages,
    isMakerWorldHost: isMakerWorldHost
  };
})();
