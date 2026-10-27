/* 闲鱼 3D 模型发布助手 · content.js
 * 版本：0.8.0
 * 作用：在闲鱼网页版发布页显示侧边面板：读取采集 JSON、AI 润色、扫描表单、半自动填写。
 * 原则：只操作网页上已经提供的输入框和选项，不点发布，不绕过平台校验。
 */
(() => {
  // 新版本独立标识，避免旧页面保留旧监听器时抢占消息。
  if (window.__xy3dPublisherV08) return;
  window.__xy3dPublisherV08 = true;

  const APP_ID = 'xy3d-panel';
  const CONFIG_KEY = 'xy3d_ai_config_v05';
  const MODEL_NAME = 'deepseek-flash';
  const VERSION = (() => {
    try { return chrome.runtime.getManifest().version; } catch (e) { return '0.8.0'; }
  })();

  const DEFAULT_CONFIG = {
    mode: 'smart',
    apiKey: '',
    localUrl: 'http://127.0.0.1:8765/polish',
    customRules: '【名称保留】\n保留采集资料中的原模型名称、IP 名称、系列名称、角色名和作者名称，不要改成泛化名称。\n\n【标题】\n标题优先使用原模型名称，不超过30个中文字符，清楚说明商品类型与用途。\n\n【描述】\n文案自然、简洁、适合闲鱼阅读，突出已提供的卖点。\n\n【声明】\n可保留原名称，但不要自行添加官方、正版、独家授权等未提供的声明。',
  };

  const TEXT = {
    title: '3D 发布助手',
    subtitle: '润色、填表 · 发布前人工确认',
    draft: '草稿',
    form: '表单',
    ai: 'AI 设置',
    readDraft: '草稿 JSON',
    loadDemo: '载入示例',
    clear: '清空',
    titleField: '标题',
    description: '宝贝描述',
    price: '价格',
    tone: '文案风格',
    polish: 'AI 润色',
    undo: '恢复原文',
    fill: '填入闲鱼',
    scan: '扫描表单',
    fillAll: '填写整张表单',
    image: '商品图片',
    category: '分类',
    other: '其他闲置',
    condition: '成色',
    shipping: '发货设置',
    originalPrice: '原价',
    save: '保存设置',
    test: '测试连接',
    apiKey: 'DeepSeek API Key',
    localUrl: '本地服务地址',
    smart: '智能模式（推荐）',
    local: '只用本地服务',
    direct: '只用插件直连',
  };

  const FIELD_DEFS = [
    ['images', '宝贝图片', ['宝贝图片', '商品图片'], 'file', true],
    ['title', '标题', ['宝贝标题', '商品标题', '标题'], 'text', false],
    ['description', '宝贝描述', ['宝贝描述', '商品描述', '描述'], 'textarea', true],
    ['category', '分类', ['分类'], 'select', true],
    ['brand', '品牌', ['品牌'], 'select', false],
    ['acg', 'ACG作品', ['ACG作品'], 'select', false],
    ['color', '成色', ['成色'], 'select', false],
    ['subcategory', '分类类别', ['分类类别'], 'select', false],
    ['height', '高度', ['高度'], 'select', false],
    ['scale', '比例', ['比例'], 'select', false],
    ['sale', '出售状态', ['出售状态'], 'select', false],
    ['box', '是否原装盒', ['是否原装盒'], 'select', false],
    ['price', '价格', ['价格', '出售价格', '商品价格'], 'number', true],
    ['originalPrice', '原价', ['原价'], 'number', false],
    ['shipping', '发货设置', ['发货设置'], 'choice', false],
    ['service', '服务', ['服务'], 'section', false],
    ['location', '宝贝所在地', ['宝贝所在地', '所在地'], 'select', false],
  ].map(([key, label, aliases, kind, required]) => ({ key, label, aliases, kind, required }));

  const state = {
    config: { ...DEFAULT_CONFIG },
    raw: {},
    images: [],
    before: null,
    busy: false,
    mounting: false,
    scanContext: null,
  };

  /* ------------------------------------------------------------------ *
   * 面板挂载
   * ------------------------------------------------------------------ */
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'XY7_PING') {
      sendResponse({ ok: true, version: VERSION });
      return;
    }
    if (message?.type === 'XY7_TOGGLE' || message?.type === 'XY_TOGGLE_PANEL') {
      toggle()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
      return true;
    }
  });

  function isXianyuHost() {
    return /(^|\.)(goofish\.com|xianyu\.com)$/i.test(location.hostname || '');
  }

  async function toggle() {
    const existing = document.getElementById(APP_ID);
    if (existing) { existing.remove(); return; }
    if (!isXianyuHost()) {
      console.warn('闲鱼3D发布助手：只在闲鱼网页版使用');
      return;
    }
    // 连点扩展图标时 toggle 可能并发进入，避免挂出两个面板
    if (state.mounting) return;
    state.mounting = true;
    try {
      await mount();
    } finally {
      state.mounting = false;
    }
  }

  async function mount() {
    if (!isXianyuHost()) throw Error('请在闲鱼网页版发布页使用');
    await loadConfig();
    const el = document.createElement('aside');
    el.id = APP_ID;
    el.innerHTML = `
      <header class="xy3d-header"><div><div class="xy3d-title">${TEXT.title} <span class="xy3d-version">v${VERSION}</span></div><div class="xy3d-subtitle">${TEXT.subtitle}</div></div><button class="xy3d-icon-btn" data-a="close">&times;</button></header>
      <nav class="xy3d-tabs"><button class="xy3d-tab active" data-tab="draft">${TEXT.draft}</button><button class="xy3d-tab" data-tab="form">${TEXT.form}</button><button class="xy3d-tab" data-tab="ai">${TEXT.ai}</button></nav>
      <main class="xy3d-scroll">
        <section class="xy3d-page" data-page="draft">
          <div class="xy3d-section"><label class="xy3d-label">${TEXT.readDraft}</label><input class="xy3d-file" type="file" accept=".json,application/json" data-r="draftFile"></div>
          <div class="xy3d-mini-row"><button class="xy3d-link-btn" data-a="demo">${TEXT.loadDemo}</button><button class="xy3d-link-btn" data-a="clear">${TEXT.clear}</button></div>
          <div class="xy3d-section"><div class="xy3d-label-line"><label class="xy3d-label">${TEXT.titleField}</label><span class="xy3d-counter" data-r="count">0/30</span></div><textarea class="xy3d-input xy3d-title-input" maxlength="30" data-r="title"></textarea></div>
          <div class="xy3d-section"><label class="xy3d-label">${TEXT.description}</label><textarea class="xy3d-input xy3d-desc-input" data-r="desc"></textarea></div>
          <div class="xy3d-grid-two xy3d-section"><div><label class="xy3d-label">${TEXT.price}</label><input class="xy3d-input" data-r="price" inputmode="decimal"></div><div><label class="xy3d-label">${TEXT.tone}</label><select class="xy3d-input" data-r="tone"><option>自然简洁</option><option>突出实用</option><option>收藏摆件</option><option>定制服务</option></select></div></div>
          <div class="xy3d-section xy3d-actions"><button class="xy3d-btn primary" data-a="polish">${TEXT.polish}</button><button class="xy3d-btn" data-a="undo" disabled>${TEXT.undo}</button></div>
          <div class="xy3d-risk hidden" data-r="risk"><strong>人工确认</strong><span data-r="riskText"></span></div>
          <div class="xy3d-section xy3d-actions"><button class="xy3d-btn primary" data-a="fill">${TEXT.fill}</button><button class="xy3d-btn" data-a="scan">${TEXT.scan}</button></div>
        </section>
        <section class="xy3d-page hidden" data-page="form">
          <div class="xy3d-connection-card"><span class="xy3d-dot checking" data-r="formDot"></span><div><strong data-r="formLabel">等待扫描发布表单</strong><small>分类切换后可重新扫描</small></div></div>
          <div class="xy3d-section"><label class="xy3d-label">${TEXT.image}</label><input class="xy3d-file" type="file" accept="image/png,image/jpeg,image/webp" multiple data-r="images"><div class="xy3d-help" data-r="imageCount">尚未选择图片</div></div>
          <div class="xy3d-section"><label class="xy3d-label">${TEXT.category}</label><div class="xy3d-fixed-value">${TEXT.other}</div><label class="xy3d-check-row"><input type="checkbox" data-r="autoCategory" checked><span>填写时自动选择“${TEXT.other}”</span></label></div>
          <div class="xy3d-grid-two xy3d-section"><div><label class="xy3d-label">成色默认值</label><select class="xy3d-input" data-r="condition"><option value="">保持页面现值</option><option>全新</option><option>几乎全新</option></select></div><div><label class="xy3d-label">${TEXT.shipping}</label><select class="xy3d-input" data-r="shipping"><option value="">保持页面现值</option><option>包邮</option><option>按距离计费</option><option>一口价</option></select></div></div>
          <div class="xy3d-section"><label class="xy3d-label">${TEXT.originalPrice}（可选）</label><input class="xy3d-input" data-r="original" inputmode="decimal"></div>
          <div class="xy3d-section xy3d-actions"><button class="xy3d-btn primary" data-a="fillAll">${TEXT.fillAll}</button><button class="xy3d-btn" data-a="scanForm">${TEXT.scan}</button></div>
          <div class="xy3d-field-report" data-r="report"><div class="xy3d-empty-report">点击“${TEXT.scan}”查看字段</div></div><div class="xy3d-note-card">插件只点击网页已提供的选项，不绕过平台限制；发布仍由你手动确认。</div>
        </section>
        <section class="xy3d-page hidden" data-page="ai">
          <div class="xy3d-connection-card"><span class="xy3d-dot checking" data-r="aiDot"></span><div><strong data-r="aiLabel">正在检测本地服务</strong><small>本地不可用时，智能模式会直连</small></div></div>
          <div class="xy3d-section"><label class="xy3d-label">调用方式</label><select class="xy3d-input" data-r="mode"><option value="smart">${TEXT.smart}</option><option value="local">${TEXT.local}</option><option value="direct">${TEXT.direct}</option></select></div>
          <div class="xy3d-section"><label class="xy3d-label">${TEXT.apiKey}</label><div class="xy3d-key-wrap"><input class="xy3d-input" type="password" autocomplete="off" data-r="key" placeholder="sk-..."><button class="xy3d-key-toggle" data-a="showKey">显示</button></div><div class="xy3d-help">仅保存在浏览器本地扩展存储中；本地服务模式可不填（服务端配置了环境变量时）。</div></div>
          <div class="xy3d-section">
            <label class="xy3d-label">${TEXT.localUrl}</label>
            <input class="xy3d-input" data-r="url">
          </div>
          <div class="xy3d-section">
            <div class="xy3d-label-line">
              <label class="xy3d-label">AI 文案规则（可编辑）</label>
              <button class="xy3d-link-btn" data-a="resetRules">恢复默认规则</button>
            </div>
            <textarea class="xy3d-input xy3d-rule-editor" data-r="customRules" placeholder="在这里直接写 AI 文案规则"></textarea>
            <div class="xy3d-help">可以直接写中文规则，不用写代码。保存后，本地服务与插件直连都会使用它。</div>
          </div>
          <div class="xy3d-readonly-card"><div><span>接口</span><code>api.deepseek.com/chat/completions</code></div><div><span>模型</span><code>${MODEL_NAME}</code></div></div>
          <div class="xy3d-section xy3d-actions"><button class="xy3d-btn primary" data-a="save">${TEXT.save}</button><button class="xy3d-btn" data-a="test">${TEXT.test}</button></div>
        </section>
      </main>
      <footer class="xy3d-status" data-r="status" data-kind="neutral"><span class="xy3d-status-dot"></span><span data-r="statusText">准备就绪</span></footer>`;
    document.body.appendChild(el);
    bind(el);
    renderConfig();
    updateCount();
    checkLocal();
  }

  function bind(panel) {
    panel.querySelector('[data-a="close"]').onclick = () => panel.remove();
    panel.querySelectorAll('[data-tab]').forEach((button) => { button.onclick = () => showTab(button.dataset.tab); });
    panel.querySelector('[data-r="draftFile"]').onchange = loadDraft;
    panel.querySelector('[data-r="title"]').oninput = updateCount;
    panel.querySelector('[data-r="images"]').onchange = chooseImages;
    const actions = {
      demo,
      clear: clearDraft,
      polish,
      undo,
      fill: fillBasic,
      fillAll,
      scan: scanForm,
      scanForm,
      save: saveConfig,
      test: testAI,
      showKey,
      resetRules,
    };
    panel.querySelectorAll('[data-a]').forEach((button) => {
      const handler = actions[button.dataset.a];
      if (handler) button.onclick = handler;
    });
  }

  /* ------------------------------------------------------------------ *
   * 配置与草稿
   * ------------------------------------------------------------------ */
  async function loadConfig() {
    try {
      const data = await chrome.storage.local.get(CONFIG_KEY);
      state.config = { ...DEFAULT_CONFIG, ...((data && data[CONFIG_KEY]) || {}) };
    } catch (e) {
      state.config = { ...DEFAULT_CONFIG };
    }
  }

  function renderConfig() {
    const mode = ['smart', 'local', 'direct'].includes(state.config.mode) ? state.config.mode : 'smart';
    r('mode').value = mode;
    r('key').value = state.config.apiKey || '';
    r('url').value = state.config.localUrl || DEFAULT_CONFIG.localUrl;
    r('customRules').value = state.config.customRules || '';
  }

  function getConfig() {
    return {
      mode: r('mode').value,
      apiKey: r('key').value.trim(),
      localUrl: r('url').value.trim() || DEFAULT_CONFIG.localUrl,
      customRules: r('customRules').value.trim(),
    };
  }

  async function saveConfig() {
    state.config = getConfig();
    try {
      await chrome.storage.local.set({ [CONFIG_KEY]: state.config });
      status('AI 设置已保存', 'success');
    } catch (e) {
      status(`保存失败：${e.message}`, 'error');
    }
    checkLocal();
  }

  function resetRules() {
    r('customRules').value = DEFAULT_CONFIG.customRules;
    status('AI 规则已恢复默认，请点“保存设置”', 'success');
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  function decodeEntities(value) {
    return String(value == null ? '' : value)
      .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
        try { return String.fromCodePoint(parseInt(hex, 16)); } catch (e) { return match; }
      })
      .replace(/&#(\d+);/g, (match, dec) => {
        try { return String.fromCodePoint(parseInt(dec, 10)); } catch (e) { return match; }
      })
      .replace(/&([a-z][a-z0-9]*);/gi, (match, name) => {
        const key = name.toLowerCase();
        return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : match;
      });
  }

  /** 去掉 MakerWorld 标题后缀（采集 JSON 里的 title 常带“- 免费 3D 打印模型 - MakerWorld”）。 */
  function cleanTitleText(value) {
    let text = decodeEntities(value).replace(/\s+/g, ' ').trim();
    text = text.replace(/\s*[-|｜]\s*(?:免费\s*)?3D\s*打印模型\s*[-|｜]\s*MakerWorld.*$/i, '');
    text = text.replace(/\s*[-|｜]\s*MakerWorld.*$/i, '');
    return text.trim();
  }

  /** 去掉简介里的平台推广段、URL 和多余空行，避免整段模板文案进入闲鱼。 */
  function cleanDescriptionText(value) {
    let text = decodeEntities(value).replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ');
    text = text.replace(/^免费下载由[^。\n]*。\s*/, '');
    text = text.replace(/https?:\/\/\S+/g, ' ');
    const kept = [];
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) { kept.push(''); continue; }
      if (/^(为我助力|助力|下载物料清单|评论|许可证|相关模型|物料清单)/.test(line)) break;
      kept.push(line);
    }
    const joined = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    // “为我助力”经常出现在同一行中间，按整段再切一次
    return joined.split(/为我助力|如果您喜欢这个模型|支持我的作品/)[0].trim().slice(0, 1500);
  }

  function first(obj, keys) {
    for (const key of keys) {
      const value = obj?.[key];
      if (value !== undefined && value !== null && value !== '') return String(value).trim();
    }
    return '';
  }

  /** 闲鱼标题最多 30 个字符；程序赋值不受 maxlength 限制，这里主动截断。 */
  function truncateTitle(value) {
    return Array.from(String(value || '')).slice(0, 30).join('');
  }

  function normalizeDraft(raw) {
    const source = raw && typeof raw.draft === 'object' && raw.draft ? raw.draft : (raw || {});
    return {
      title: truncateTitle(cleanTitleText(first(source, ['xianyu_title_safe', 'safe_title', 'title', 'xianyu_title', 'model_title', 'name']))),
      desc: cleanDescriptionText(first(source, ['xianyu_copy_safe', 'description', 'xianyu_description', 'copywriting', 'summary'])),
      price: first(source, ['price', 'price_suggestion', 'suggested_price']).replace(/[^\d.]/g, ''),
      tone: source.tone || '自然简洁',
      manual: Array.isArray(source.need_manual_fields) ? source.need_manual_fields : [],
    };
  }

  async function loadDraft(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      state.raw = raw;
      state.before = null;
      updateUndo();
      setDraft(normalizeDraft(raw));
      status(`已读取 ${file.name}`, 'success');
    } catch (error) {
      status(`读取失败：${error.message}`, 'error');
    }
  }

  function getDraft() {
    return {
      title: r('title').value.trim(),
      description: r('desc').value.trim(),
      price: r('price').value.trim(),
      tone: r('tone').value,
      customRules: (r('customRules') && r('customRules').value.trim()) || '',
      raw: state.raw,
    };
  }

  function setDraft(draft) {
    r('title').value = truncateTitle(draft.title || '');
    r('desc').value = draft.desc ?? draft.description ?? '';
    r('price').value = draft.price || '';
    if (draft.tone) r('tone').value = draft.tone;
    const manual = Array.isArray(draft.manual) ? draft.manual.filter(Boolean) : [];
    setRisk(manual.length ? `待人工确认：${manual.join('、')}` : '');
    updateCount();
  }

  function demo() {
    state.raw = { model_title: '科幻风格机甲摆件', filament_g: 107, print_time: '8小时' };
    setDraft({
      title: '科幻机甲3D打印桌面摆件',
      desc: '3D打印桌面模型，尺寸与颜色可以沟通，按需打印。',
      price: '88',
      tone: '自然简洁',
      manual: ['耗材克数', '图片使用授权'],
    });
    status('已载入测试草稿', 'success');
  }

  function clearDraft() {
    state.raw = {};
    state.before = null;
    state.images = [];
    const imagesInput = r('images');
    if (imagesInput) imagesInput.value = '';
    const imageCount = r('imageCount');
    if (imageCount) imageCount.textContent = '尚未选择图片';
    const tone = r('tone');
    if (tone) tone.value = '自然简洁';
    setDraft({ title: '', desc: '', price: '' });
    r('draftFile').value = '';
    setRisk('');
    updateUndo();
    status('草稿已清空');
  }

  function updateCount() {
    const count = Array.from(r('title')?.value || '').length;
    r('count').textContent = `${count}/30`;
    r('count').classList.toggle('warning', count >= 28);
  }

  /* ------------------------------------------------------------------ *
   * AI 润色
   * ------------------------------------------------------------------ */
  async function polish() {
    if (state.busy) return;
    const draft = getDraft();
    if (!draft.title && !draft.description) { status('请先读取草稿或填写内容', 'error'); return; }
    const config = getConfig();
    if (!config.apiKey && config.mode === 'direct') {
      showTab('ai');
      status('直连模式需要先填写 DeepSeek API Key', 'error');
      return;
    }
    state.before = { ...draft };
    updateUndo();
    busy(true, 'AI 正在润色文案…');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'XY_AI_REQUEST', payload: { config, draft } });
      if (!response || !response.ok) throw Error((response && response.error) || 'AI 请求失败');
      setDraft({ title: response.result.title, description: response.result.description, price: response.result.price });
      setRisk(response.result.risk_notes || '');
      const via = response.via === 'local' ? '本地服务' : '插件直连';
      status(`润色完成（${via}）`, 'success');
    } catch (error) {
      status(`润色失败：${error.message}`, 'error');
    } finally {
      busy(false);
    }
  }

  function undo() {
    if (!state.before) return;
    setDraft(state.before);
    state.before = null;
    updateUndo();
    setRisk('');
    status('已恢复原文', 'success');
  }

  function updateUndo() {
    const button = document.querySelector(`#${APP_ID} [data-a="undo"]`);
    if (button) button.disabled = !state.before || state.busy;
  }

  function setRisk(text) {
    const box = r('risk');
    if (!box) return;
    box.classList.toggle('hidden', !text);
    r('riskText').textContent = text || '';
  }

  /* ------------------------------------------------------------------ *
   * 表单扫描（带一次扫描内的元素索引，避免每次都全页查询）
   * ------------------------------------------------------------------ */
  function scan() {
    const context = getScanContext(true);
    return FIELD_DEFS.map((def) => ({ ...def, control: field(def, context) }));
  }

  function getScanContext(refresh) {
    if (refresh || !state.scanContext || Date.now() - state.scanContext.at > 5000) {
      state.scanContext = buildScanContext();
    }
    return state.scanContext;
  }

  function buildScanContext() {
    const context = { at: Date.now(), labels: new Map(), nodes: [] };
    document.querySelectorAll('label,span,div,p,a,strong,em').forEach((el) => {
      if (!visible(el)) return;
      const key = norm(text(el));
      if (!key || key.length > 30) return;
      const existing = context.labels.get(key);
      if (!existing || area(el) < area(existing)) context.labels.set(key, el);
    });
    context.nodes = [...document.querySelectorAll('input,textarea,button,select,[role=combobox],[role=option],[contenteditable=true],[tabindex]')]
      .filter(visible);
    return context;
  }

  function fieldBy(key) {
    const def = FIELD_DEFS.find((item) => item.key === key);
    return field(def, getScanContext(false));
  }

  function field(def, context) {
    if (!def) return null;
    if (def.kind === 'file') return imageInput();
    if (def.kind === 'section') return labelElement(def.aliases, context);
    const label = labelElement(def.aliases, context);
    if (label) {
      let parent = label.parentElement;
      for (let i = 0; parent && i < 5; i++, parent = parent.parentElement) {
        const found = controlIn(parent, def.kind, label);
        if (found) return found;
      }
    }
    return hintControl(context.nodes, def.aliases);
  }

  function labelElement(words, context) {
    const wanted = words.map(norm);
    let best = null;
    for (const word of wanted) {
      const hit = context.labels.get(word);
      if (hit && (!best || area(hit) < area(best))) best = hit;
    }
    return best || null;
  }

  const CONTROL_SELECTORS = {
    text: [
      'input[type=text]',
      'input:not([type])',
      'input:not([type=hidden]):not([type=file]):not([type=number]):not([type=radio]):not([type=checkbox])',
      'textarea',
      '[contenteditable=true]',
      '[role=textbox]',
    ],
    number: [
      'input[type=number]',
      'input[inputmode=decimal]',
      'input[inputmode=numeric]',
      'input:not([type=hidden]):not([type=file]):not([type=text]):not([type=radio]):not([type=checkbox])',
      'textarea',
    ],
    select: ['select', '[role=combobox]', '[role=listbox]', 'input:not([type=hidden]):not([type=file])'],
    choice: ['input[type=radio]', '[role=radio]', 'button', '[role=option]', 'label', '[tabindex="0"]'],
    textarea: ['textarea', '[contenteditable=true]', '[role=textbox]'],
  };

  function controlIn(box, kind, label) {
    if (!box) return null;
    const selectors = CONTROL_SELECTORS[kind] || CONTROL_SELECTORS.text;
    for (const selector of selectors) {
      const found = [...box.querySelectorAll(selector)].find((el) => el !== label && visible(el) && !el.closest(`#${APP_ID}`));
      if (found) return found;
    }
    return null;
  }

  function hintControl(nodes, words) {
    const wanted = words.map(norm);
    return nodes.find((el) => {
      const haystack = [el.placeholder, el.getAttribute('aria-label'), el.name, el.id, (el.parentElement?.innerText || '').slice(0, 200)]
        .filter(Boolean).join(' ');
      const normalized = norm(haystack);
      return wanted.some((word) => normalized.includes(word));
    }) || null;
  }

  function imageInput() {
    const inputs = [...document.querySelectorAll('input[type=file]')].filter((el) => !el.closest(`#${APP_ID}`));
    if (!inputs.length) return null;
    const scored = inputs.map((el) => ({ el, score: fileInputScore(el) }));
    scored.sort((a, b) => b.score - a.score);
    return scored[0].el;
  }

  function fileInputScore(el) {
    let score = 0;
    const accept = String(el.accept || '').toLowerCase();
    if (accept.includes('image')) score += 5;
    else if (accept.includes('.png') || accept.includes('.jpg')) score += 4;
    if (el.multiple) score += 3;
    const container = el.closest('div,section,form');
    const hint = container ? String(container.innerText || '').slice(0, 200) : '';
    if (/图片|照片|主图|商品图/.test(hint)) score += 4;
    return score;
  }

  function scanForm() {
    // 旧版写成 const scan = scan()，变量遮蔽函数名会抛 ReferenceError，扫描永远失败。
    const items = scan();
    renderReport(items);
    showTab('form');
    const found = items.filter((item) => item.control).length;
    status(`检测到 ${found}/${items.length} 个字段`, found ? 'success' : 'error');
    return items;
  }

  function renderReport(items) {
    const found = items.filter((item) => item.control).length;
    r('formDot').className = `xy3d-dot ${found ? 'online' : 'offline'}`;
    r('formLabel').textContent = found ? `已识别 ${found} 个字段` : '没有识别到发布表单';
    r('report').innerHTML = items.map((item) => `<div class="xy3d-field-row ${item.control ? 'found' : 'missing'}"><span>${esc(item.label)}${item.required ? '<b>*</b>' : ''}</span><em>${item.control ? '已找到' : '未找到'}</em></div>`).join('');
  }

  /* ------------------------------------------------------------------ *
   * 填写
   * ------------------------------------------------------------------ */
  async function fillBasic() {
    if (state.busy) return;
    busy(true, '正在填写标题、描述和价格…');
    let done = 0;
    let total = 0;
    try {
      const draft = getDraft();
      const tasks = [
        ['title', draft.title],
        ['description', draft.description],
        ['price', draft.price],
        ['originalPrice', r('original').value.trim()],
      ];
      for (const [key, value] of tasks) {
        if (!value) continue;
        total++;
        if (setText(fieldBy(key), value)) done++;
        await sleep(120);
      }
      scanForm();
      status(`已填写 ${done}/${total} 项，请人工检查后手动发布`, done ? 'success' : 'error');
    } catch (error) {
      status(`填写中断：${error.message}`, 'error');
    } finally {
      busy(false);
    }
  }

  async function fillAll() {
    if (state.busy) return;
    busy(true, '正在填写发布表单…');
    let done = 0;
    let total = 0;
    const step = async (action) => {
      total++;
      try { if (await action()) done++; } catch (e) { /* 单项失败不影响其它项 */ }
    };
    try {
      const draft = getDraft();
      const autoCategory = r('autoCategory');
      if (autoCategory && autoCategory.checked) {
        await step(async () => choose([TEXT.category], TEXT.other));
        await sleep(900);
        // 分类切换后页面可能整表重渲染，旧索引里的节点已经脱离 DOM
        state.scanContext = null;
      }
      await step(async () => Boolean(draft.title) && setText(fieldBy('title'), draft.title));
      await step(async () => Boolean(draft.description) && setText(fieldBy('description'), draft.description));
      await step(async () => Boolean(draft.price) && setText(fieldBy('price'), draft.price));
      await step(async () => Boolean(r('original').value.trim()) && setText(fieldBy('originalPrice'), r('original').value.trim()));
      await step(async () => Boolean(r('condition').value) && choose([TEXT.condition], r('condition').value));
      await step(async () => Boolean(r('shipping').value) && chooseChoice([TEXT.shipping], r('shipping').value));
      await step(async () => Boolean(state.images.length) && upload());
      scanForm();
      status(`已处理 ${done}/${total} 项，请人工检查后手动发布`, done ? 'success' : 'error');
    } catch (error) {
      status(`填写中断：${error.message}`, 'error');
    } finally {
      busy(false);
    }
  }

  function setText(el, value) {
    if (!el || el.isConnected === false) return false;
    const expected = String(value == null ? '' : value);
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* 忽略 */ }
    el.focus();
    if (el.isContentEditable) {
      el.textContent = expected;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: expected, inputType: 'insertText' }));
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, expected);
      else el.value = expected;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    // 回读校验：受控组件/只读字段可能拒绝这次赋值，不能盲目算成功
    const actual = el.isContentEditable ? String(el.textContent || '') : String(el.value || '');
    if (actual === expected) return true;
    if (actual.includes(expected) || expected.includes(actual)) return actual.length > 0;
    return false;
  }

  async function choose(labels, target) {
    const el = field({ aliases: labels, kind: 'select' }, getScanContext(false));
    if (!el) return false;
    if (norm(value(el)).includes(norm(target))) return true;
    // 原生 <select> 直接改 value + 派发事件，比模拟点击下拉更可靠
    if (el.tagName === 'SELECT' && selectNativeOption(el, target)) return true;
    click(el);
    const option = await optionFor(target, 2600, el);
    if (!option) {
      status(`未找到选项：${target}`, 'error');
      return false;
    }
    click(option);
    await sleep(250);
    return verifyChoice(el, target);
  }

  function selectNativeOption(el, target) {
    const wanted = norm(target);
    const options = [...el.options];
    const hit = options.find((option) => {
      const label = norm(option.textContent || option.label || '');
      return label === wanted || label.includes(wanted) || norm(option.value) === wanted;
    });
    if (!hit) return false;
    const proto = typeof HTMLSelectElement === 'undefined' ? null : HTMLSelectElement.prototype;
    const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
    if (setter) setter.call(el, hit.value);
    else el.value = hit.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function verifyChoice(el, target) {
    const wanted = norm(target);
    const current = norm(value(el));
    if (current && current.includes(wanted)) return true;
    const container = el.parentElement?.parentElement;
    return norm(container?.innerText || '').includes(wanted);
  }

  async function chooseChoice(labels, target) {
    const context = getScanContext(false);
    const label = Array.isArray(labels) ? labelElement(labels, context) : null;
    if (label) {
      // 先在“发货设置”附近的容器里找同文案的可见选项（单选按钮/标签）
      let container = label.parentElement;
      for (let i = 0; container && i < 4; i++, container = container.parentElement) {
        const hit = findExactTextIn(container, target);
        if (hit) {
          click(hit);
          await sleep(200);
          return true;
        }
      }
      // 再尝试控件本身：原生 select 直接赋值，自定义下拉先展开
      const box = label.parentElement?.parentElement || label.parentElement;
      const control = controlIn(box, 'choice', label);
      if (control) {
        if (control.tagName === 'SELECT' && selectNativeOption(control, target)) return true;
        click(control);
        const option = await optionFor(target, 1500, control);
        if (option) {
          click(option);
          await sleep(200);
          return true;
        }
      }
    }
    // 兜底：页面上已经可见的同文案选项
    const option = await optionFor(target, 1200, null);
    if (!option) return false;
    click(option);
    await sleep(200);
    return true;
  }

  function findExactTextIn(container, target) {
    if (!container) return null;
    const wanted = norm(target);
    const hits = [...container.querySelectorAll('span,div,li,label,a,button')]
      .filter((el) => visible(el) && plausibleOption(el) && norm(text(el) || el.innerText) === wanted);
    hits.sort((a, b) => area(a) - area(b));
    return hits[0] || null;
  }

  async function optionFor(target, timeout, ignore) {
    const deadline = Date.now() + timeout;
    let fallbackTried = false;
    while (Date.now() < deadline) {
      const hit = findOption(target, ignore);
      if (hit) return hit;
      if (!fallbackTried && Date.now() > deadline - timeout + 900) {
        fallbackTried = true;
        const fallback = fallbackOption(target);
        if (fallback) return fallback;
      }
      await sleep(120);
    }
    return null;
  }

  function findOption(target, ignore) {
    const wanted = norm(target);
    let best = null;
    for (const el of optionCandidates(ignore)) {
      if (norm(text(el) || el.innerText) !== wanted) continue;
      if (!best || optionScore(el) > optionScore(best)) best = el;
    }
    return best;
  }

  function dropdownRoots() {
    return [...document.querySelectorAll('[role=listbox],[role=menu],[class*=dropdown],[class*=Dropdown],[class*=popup],[class*=Popup],[class*=menu],[class*=Menu],[class*=select],[class*=Select]')]
      .filter((el) => el.children.length <= 200 && !el.closest(`#${APP_ID}`) && visible(el));
  }

  function optionCandidates(ignore) {
    const roots = dropdownRoots();
    const nodes = [];
    if (roots.length) {
      // 只在展开的下拉层里找，避免点到页面其它同名的文字
      for (const root of roots.slice(0, 6)) {
        nodes.push(...root.querySelectorAll('[role=option],[role=menuitem],li,[class*=option],[class*=item]'));
      }
    } else {
      nodes.push(...document.querySelectorAll('[role=option],[role=menuitem]'));
    }
    return nodes.filter((el) => el !== ignore && visible(el) && plausibleOption(el));
  }

  function plausibleOption(el) {
    const rect = el.getBoundingClientRect();
    if (rect.height > 320 || rect.width > window.innerWidth * 0.92) return false;
    if (el.querySelector('[role=option]')) return false;
    if (el.children.length > 15) return false;
    return true;
  }

  function fallbackOption(target) {
    const wanted = norm(target);
    const hits = [...document.querySelectorAll('span,div,li,a,button')]
      .filter((el) => visible(el) && !el.closest(`#${APP_ID}`) && plausibleOption(el) && norm(text(el)) === wanted);
    hits.sort((a, b) => area(a) - area(b));
    return hits[0] || null;
  }

  function optionScore(el) {
    let score = 0;
    const className = typeof el.className === 'string' ? el.className : '';
    if (el.getAttribute('role') === 'option') score += 10;
    if (/option|menu|popup|dropdown|list/i.test(className)) score += 6;
    if (el.closest('[role=listbox]')) score += 8;
    return score;
  }

  function chooseImages(event) {
    state.images = Array.from(event.target.files || []).slice(0, 9);
    r('imageCount').textContent = state.images.length ? `已选择 ${state.images.length} 张图片` : '尚未选择图片';
  }

  function upload() {
    const input = fieldBy('images');
    if (!input || !state.images.length) return false;
    try {
      const transfer = new DataTransfer();
      state.images.slice(0, 9).forEach((file) => transfer.items.add(file));
      input.files = transfer.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (error) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * 连接检测
   * ------------------------------------------------------------------ */
  async function checkLocal() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'XY_CHECK_LOCAL', localUrl: getConfig().localUrl });
      if (!response || !response.ok) throw Error();
      const dot = r('aiDot');
      const label = r('aiLabel');
      if (!dot || !label) return; // 面板在健康检查期间被关闭
      dot.className = 'xy3d-dot online';
      label.textContent = `本地服务在线 · ${response.result?.model || MODEL_NAME}`;
    } catch (error) {
      const dot = r('aiDot');
      const label = r('aiLabel');
      if (!dot || !label) return;
      dot.className = 'xy3d-dot offline';
      label.textContent = '本地服务未启动';
    }
  }

  async function testAI() {
    const config = getConfig();
    if (!config.apiKey && config.mode === 'direct') { status('请先填写 API Key', 'error'); return; }
    busy(true, '正在测试 DeepSeek…');
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'XY_AI_REQUEST',
        payload: { config, draft: { title: '测试', description: '请保持简短。', price: '1', raw: {} } },
      });
      if (!response || !response.ok) throw Error((response && response.error) || '连接失败');
      status('DeepSeek 连接正常', 'success');
    } catch (error) {
      status(`连接失败：${error.message}`, 'error');
    } finally {
      busy(false);
    }
  }

  /* ------------------------------------------------------------------ *
   * 通用小工具
   * ------------------------------------------------------------------ */
  function showKey(event) {
    const input = r('key');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    event.currentTarget.textContent = show ? '隐藏' : '显示';
  }

  function showTab(name) {
    const panel = document.getElementById(APP_ID);
    if (!panel) return;
    panel.querySelectorAll('[data-tab]').forEach((el) => el.classList.toggle('active', el.dataset.tab === name));
    panel.querySelectorAll('[data-page]').forEach((el) => el.classList.toggle('hidden', el.dataset.page !== name));
  }

  function busy(on, message) {
    state.busy = on;
    document.querySelectorAll(`#${APP_ID} button`).forEach((button) => {
      if (button.dataset.a !== 'close') button.disabled = on;
    });
    if (!on) updateUndo();
    if (message) status(message, 'loading');
  }

  function status(message, kind = 'neutral') {
    const box = r('status');
    if (!box) return;
    box.dataset.kind = kind;
    r('statusText').textContent = message;
  }

  function value(el) {
    return String(el?.value || el?.innerText || el?.textContent || '').trim();
  }

  function text(el) {
    if (!el) return '';
    const direct = [...el.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join(' ')
      .trim();
    return direct || (el.children.length === 0 ? String(el.textContent || '').trim() : '');
  }

  function norm(v) {
    return String(v == null ? '' : v).replace(/[\s\uFF1A:*]+/g, '').trim();
  }

  function visible(el) {
    if (!el || el.closest(`#${APP_ID}`)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function area(el) {
    const rect = el.getBoundingClientRect();
    return rect.width * rect.height;
  }

  function click(el) {
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* 忽略 */ }
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.click();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function r(name) {
    return document.querySelector(`#${APP_ID} [data-r="${name}"]`);
  }

  // 调试/自测入口（不影响正常使用）
  window.__xyTest = {
    version: VERSION,
    normalizeDraft,
    cleanTitleText,
    cleanDescriptionText,
    decodeEntities,
    norm,
    esc,
    scan,
    scanForm,
    setText,
    setDraft,
    selectNativeOption,
    controlIn,
    truncateTitle,
    isXianyuHost,
  };
})();
