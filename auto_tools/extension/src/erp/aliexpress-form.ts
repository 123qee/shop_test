import { aliasesMatch, cellAt, marketingCrop, shippingTemplateMatches, skuInputs, specAliases, truncateTitle } from './field-utils.js';
import { mountBatchList } from './batch-list.js';
import { isErpEditorUrl, isErpListUrl } from './batch-types.js';
import type { ErpBatchMessage, ErpRunReport } from './batch-types.js';
import { cloneAliExpressAutoFillDefaults, type AliExpressAutoFillConfig } from '@shared/aliexpress-auto-fill';

/** ERP 速卖通编辑页的安全填表助手。只在用户点击按钮后操作当前页面。 */
type Rule = { label: string; aliases: string[]; requireAll?: boolean };

const RULES: Rule[] = [
  { label: '品牌', aliases: ['NONE'] },
  { label: '产地（国家或地区）', aliases: ['中国大陆', 'Mainland China'] },
  { label: '中国省份', aliases: ['江西', 'Jiangxi'] },
  { label: '袖长(cm)', aliases: ['短款（4-16inch）', 'Short (4 - 16 Inch)'] },
  { label: '风格', aliases: ['休闲', 'Casual'] },
  { label: '材质', aliases: ['COTTON'] },
  { label: '适用场景', aliases: ['Daily'] },
  { label: '适用季节', aliases: ['夏季', 'summer'] },
  { label: '编织工艺', aliases: ['针织', 'Knit'] },
  { label: '特殊功能', aliases: ['可拉伸', '可持续', '防皱'], requireAll: true },
  { label: '高关注化学品', aliases: ['无'] },
  { label: '产品保养说明', aliases: ['机洗', 'Machine Wash'] },
  { label: '性别', aliases: ['男性', 'Men'] },
  { label: '上衣类型', aliases: ['T恤', 'TEES'] },
  { label: '产品类型', aliases: ['tops'] },
  { label: '领型', aliases: ['圆领', 'O-Neck'] },
  { label: '图案类型', aliases: ['印花'] },
  { label: '是否带帽', aliases: ['无帽', 'No'] },
  { label: '面料类型', aliases: ['细平布', 'Broadcloth'] },
  { label: '运费模板', aliases: ['copy copy copy copy copy copy 人民币20.9预算模板'] },
  { label: '服务模板', aliases: ['Service Template for New Sellers'] },
  { label: '欧盟责任人', aliases: ['Jiang Weijia'] },
  { label: '关联制造商', aliases: ['Lead shan county qixie century trading co., ltd'] },
];

let SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
let activeConfig = cloneAliExpressAutoFillDefaults();
const RULE_CONFIG_IDS: Record<string, string> = {
  '品牌': 'brand', '产地（国家或地区）': 'origin', '中国省份': 'province', '袖长(cm)': 'sleeveLength',
  '风格': 'style', '材质': 'material', '适用场景': 'scene', '适用季节': 'season', '编织工艺': 'knit',
  '特殊功能': 'features', '高关注化学品': 'chemicals', '产品保养说明': 'care', '性别': 'gender',
  '上衣类型': 'topType', '产品类型': 'productType', '领型': 'collar', '图案类型': 'pattern',
  '是否带帽': 'hood', '面料类型': 'fabricType', '运费模板': 'shippingTemplate', '服务模板': 'serviceTemplate',
  '欧盟责任人': 'euResponsible', '关联制造商': 'manufacturer',
};
const ROOT_ID = 'auto-tools-erp-helper';
const BUILD = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
const LEGACY_MSH_PANEL_STYLE_ID = 'auto-tools-disable-legacy-msh-panel';

let disposeList: (() => void) | undefined;
let detailRunner: (() => Promise<ErpRunReport>) | undefined;
let route = '';
let activeRunUrl: string | undefined;
let runCancelled = false;
let lastCompletedReport: ErpRunReport | undefined;
const executions = new Map<string, Promise<ErpRunReport>>();

function field(id: string) {
  return activeConfig.fields.find(item => item.id === id);
}
function value(id: string, fallback: string): string { return field(id)?.value ?? fallback; }
function enabled(id: string): boolean { return field(id)?.enabled ?? true; }
function splitValue(id: string, fallback: string[]): string[] {
  return value(id, fallback.join('|')).split('|').map(item => item.trim()).filter(Boolean);
}
function configuredRules(): Rule[] {
  return RULES.filter(rule => enabled(RULE_CONFIG_IDS[rule.label] || ''))
    .map(rule => ({ ...rule, aliases: splitValue(RULE_CONFIG_IDS[rule.label] || '', rule.aliases) }));
}
async function loadAutoFillConfig(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ALIEXPRESS_AUTOFILL_CONFIG' });
    if (response?.ok && response.type === 'GET_ALIEXPRESS_AUTOFILL_CONFIG' && Array.isArray(response.config?.fields)) {
      activeConfig = response.config;
    }
  } catch { /* 工作台服务暂不可用时，保留扩展内置配置。 */ }
  const configuredSizes = splitValue('sizeList', ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL']);
  SIZES = configuredSizes.length ? configuredSizes : ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
}

function syncRoute(): void {
  hideLegacyMiaoshouPanel();
  if (route === location.href) return;
  route = location.href;
  disposeList?.(); disposeList = undefined;
  document.getElementById(ROOT_ID)?.remove();
  detailRunner = undefined;
  lastCompletedReport = undefined;
  if (isErpListUrl(route)) disposeList = mountBatchList();
  else if (isErpEditorUrl(route)) mount();
}

/** 旧版“妙手自动填充 v0.1.3”不属于本项目源码；隐藏它的入口，避免和新版批量填表混用。 */
function hideLegacyMiaoshouPanel(): void {
  if (document.getElementById(LEGACY_MSH_PANEL_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = LEGACY_MSH_PANEL_STYLE_ID;
  style.textContent = '#msh-panel, .msh-panel, [id="msh-panel"], [class~="msh-panel"], msh-panel { display: none !important; visibility: hidden !important; pointer-events: none !important; }';
  (document.head || document.documentElement).append(style);
}

window.addEventListener('hashchange', syncRoute);
syncRoute();

chrome.runtime.onMessage.addListener((message: ErpBatchMessage, sender, reply) => {
  if (!['ERP_DETAIL_READY', 'ERP_DETAIL_PREPARE', 'ERP_DETAIL_RUN', 'ERP_DETAIL_SAVE', 'ERP_DETAIL_CANCEL'].includes(message?.type) || sender.id !== chrome.runtime.id) return false;
  if (message.type === 'ERP_DETAIL_CANCEL') { runCancelled = true; reply({ ok: true }); return false; }
  if (message.type === 'ERP_DETAIL_READY') {
    const blocked = visibleDialog();
    reply({ title: productTitle(), ready: isErpEditorUrl(location.href) && !!detailRunner && !!productTitle() && !!findItem('材质') && !!firstProductPhoto() && !!document.querySelector('#priceForm table.light-table'),
      blocked: blocked ? `商品页有待处理弹窗：${blocked.querySelector('.el-dialog__title')?.textContent?.trim() || blocked.getAttribute('aria-label') || '请查看编辑页'}` : undefined });
    return false;
  }
  if (message.type === 'ERP_DETAIL_PREPARE') {
    void (async () => {
      const id = new URLSearchParams(location.hash.split('?')[1]).get('id');
      if (!isErpEditorUrl(location.href) || id !== message.productId || productTitle().replace(/\s+/g, ' ').trim() !== message.expectedTitle.replace(/\s+/g, ' ').trim()) throw new Error('商品身份不匹配，未处理规格弹窗');
      if (activeRunUrl) throw new Error('商品正在处理，未操作规格弹窗');
      activeRunUrl = location.href; runCancelled = false;
      try { await prepareSpecUpgrade(); return { ok: true }; }
      finally { activeRunUrl = undefined; }
    })().then(reply, error => reply({ ok: false, error: (error as Error).message }));
    return true;
  }
  if (message.type === 'ERP_DETAIL_SAVE') {
    void saveDraft(message.productId, message.expectedTitle)
      .then(() => reply({ ok: true, saved: true }), error => reply({ ok: false, error: (error as Error).message }));
    return true;
  }
  if (message.type !== 'ERP_DETAIL_RUN') return false;
  if (executions.has(message.token)) {
    void executions.get(message.token)!.then(report => reply({ ok: true, report }), error => reply({ ok: false, error: error.message }));
    return true;
  }
  const execution = (async () => {
    const id = new URLSearchParams(location.hash.split('?')[1]).get('id');
    if (!isErpEditorUrl(location.href) || id !== message.productId || !detailRunner) throw new Error('商品页已切换，未执行填写');
    if (productTitle().replace(/\s+/g, ' ').trim() !== message.expectedTitle.replace(/\s+/g, ' ').trim()) throw new Error('编辑页标题与勾选商品不一致，请检查');
    return await detailRunner();
  })();
  executions.set(message.token, execution);
  void execution.then(report => { lastCompletedReport = report; reply({ ok: true, report }); }, error => reply({ ok: false, error: (error as Error).message }));
  return true;
});

function productTitle(): string {
  return findItem('产品标题')?.querySelector<HTMLInputElement>('input,textarea')?.value.trim() || '';
}

async function saveDraft(productId: string, expectedTitle: string): Promise<void> {
  const currentId = new URLSearchParams(location.hash.split('?')[1]).get('id');
  if (!isErpEditorUrl(location.href) || currentId !== productId || productTitle().replace(/\s+/g, ' ').trim() !== expectedTitle.replace(/\s+/g, ' ').trim()) {
    throw new Error('草稿保存前商品身份核对失败，未点击保存');
  }
  if (!lastCompletedReport || lastCompletedReport.productId !== productId || !lastCompletedReport.complete) {
    throw new Error('必填字段核对未通过，草稿未保存');
  }
  const saveButton = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.innerText.trim() === '保存' && isVisible(button) && !button.disabled);
  if (!saveButton) throw new Error('未找到可用的 ERP「保存」按钮');
  const existingNotices = new Set([...document.querySelectorAll<HTMLElement>('.el-message,.el-notification')]);
  saveButton.click();
  const outcome = await waitFor(() => {
    const notices = [...document.querySelectorAll<HTMLElement>('.el-message,.el-notification')]
      .filter(notice => isVisible(notice) && !existingNotices.has(notice));
    const success = notices.find(notice => /保存|成功/.test(notice.innerText) && /成功/.test(notice.innerText));
    if (success) return { ok: true, text: success.innerText.trim() };
    const failure = notices.find(notice => /error|warning/i.test(notice.className) || /失败|错误|必填|不能为空/.test(notice.innerText));
    return failure ? { ok: false, text: failure.innerText.trim() } : null;
  }, 15000);
  if (!outcome) throw new Error('已点击保存，但 ERP 没有返回成功提示，保存状态无法确认');
  if (!outcome.ok) throw new Error(`ERP 未保存草稿：${outcome.text || '请检查表单校验'}`);
}

function assertSameProduct(): void {
  if (activeRunUrl && runCancelled) throw new Error('处理已超时，填写已停止，请检查编辑页');
  if (activeRunUrl && location.href !== activeRunUrl) throw new Error('商品页已切换，填写已停止');
}

function mount(): void {
  const host = document.createElement('div');
  host.id = ROOT_ID;
  document.documentElement.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f2937}
      *{box-sizing:border-box}
      .launcher{position:fixed;right:24px;bottom:90px;z-index:2147483647;border:0;border-radius:999px;background:#2563eb;color:#fff;padding:12px 16px;font-size:14px;font-weight:700;box-shadow:0 8px 28px #0f172a33;cursor:pointer}
      .panel{position:fixed;right:24px;bottom:145px;z-index:2147483647;width:min(410px,calc(100vw - 32px));max-height:min(78vh,720px);overflow:auto;background:#fff;border:1px solid #dbe3ef;border-radius:16px;box-shadow:0 14px 44px #0f172a33;padding:18px;display:none;font-size:13px;line-height:1.5}
      .panel.open{display:block}.head{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px}.head strong{font-size:16px}.x{border:0;background:transparent;font-size:22px;color:#64748b;cursor:pointer}
      .sub{color:#64748b;margin:0 0 14px}.stats{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0}.stat{background:#f8fafc;border:1px solid #e5eaf2;border-radius:10px;padding:9px}.stat b{display:block;font-size:17px;color:#111827}.stat span{font-size:11px;color:#64748b}
      .list{margin:12px 0;padding:0;list-style:none}.list li{padding:8px 0;border-bottom:1px solid #edf1f6}.tag{float:right;color:#15803d;font-weight:600}.tag.warn{color:#b45309}.actions{display:flex;gap:8px;flex-wrap:wrap}.action{border:0;border-radius:9px;padding:10px 12px;background:#2563eb;color:white;font-weight:650;cursor:pointer}.action.secondary{background:#eff6ff;color:#1d4ed8}.action:disabled{opacity:.55;cursor:wait}.note{background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px;color:#854d0e;margin-top:12px}.status{margin-top:10px;color:#475569;white-space:pre-line}.small{font-size:11px;color:#64748b;margin-top:12px}
    </style>
    <button class="launcher" type="button">填表助手</button>
    <section class="panel" aria-label="ERP 填表助手">
      <div class="head"><strong>速卖通填表助手</strong><button class="x" aria-label="关闭">×</button></div>
      <p class="sub">按工作台配置检查并填写字段。手动填写不会保存；批量任务会在核对通过后保存草稿，不会发布。</p>
      <div class="stats"></div><ul class="list"></ul>
      <label>商品编码前缀（ERP 必填）<input class="prefix" placeholder="填写你自己的编码前缀" style="width:100%;padding:8px;margin:6px 0 12px;border:1px solid #cbd5e1;border-radius:6px"></label><div class="actions"><button class="action apply">自动填写（含营销图）</button><button class="action secondary image">补填营销图</button></div>
      <div class="note">先按工作台路径核对产品分类，再填写商品属性。按实物标签处理棉质成分：检测到 COTTON 时保留 COTTON、移除其他已选材质，并按工作台比例填写；确认比例后上传对应标签。PC 端原文保留并导入无线详情；自动填写会补齐 1:1 与 3:4 营销图。价格、货值、库存、重量、尺码和物流字段读取工作台配置。</div>
      <div class="status" role="status"></div>
      <div class="small">版本 ${escapeHtml(BUILD)} · 批量任务只会保存草稿，不会发布。</div>
    </section>`;

  const $ = <T extends Element>(selector: string) => shadow.querySelector<T>(selector)!;
  const panel = $('.panel');
  // 前缀默认采用当前商品 ID，用户仍可在面板中改写。
  $<HTMLInputElement>('.prefix').value = new URLSearchParams(location.hash.split('?')[1] || '').get('id') || '';
  $('.launcher').addEventListener('click', () => {
    panel.classList.toggle('open');
    void loadAutoFillConfig().then(refresh);
  });
  $('.x').addEventListener('click', () => panel.classList.remove('open'));
  $('.apply').addEventListener('click', () => { void applyRules().catch(error => setStatus((error as Error).message)); });
  $('.image').addEventListener('click', () => { void runMarketingOnly().catch(error => setStatus((error as Error).message)); });
  let running = false;
  detailRunner = applyRules;
  void loadAutoFillConfig().then(refresh);

  function refresh(): void {
    const rules = configuredRules();
    const matched = rules.filter((rule) => {
      const item = findItem(rule.label);
      const current = item ? currentText(item) : '';
      return item && (ruleMatches(current, rule) || rule.label === '特殊功能' && !!current.trim());
    }).length;
    const categoryEnabled = enabled('categoryPath');
    const categoryMatches = categoryEnabled && categoryPathMatches();
    const checkedCount = matched + (categoryMatches ? 1 : 0);
    const totalCount = rules.length + (categoryEnabled ? 1 : 0);
    const photo = firstProductPhoto();
    const sku = skuStatus();
    $('.stats').innerHTML = `
      <div class="stat"><b>${checkedCount}/${totalCount}</b><span>分类与属性已核对或保留源值</span></div>
      <div class="stat"><b>${SIZES.length}</b><span>目标尺码 XXS–XXXL</span></div>
      <div class="stat"><b>${sku.count}</b><span>已有商品编码</span></div>
      <div class="stat"><b>${photo ? `${photo.width}×${photo.height}` : '未识别'}</b><span>首张产品图</span></div>`;
    $('.list').innerHTML = [
      `<li>产品分类：${escapeHtml(categoryPath().join(' > '))}<span class="tag ${!categoryEnabled || categoryMatches ? '' : 'warn'}">${!categoryEnabled ? '已停用' : categoryMatches ? '已符合' : '待调整'}</span></li>`,
      `<li>产地/省份及商品属性<span class="tag">${matched === rules.length ? '已核对' : '待检查'}</span></li>`,
      `<li>尺码：${SIZES.join('、')}<span class="tag">${sizesMatch() ? '已符合' : '待调整'}</span></li>`,
      `<li>商品编码：使用 ERP 内置自动生成<span class="tag ${sku.count ? '' : 'warn'}">${sku.count ? '已有编码' : '待处理'}</span></li>`,
      '<li>PC 端描述：沿用采集原文<span class="tag">不改写</span></li>',
      '<li>无线详情：导入 PC 端描述<span class="tag">自动导入</span></li>',
      ...[false, true].map(portrait => `<li>营销图：${portrait ? '3:4 场景图' : '1:1 白底图'}<span class="tag ${validMarketingImage(portrait) ? '' : 'warn'}">${validMarketingImage(portrait) ? '已填入' : '待补填'}</span></li>`),
    ].join('');
  }

  async function applyRules(): Promise<ErpRunReport> {
    if (running || activeRunUrl) throw new Error('当前商品正在处理，请等待结束');
    running = true;
    runCancelled = false;
    activeRunUrl = location.href;
    const runUrl = location.href;
    const productId = new URLSearchParams(location.hash.split('?')[1]).get('id') || '';
    $<HTMLButtonElement>('.image').disabled = true;
    const button = $('.apply') as HTMLButtonElement;
    button.disabled = true;
    const results: string[] = [];
    try {
      await loadAutoFillConfig();
      const titleMaxChars = Number(value('titleMaxChars', '128')) || 128;
      const titleInput = findItem('产品标题')?.querySelector<HTMLInputElement>('input');
      if (titleInput) {
        const originalTitle = titleInput.value;
        const titleChars = Array.from(originalTitle);
        if (enabled('titleMaxChars') && titleChars.length > titleMaxChars) {
          const shortened = truncateTitle(originalTitle, titleMaxChars);
          setInput(titleInput, shortened);
          await delay(180);
          results.push(`标题：${titleChars.length} 字符已自动截到 ${Array.from(titleInput.value).length} 字符`);
        } else {
          results.push(`标题：${titleChars.length}/${titleMaxChars} 字符，未修改`);
        }
      } else {
        results.push('标题：未找到输入框，请检查');
      }
      results.push(await applyCategoryPath());
      for (const rule of configuredRules()) {
        assertSameProduct();
        const item = await waitFor(() => findItem(rule.label), 4000);
        if (!item) {
          results.push(`${rule.label}：页面未找到`);
          continue;
        }
        // 材质必须和棉标一起处理，单独修改属性容易把成分与比例拆开。
        if (rule.label === '材质' && enabled('materialRatio')) continue;
        // 如果采集商品已有有效特殊功能，但平台没有工作台配置的选项，沿用源值，不猜属性。
        if (rule.label === '特殊功能' && currentText(item).trim() && !ruleMatches(currentText(item), rule)) {
          results.push('特殊功能：平台没有全部目标选项，保留采集商品已有值');
          continue;
        }
        if (ruleMatches(currentText(item), rule)) {
          results.push(`${rule.label}：已正确，未修改`);
          continue;
        }
        const changed = await chooseOption(item, rule);
        results.push(`${rule.label}：${changed ? '已按目标选中' : '未自动更改，请手动检查'}`);
      }
      const compositionResult = await fillMaterialComposition();
      results.push(compositionResult);
      results.push(await uploadPhysicalLabel(compositionResult));
      // 删除发货地会重建 SKU 组合，必须在生成编码前处理。
      for (const label of ['闭合方式', '发货地']) {
        const item = findItem(label);
        const removers = [...(item?.querySelectorAll<HTMLElement>('.area-icon,.el-tag__close') || [])];
        for (const remove of removers) { remove.click(); await delay(150); }
        if (removers.length) results.push(`${label}：已按方案留空`);
      }
      const textile = findItem('纺织纤维成分信息-欧盟')?.querySelector<HTMLInputElement>('input');
      if (textile && enabled('euFiberComposition')) {
        if (compositionResult.startsWith('材质比例：已确认 COTTON ')) {
          setInput(textile, value('euFiberComposition', '100% cotton'));
          results.push(`纺织成分：${value('euFiberComposition', '100% cotton')}`);
        } else {
          results.push('纺织成分：比例未核实，保留原值并等待人工确认');
        }
      }
      for (const target of ['下单减库存', '含关税报价']) {
        const radio = [...document.querySelectorAll<HTMLElement>('#packingForm .el-radio')].find(e => e.innerText.trim() === target);
        if (radio && !radio.classList.contains('is-checked')) radio.click();
      }
      const sizesChanged = await syncSizes();
      results.push(await fillSkuAndPacking());
      const prefix = ($<HTMLInputElement>('.prefix')).value.trim();
      if (prefix && !skuStatus().count) {
        await generateSku(prefix);
      }
      results.push(`尺码：${sizesChanged === null ? '控件未识别' : sizesChanged ? '已调整为 XXS–XXXL' : '已符合，未修改'}`);
      results.push(`商品编码：${skuStatus().count ? '已有编码，保留 ERP 当前结果' : '编码为空；请在助手中填写自己的编码前缀后重试'}`);
      results.push('PC 端描述：未触碰');
      results.push(await selectFirstSizeChart());
      results.push(await importPcToWireless());
      results.push(await configureCustoms());
      setStatus('字段填写完成，正在处理两种营销图…');
      results.push(...await fillMarketingImages());
      setStatus(results.join('\n'));
    } catch (error) {
      results.push(`执行中断：${(error as Error).message}`);
      setStatus(results.join('\n'));
    } finally {
      running = false;
      activeRunUrl = undefined;
      button.disabled = false;
      $<HTMLButtonElement>('.image').disabled = false;
      panel.classList.add('open');
      refresh();
    }
    if (location.href !== runUrl) throw new Error('商品页已切换，填写已停止');
    const title = productTitle();
    const issues = results.filter(text => /未找到|未识别|未自动|未导入|未确认|未加载|未生成|为空|控件未|中断|不足|不符|请检查|请手动|尚有|等待人工/.test(text));
    for (const rule of configuredRules()) {
      const item = findItem(rule.label);
      if (rule.label === '材质' && enabled('materialRatio')) continue;
      if (!item) { issues.push(`${rule.label}：结果仍不符合方案`); continue; }
      if (rule.label === '特殊功能' && currentText(item).trim()) continue;
      if (!ruleMatches(currentText(item), rule)) issues.push(`${rule.label}：结果仍不符合方案`);
    }
    if (enabled('categoryPath') && !categoryPathMatches()) issues.push(`产品分类未匹配工作台路径：${categoryPath().join(' > ')}`);
    const material = findItem('材质');
    const ratio = Number(value('materialRatio', '100'));
    if (enabled('materialRatio') && (!material || !material.innerText.replace(/\s/g, '').includes(`COTTON${ratio}%`) || material.classList.contains('is-error'))) {
      issues.push(`材质比例未通过，需确认 COTTON ${ratio}%`);
    }
    if (enabled('physicalLabel') && !physicalLabelUploaded(findItem('纺织品实物标签'))) issues.push('纺织品实物标签未确认上传');
    if (!sizesMatch()) issues.push('尺码未全部符合 XXS–XXXL');
    const rowCount = document.querySelectorAll('#priceForm table.light-table tbody tr').length;
    if (!rowCount || skuStatus().count !== rowCount) issues.push('部分 SKU 商品编码为空');
    for (const portrait of [false, true]) if (!validMarketingImage(portrait)) issues.push(`${portrait ? '3:4' : '1:1'} 营销图未确认填入`);
    if (!findItem('海关监管属性')?.innerText.includes('已配置')) issues.push('海关监管属性尚未配置');
    issues.push(...skuAndPackingIssues());
    const titleMaxChars = Number(value('titleMaxChars', '128')) || 128;
    if (enabled('titleMaxChars') && Array.from(title).length > titleMaxChars) issues.push(`标题 ${Array.from(title).length} 字符，仍超过 ${titleMaxChars}；请检查`);
    const complete = issues.length === 0;
    return { productId, title, skuCount: skuStatus().count, complete, issues: [...new Set(issues)], log: results };
  }

  async function runMarketingOnly(): Promise<void> {
    if (running || activeRunUrl) return;
    running = true;
    runCancelled = false;
    activeRunUrl = location.href;
    $<HTMLButtonElement>('.apply').disabled = true;
    $<HTMLButtonElement>('.image').disabled = true;
    try {
      setStatus((await fillMarketingImages()).join('\n'));
    } finally {
      running = false;
      activeRunUrl = undefined;
      $<HTMLButtonElement>('.apply').disabled = false;
      $<HTMLButtonElement>('.image').disabled = false;
      panel.classList.add('open');
      refresh();
    }
  }

  async function fillMarketingImages(): Promise<string[]> {
    const results: string[] = [];
    for (const portrait of [false, true]) {
      const name = portrait ? '3:4 场景图' : '1:1 白底图';
      try {
        if (validMarketingImage(portrait)) {
          results.push(`${name}：已有合格尺寸图片`);
          continue;
        }
        const photo = firstProductPhoto();
        if (!photo) throw new Error('未识别首张产品图');
        const crop = marketingCrop(photo.width, photo.height, portrait);
        if (!crop) throw new Error('首图裁剪后像素不足，需要更高分辨率图片');
        const { width, height } = crop;
        const slot = marketingSlot(portrait);
        const ref = slot?.querySelector<HTMLElement>('.icon-text.canUpload');
        panel.classList.remove('open');
        let editor: HTMLElement | null = null;
        if (portrait) {
          const uploadInput = slot?.querySelector<HTMLInputElement>('input[type="file"]');
          if (uploadInput) {
            // ERP 的裁剪框不会把 800×800 方图放大到 750×1000；先等比缩放并留白成 3:4，再走原生上传。
            const file = await makePortraitMarketingFile(photo.src);
            const transfer = new DataTransfer();
            transfer.items.add(file);
            uploadInput.files = transfer.files;
            uploadInput.dispatchEvent(new Event('input', { bubbles: true }));
            uploadInput.dispatchEvent(new Event('change', { bubbles: true }));
            editor = await waitFor(() => visibleMarketingEditor(), 12000);
            if (!editor && !await waitFor(() => {
              const image = marketingImage(portrait);
              return image?.naturalWidth === width && image.naturalHeight === height && !visibleDialog() ? image : null;
            }, 3000)) throw new Error('3:4 图片文件已提交，但 ERP 没有打开裁剪器或确认回显');
          }
        }
        if (!editor && !validMarketingImage(portrait)) {
          if (!ref) throw new Error('已有图片尺寸不符或入口未识别，请检查');
          ref.click();
          // 两个位置各有独立上传组件；只操作当前可见弹窗，避免命中上一张的隐藏控件。
          const tab = await waitFor(() => [...document.querySelectorAll<HTMLElement>('#tab-citations')].find(isVisible));
          if (!tab) throw new Error('图片引用窗口未出现');
          tab.click();
          const choice = await waitFor(() => [...(visibleDialog()?.querySelectorAll<HTMLImageElement>('.table-item-citations img') || [])]
            .find(e => isVisible(e) && (e.dataset.src || e.src) === photo.src));
          if (!choice) throw new Error('引用列表未找到首图');
          const checkbox = choice.closest<HTMLElement>('.el-checkbox');
          if (!checkbox?.querySelector<HTMLInputElement>('input')?.checked) checkbox?.click();
          await delay(150);
          clickText(visibleDialog(), '确认上传');
          editor = await waitFor(() => visibleMarketingEditor(), 12000);
        }
        if (editor) {
          clickText(editor, portrait ? '3:4' : '1:1');
          await delay(500);
          const inputs = [...editor.querySelectorAll<HTMLInputElement>('input.el-input__inner')];
          if (inputs.length !== 2) throw new Error('裁剪尺寸控件未识别');
          setInput(inputs[0], String(width));
          await delay(150);
          setInput(inputs[1], String(height));
          await delay(400);
          if (inputs[0].value !== String(width) || inputs[1].value !== String(height)) {
            throw new Error('裁剪器尚未接受目标尺寸，请检查弹窗');
          }
          clickText(editor, '确定');
        }
        const accepted = await waitFor(() => {
          const image = marketingImage(portrait);
          return image?.naturalWidth === width && image.naturalHeight === height && !visibleDialog() ? image : null;
        }, 15000);
        if (!accepted) throw new Error('未确认图片进入表单，请检查 ERP 弹窗');
        results.push(`${name}：已填入 ${width}×${height}`);
        refresh();
      } catch (error) {
        results.push(`${name}：${(error as Error).message}`);
        // 留着出错的窗口供检查，不在旧弹窗未结束时继续启动下一个上传。
        if (visibleDialog()) break;
      }
    }
    panel.classList.add('open');
    return results;
  }

  function setStatus(message: string): void {
    $('.status').textContent = message;
  }
}

function marketingSlot(portrait: boolean): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('#baseInfoForm .AcqHandel')]
    .find(e => e.innerText.includes(portrait ? '3:4场景图' : '1:1白底图')) ?? null;
}

function marketingImage(portrait: boolean): HTMLImageElement | null {
  return marketingSlot(portrait)?.querySelector<HTMLImageElement>('.hasImg-upload > img') ?? null;
}

function visibleMarketingEditor(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('.imgEdit-dialog')].find(dialog => {
    const canvas = dialog.querySelector<HTMLElement>('.cropper-container');
    return isVisible(dialog) && canvas && isVisible(canvas);
  }) ?? null;
}

async function makePortraitMarketingFile(source: string): Promise<File> {
  const response = await fetch(source, { mode: 'cors', credentials: 'omit' });
  if (!response.ok) throw new Error(`读取产品图失败（${response.status}）`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement('canvas');
  canvas.width = 750;
  canvas.height = 1000;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法生成 3:4 图片画布');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  context.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('3:4 图片生成失败')), 'image/png'));
  return new File([blob], 'marketing-3-4.png', { type: 'image/png' });
}

function validMarketingImage(portrait: boolean): boolean {
  const image = marketingImage(portrait);
  if (!image) return false;
  const { naturalWidth: width, naturalHeight: height } = image;
  return portrait ? width >= 750 && height >= 1000 && width * 4 === height * 3 : width >= 800 && width === height;
}

function findItem(label: string): HTMLElement | null {
  const labels = [...document.querySelectorAll<HTMLElement>('.el-form-item__label')];
  const target = labels.find((el) => el.innerText.replace(/[\uE000-\uF8FF]/g, '').replace(/^\s*\*\s*/, '').trim() === label);
  return target?.closest<HTMLElement>('.el-form-item') ?? null;
}

function categoryPath(): string[] {
  return splitValue('categoryPath', ['男装', '上衣，T恤', 'T恤']);
}

function normalizeCategoryPath(text: string): string {
  return text.replace(/[\s\u00a0]/g, '').replace(/[＞›]/g, '>');
}

function currentCategoryPath(): string {
  const item = findItem('产品分类');
  if (!item) return '';
  const leaf = [...item.querySelectorAll<HTMLElement>('*')]
    .filter(element => element.children.length === 0)
    .map(element => (element.innerText || element.textContent || '').trim())
    .find(text => text.includes('>'));
  if (leaf) return leaf;
  return item.innerText.split('\n').map(text => text.trim()).find(text => text.includes('>')) || '';
}

function categoryPathMatches(): boolean {
  const current = currentCategoryPath();
  return !!current && normalizeCategoryPath(current) === normalizeCategoryPath(categoryPath().join('>'));
}

function categoryTextOption(scope: HTMLElement, text: string): HTMLElement | null {
  const expected = normalizeCategoryPath(text);
  return [...scope.querySelectorAll<HTMLElement>('*')]
    .filter(element => element.children.length === 0 && isVisible(element)
      && normalizeCategoryPath(element.innerText || element.textContent || '') === expected)
    .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0] || null;
}

async function applyCategoryPath(): Promise<string> {
  if (!enabled('categoryPath')) return '产品分类：已在工作台停用，未修改';
  const desired = categoryPath();
  if (desired.length < 2) return '产品分类：工作台路径至少需要两级，请检查';
  if (categoryPathMatches()) return `产品分类：已符合 ${desired.join(' > ')}`;

  const item = findItem('产品分类');
  if (!item) return '产品分类：页面未找到分类控件，请检查';
  const oldPath = currentCategoryPath();
  const pickerIsOpen = () => [...document.querySelectorAll<HTMLElement>('.el-popover,.el-dialog')]
    .find(element => isVisible(element)
      && (!!element.querySelector<HTMLInputElement>('input[placeholder="类目搜索"]') || element.innerText.includes('类目搜索'))) || null;
  // ERP 分类字段的文字节点并不响应脚本点击，点击实际输入控件/内容区域才会打开树。
  const triggerCandidates = [
    item.querySelector<HTMLElement>('.car-input.el-popover__reference'),
    item.querySelector<HTMLElement>('.el-popover__reference'),
    item.querySelector<HTMLElement>('.el-cascader .el-input__inner'),
    item.querySelector<HTMLElement>('.el-input__inner'),
    item.querySelector<HTMLElement>('.el-cascader'),
    item.querySelector<HTMLElement>('.el-select'),
    item.querySelector<HTMLElement>('.el-input__suffix'),
    item.querySelector<HTMLElement>('.el-select__caret'),
    [...item.querySelectorAll<HTMLElement>('*')].find(element => element.children.length === 0
      && (element.innerText || element.textContent || '').includes('>')) || null,
    item.querySelector<HTMLElement>('.el-form-item__content'),
    item,
  ].filter((element, index, all): element is HTMLElement => !!element && all.indexOf(element) === index);
  let picker: HTMLElement | null = pickerIsOpen();
  for (const trigger of triggerCandidates) {
    if (picker) break;
    if (trigger.matches('.car-input.el-popover__reference,.el-popover__reference')) {
      trigger.click();
      picker = await waitFor(pickerIsOpen, 900);
      continue;
    }
    const rect = trigger.getBoundingClientRect();
    if (!rect.width || !rect.height || !isVisible(trigger)) continue;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const down = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: 1 };
    trigger.dispatchEvent(new MouseEvent('mousedown', down));
    trigger.dispatchEvent(new MouseEvent('mouseup', { ...down, buttons: 0 }));
    trigger.dispatchEvent(new MouseEvent('click', { ...down, buttons: 0 }));
    picker = await waitFor(pickerIsOpen, 900);
  }
  if (!picker) return '产品分类：分类选择器未打开，请检查';

  try {
    for (const segment of desired) {
      const option = await waitFor(() => categoryTextOption(picker, segment), 4000);
      if (!option) throw new Error(`分类列表中没有“${segment}”`);
      option.click();
      await delay(180);
    }
    const selectedLine = picker.innerText.split('\n').map(text => text.trim()).find(text => text.includes('您当前的选择是')) || '';
    const selectedPath = selectedLine.split(/[：:]/).slice(1).join(':').trim();
    if (normalizeCategoryPath(selectedPath) !== normalizeCategoryPath(desired.join('>'))) {
      throw new Error('ERP 当前选择路径与工作台目标路径不一致');
    }
    clickText(picker, '确定');
    const categoryChangeWarning = await waitFor(() => {
      const dialog = document.querySelector<HTMLElement>('.el-message-box');
      if (!dialog || !isVisible(dialog)) return null;
      const message = dialog.innerText.replace(/\s+/g, '');
      return message.includes('更换类目后') && message.includes('当前页面所属的产品属性、价格等信息将不被保留')
        ? dialog
        : null;
    }, 1200);
    if (categoryChangeWarning) {
      const confirm = [...categoryChangeWarning.querySelectorAll<HTMLElement>('button,.el-button,[role="button"]')]
        .find(button => (button.innerText || button.textContent || '').trim() === '确定');
      if (!confirm) throw new Error('ERP 已提示类目变更会清空表单，但没有找到确认按钮');
      confirm.click();
    }
    await waitFor(() => categoryPathMatches() ? true : null, 4000);
    return categoryPathMatches()
      ? `产品分类：已自动选择 ${desired.join(' > ')}`
      : `产品分类：已选择，但页面未确认目标路径${oldPath ? `（原分类：${oldPath}）` : ''}`;
  } catch (error) {
    try { clickText(picker, '取消'); } catch { /* 弹窗已被 ERP 关闭时无需再处理。 */ }
    return `产品分类：未自动更改，请检查（${(error as Error).message}）`;
  }
}

function currentText(item: HTMLElement): string {
  const inputs = [...item.querySelectorAll<HTMLInputElement>('input.el-input__inner')];
  const values = inputs.map((input) => input.value.trim()).filter(Boolean);
  const text = [...item.querySelectorAll<HTMLElement>('.form-area')].map(e => e.innerText).join(' ');
  return [...values, text].join(' ');
}

async function prepareSpecUpgrade(): Promise<void> {
  const dialog = visibleDialog();
  if (!dialog) return;
  if (!dialog.classList.contains('new-size-dialog') || !dialog.innerText.includes('速卖通平台类目规格属性升级')) throw new Error('商品页存在其他弹窗，请查看编辑页');
  const rows = [...dialog.querySelectorAll<HTMLTableRowElement>('tbody tr.el-table__row')];
  if (!rows.length) throw new Error('规格升级列表尚未加载，请重试');
  // 先逐行打开下拉框读取真实可选项，确认整张表都能唯一映射后再改值。
  // Element UI 会把菜单挂到 body 下，选项不在规格单元格的子树里。
  const plan: Array<{ cell: HTMLTableCellElement; original: string; preferred: string; selected: string }> = [];
  for (const row of rows) {
    const original = row.cells[0]?.innerText.trim() || '';
    const cell = row.cells[1];
    const preferred = specAliases(original)[0];
    const input = cell?.querySelector<HTMLInputElement>('.el-select input.el-input__inner, input.el-input__inner');
    if (!original || !cell || !input || !preferred) throw new Error(`规格升级：${original || '未知规格'}没有可操作的匹配项，请检查`);
    const current = input.value.trim();
    if (aliasesMatch(current, [preferred])) {
      plan.push({ cell, original, preferred, selected: current });
      continue;
    }
    input.click();
    const options = await waitFor(() => {
      const visible = visibleSelectOptions();
      return visible.length ? visible : null;
    }, 3500);
    const matches = (options || [])
      .filter(option => option.text !== '删除规格属性值' && aliasesMatch(option.text, [preferred]));
    document.body.click();
    if (matches.length !== 1) throw new Error(`规格升级：${original}无法唯一匹配到${preferred}，请检查选项`);
    plan.push({ cell, original, preferred, selected: matches[0].text });
  }
  for (const { cell, original, preferred, selected } of plan) {
    assertSameProduct();
    const input = cell.querySelector<HTMLInputElement>('.el-select input.el-input__inner, input.el-input__inner');
    if (!input) throw new Error(`规格升级：${original}匹配控件已消失`);
    if (aliasesMatch(input.value.trim(), [preferred])) continue;
    input.click();
    const options = await waitFor(() => {
      const visible = visibleSelectOptions();
      return visible.length ? visible : null;
    }, 3500);
    const matches = (options || []).filter(option => option.text === selected && aliasesMatch(option.text, [preferred]));
    if (matches.length !== 1) {
      document.body.click();
      throw new Error(`规格升级未找到唯一选项：${original} → ${preferred}`);
    }
    matches[0].element.click();
    await delay(150);
    if (!aliasesMatch(input.value.trim(), [preferred])) throw new Error(`规格升级未匹配成功：${original} → ${preferred}`);
  }
  clickText(dialog, '确定');
  if (!await waitFor(() => !isVisible(dialog), 5000)) throw new Error('规格升级确认后弹窗未关闭，请检查');
  await delay(600);
}

/** 根据实物标签保留 COTTON，清除该比例弹窗里的其他已选材质，再填写目标比例。 */
async function fillMaterialComposition(): Promise<string> {
  if (!enabled('materialRatio')) return '材质比例：已在工作台停用，未改写';
  const targetRatio = Number(value('materialRatio', '100'));
  if (!Number.isFinite(targetRatio) || targetRatio < 0 || targetRatio > 100) return '材质比例：工作台配置不在 0–100 范围，请先修正';
  const item = findItem('材质');
  const trigger = item?.querySelector<HTMLElement>('.other-plate');
  if (!item || !trigger) return '材质比例：未识别材质设置入口，请检查';
  trigger.click();
  const dialog = await waitFor(() => {
    const visible = visibleDialog();
    return visible?.innerText.includes('材质比例') ? visible : null;
  }, 4000);
  if (!dialog) return '材质比例：设置窗口未出现，请检查';

  const selected = [...dialog.querySelectorAll<HTMLInputElement>('.checked-tr input[type="checkbox"]')]
    .filter(input => input.checked);
  const cotton = selected.filter(input => input.value.split('|').some(value => aliasesMatch(value, ['COTTON'])));
  if (cotton.length !== 1) {
    clickText(dialog, '取消');
    return '材质比例：未找到唯一 COTTON 选项，未改动成分';
  }
  for (const input of selected.filter(candidate => !cotton.includes(candidate))) {
    if (!await setCheckboxChecked(input, false)) {
      clickText(dialog, '取消');
      return '材质比例：其他材质未能移除，未确认修改';
    }
  }
  const remaining = [...dialog.querySelectorAll<HTMLInputElement>('.checked-tr input[type="checkbox"]')]
    .filter(input => input.checked);
  if (remaining.length !== 1 || !remaining[0].value.split('|').some(value => aliasesMatch(value, ['COTTON']))) {
    clickText(dialog, '取消');
    return '材质比例：清理后未能确认仅保留 COTTON，未确认修改';
  }

  const row = cotton[0].closest<HTMLElement>('.checked-tr');
  const ratio = row?.querySelector<HTMLInputElement>('input[type="number"]');
  if (!ratio) {
    clickText(dialog, '取消');
    return '材质比例：未找到 COTTON 比例输入框，请检查';
  }
  setInput(ratio, String(targetRatio));
  await delay(120);
  if (Number(ratio.value) !== targetRatio) throw new Error(`材质比例：ERP 未接受${targetRatio}%，请检查`);
  clickText(dialog, '确定');
  if (!await waitFor(() => !isVisible(dialog), 4000)) throw new Error('材质比例：确认后窗口未关闭，请检查');
  await delay(180);
  const compositionText = item.innerText.replace(/\s/g, '');
  if (!compositionText.includes(`COTTON${targetRatio}%`) || item.classList.contains('is-error')) {
    return `材质比例：已设置 COTTON ${targetRatio}%，但 ERP 仍报错，请检查`;
  }
  return `材质比例：已确认 COTTON ${targetRatio}%`;
}

function physicalLabelUploaded(item: HTMLElement | null): boolean {
  return [...(item?.querySelectorAll<HTMLImageElement>('.hasImg-upload img') || [])]
    .some(image => isVisible(image) && !image.src.includes('upload-add-active.png') && image.naturalWidth > 0);
}

/** 用 ERP 原生 checkbox 事件更新受控组件，并等待界面确认状态。 */
async function setCheckboxChecked(input: HTMLInputElement, checked: boolean): Promise<boolean> {
  if (input.checked === checked) return true;
  const targets = [
    input,
    input.closest<HTMLElement>('.el-checkbox__input'),
    input.closest<HTMLElement>('.el-checkbox'),
    input.closest<HTMLElement>('label'),
  ].filter((target): target is HTMLElement => !!target);
  for (const target of targets) {
    target.click();
    if (await waitFor(() => input.checked === checked ? true : null, 700)) return true;
  }
  return input.checked === checked;
}

/** 上传扩展内随包分发的真实棉标图片到“纺织品实物标签”字段。 */
async function uploadPhysicalLabel(compositionResult: string): Promise<string> {
  if (!enabled('physicalLabel')) return '纺织品实物标签：已在工作台停用，未上传';
  const item = findItem('纺织品实物标签');
  if (!item) return '纺织品实物标签：未找到上传字段';
  if (physicalLabelUploaded(item)) return '纺织品实物标签：已有图片，未重复上传';
  // 只有 ERP 已确认材质和比例后，才上传对应的 100% COTTON 标签。
  if (!/^材质比例：已确认 COTTON 100%$/.test(compositionResult)) {
    return '纺织品实物标签：标签为 100% 棉，当前商品材质或比例不符，未上传';
  }
  const input = item.querySelector<HTMLInputElement>('input[type="file"][accept*="image/png"]');
  if (!input) return '纺织品实物标签：未找到图片上传控件';
  const assetPath = value('physicalLabel', 'assets/physical-label.png');
  if (!/^assets\/[a-zA-Z0-9._-]+$/.test(assetPath)) return '纺织品实物标签：工作台资源路径无效，请使用 assets/ 文件名';
  const response = await fetch(chrome.runtime.getURL(assetPath));
  if (!response.ok) throw new Error(`实物标签图片读取失败（${response.status}）`);
  const blob = await response.blob();
  if (blob.type !== 'image/png' || blob.size < 1000) throw new Error('实物标签图片格式或内容无效');
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], 'physical-label.png', { type: 'image/png' }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  if (!await waitFor(() => physicalLabelUploaded(item) ? true : null, 15000)) {
    throw new Error('实物标签上传未确认，请检查 ERP 字段');
  }
  return '纺织品实物标签：已上传指定图片';
}

function ruleMatches(value: string, rule: Rule): boolean {
  if (rule.label === '运费模板') return shippingTemplateMatches(value, rule.aliases);
  // 该字段可能把材质选项和成分比例一起展示，例如“COTTON 100%”。
  // 只接受纯材质或 100% 同材质，避免把混纺误判为纯棉。
  if (rule.label === '材质') {
    const normalized = value.toLocaleLowerCase().replace(/\s/g, '').replace(/（/g, '(').replace(/）/g, ')');
    if (aliasesMatch(value, rule.aliases)) return true;
    return rule.aliases.some(alias => normalized.includes(`${alias.toLocaleLowerCase().replace(/\s/g, '')}100%`));
  }
  if (!rule.requireAll) return aliasesMatch(value, rule.aliases);
  const normalized = value.toLocaleLowerCase().replace(/[\s（）()]/g, '');
  return rule.aliases.every((alias) => normalized.includes(alias.toLocaleLowerCase().replace(/[\s（）()]/g, '')));
}

async function chooseOption(item: HTMLElement, rule: Rule): Promise<boolean> {
  const multi = item.querySelector<HTMLElement>('.other-plate');
  if (multi) {
    multi.click();
    const dialog = await waitFor(() => visibleDialog());
    if (!dialog) return false;
    const labels = [...dialog.querySelectorAll<HTMLElement>('.el-checkbox')];
    const unique = new Map<string, HTMLElement>();
    for (const label of labels) {
      const text = label.innerText.trim();
      if (text !== '全选' && !unique.has(text)) unique.set(text, label);
    }
    if (!rule.aliases.every(target => [...unique.keys()].some(text => aliasesMatch(text, [target])))) {
      clickText(dialog, '取消');
      return false;
    }
    for (const [text, label] of unique) {
      const input = label.querySelector<HTMLInputElement>('input');
      if (input && input.checked !== aliasesMatch(text, rule.aliases)) { label.click(); await delay(40); }
    }
    clickText(dialog, '确定');
    await delay(250);
    return ruleMatches(currentText(item), rule);
  }
  const input = item.querySelector<HTMLInputElement>('input.el-input__inner');
  if (!input) return false;
  if (item.querySelector('.el-autocomplete')) {
    setInput(input, rule.aliases[0]);
    input.blur();
    await delay(400);
    return ruleMatches(currentText(item), rule);
  }
  // Element UI 会把下拉选项弹到 body 下，不能只在字段容器里查找。
  document.body.click();
  await delay(250);
  input.click();
  const option = await waitFor(() => {
    const matches = [...document.querySelectorAll<HTMLElement>('.el-select-dropdown__item')]
      .filter(candidate => isVisible(candidate)
        && (rule.label === '运费模板'
          ? shippingTemplateMatches(candidate.innerText, rule.aliases)
          : aliasesMatch(candidate.innerText, rule.aliases)));
    return matches.length === 1 ? matches[0] : null;
  });
  if (!option) { input.blur(); document.body.click(); return false; }
  option.click();
  await delay(400);
  return ruleMatches(currentText(item), rule);
}

async function syncSizes(): Promise<boolean | null> {
  if (sizesMatch()) return false;
  const trigger = [...document.querySelectorAll<HTMLElement>('#priceForm *')].find(e => e.children.length === 0 && e.innerText.trim() === '请选择尺寸');
  if (!trigger) return null;
  trigger.click();
  const dialog = await waitFor(() => document.querySelector<HTMLElement>('.el-dialog[aria-label="请选择尺寸"]'));
  if (!dialog) return null;
  const labels = [...dialog.querySelectorAll<HTMLElement>('.el-checkbox')];
  if (!SIZES.every(size => labels.some(e => e.innerText.trim() === size))) { clickText(dialog, '关闭'); return null; }
  for (const label of labels) {
    const input = label.querySelector<HTMLInputElement>('input');
    if (input && input.checked !== SIZES.includes(label.innerText.trim())) { label.click(); await delay(40); }
  }
  clickText(dialog, '确定');
  await delay(600);
  return sizesMatch() ? true : null;
}

function sizesMatch(): boolean {
  const form = document.querySelector<HTMLElement>('#priceForm');
  if (!form) return false;
  const boxes = [...form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const selected = boxes
    .filter((input) => input.checked)
    .map((input) => input.closest<HTMLElement>('.el-checkbox')?.innerText.trim() ?? '')
    .filter((label) => /^(?:X{0,3}S|[SML]|X{1,3}L|[4-8]XL|One Size)$/.test(label));
  return SIZES.every((size) => selected.includes(size)) && selected.length === SIZES.length;
}

function skuStatus(): { count: number } {
  const table = document.querySelector<HTMLElement>('#priceForm table.light-table');
  if (!table) return { count: 0 };
  const headers = [...table.querySelectorAll<HTMLElement>('thead th')];
  const skuIndex = headers.findIndex((th) => th.innerText.includes('商品编码'));
  if (skuIndex < 0) return { count: 0 };
  const rows = [...table.querySelectorAll('tbody tr')];
  return { count: rows.filter((row) => Boolean(cellAt(row, skuIndex)?.querySelector('input')?.value.trim())).length };
}

function firstProductPhoto(): { width: number; height: number; src: string } | null {
  const imgs = [...document.querySelectorAll<HTMLImageElement>('.productClass img')]
    .filter((img) => /aliexpress-media\.com/i.test(img.currentSrc || img.src) && img.naturalWidth > 0);
  const first = imgs[0];
  return first ? { width: first.naturalWidth, height: first.naturalHeight, src: first.currentSrc || first.src } : null;
}

function isVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (current.hidden || current.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  }
  return true;
}

function visibleSelectOptions(): Array<{ element: HTMLElement; text: string }> {
  return [...document.querySelectorAll<HTMLElement>('.el-select-dropdown__item')]
    .filter(element => isVisible(element) && !element.classList.contains('is-disabled'))
    .map(element => ({ element, text: (element.innerText || element.textContent || '').trim() }))
    .filter(option => option.text.length > 0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve, reject) => setTimeout(() => { try { assertSameProduct(); resolve(); } catch (error) { reject(error); } }, ms));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}


async function waitFor<T>(read: () => T | null | undefined, timeout = 3000): Promise<T | null> {
  const until = Date.now() + timeout;
  do { assertSameProduct(); const value = read(); if (value) return value; await delay(100); } while (Date.now() < until);
  return null;
}

function setInput(input: HTMLInputElement, value: string): void {
  assertSameProduct();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
}

function visibleDialog(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('.el-dialog')].find(isVisible) ?? null;
}

function clickText(scope: HTMLElement | null, text: string): void {
  assertSameProduct();
  const normalize = (value: string) => value.replace(/\s+/g, '').trim();
  const target = [...(scope?.querySelectorAll<HTMLElement>('button,.button,.handle-button,.el-button,[role="button"]') || [])]
    .find(e => normalize(e.innerText || e.textContent || '') === normalize(text) && isVisible(e));
  if (!target) throw new Error(`未找到“${text}”按钮`);
  target.click();
}

async function generateSku(prefix: string): Promise<void> {
  const link = [...document.querySelectorAll<HTMLElement>('#priceForm [title="设置自动生成编码的规则"]')].find(e => e.innerText.trim() === '自动生成');
  if (!link) throw new Error('未找到 ERP 自动生成入口');
  link.click();
  const input = await waitFor(() => document.querySelector<HTMLInputElement>('#codePreInput input'));
  if (!input) throw new Error('商品编码前缀窗口未出现');
  setInput(input, prefix);
  clickText(input.closest<HTMLElement>('.message-dialog'), '确定');
  await delay(400);
}

/** 使用新版尺码表并精确选择 tshirt，不按列表顺序猜模板。 */
async function selectFirstSizeChart(): Promise<string> {
  const versionButtons = [...document.querySelectorAll<HTMLElement>('#descriptionForm .el-radio-button, #descriptionForm .el-radio')];
  const newer = versionButtons.find(e => e.innerText.trim() === '新版');
  if (!newer) return '尺码表：未找到新版入口，请检查';
  if (!newer.classList.contains('is-active') && !newer.classList.contains('is-checked')) { newer.click(); await delay(350); }
  const input = document.querySelector<HTMLInputElement>('#descriptionForm input[placeholder="请选择尺码模板"]');
  if (!input) return '尺码表：未识别选择控件，请检查';
  document.body.click();
  await delay(250);
  input.focus();
  input.click();
  const option = await waitFor(() => {
    const normalize = (text: string) => text.toLocaleLowerCase().replace(/[\s_-]/g, '');
    const exact = [...document.querySelectorAll<HTMLElement>(
      '.el-select-dropdown__item, .el-autocomplete-suggestion li, [role="option"], li'
    )].filter(element => isVisible(element) && normalize(element.innerText || element.textContent || '') === 'tshirt');
    if (exact.length) return exact[0];
    // 该 ERP 页面把新版尺码模板作为普通提示列表渲染，没有 Element UI 的下拉项 class。
    return [...document.querySelectorAll<HTMLElement>('body *')]
      .filter(element => isVisible(element) && element.children.length === 0 && normalize(element.innerText || element.textContent || '') === 'tshirt')
      .sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height)[0] || null;
  }, 5000);
  if (!option) { document.body.click(); return '尺码表：新版模板列表中没有 tshirt，请检查'; }
  const name = (option.innerText || option.textContent || '').trim();
  option.click();
  await delay(300);
  const sync = [...document.querySelectorAll<HTMLElement>('#descriptionForm button, #descriptionForm .button, #descriptionForm [role="button"]')]
    .find(element => element.innerText.trim() === '同步' && isVisible(element));
  if (!sync) return '尺码表：已找到 tshirt，但未找到同步按钮，请检查';
  const syncButton = sync as HTMLButtonElement;
  if (syncButton.disabled) return '尺码表：tshirt 已选中，但同步按钮不可用，请检查';
  syncButton.click();
  await delay(500);
  const versionStillNew = newer.classList.contains('is-active') || newer.classList.contains('is-checked');
  return input.value.toLocaleLowerCase().replace(/[\s_-]/g, '') === name.toLocaleLowerCase().replace(/[\s_-]/g, '') && versionStillNew
    ? `尺码表：新版已选择并同步 ${name}`
    : '尺码表：新版选择结果未确认，请检查';
}

/** 使用 ERP 原生转换和预览确认，把 PC 原文复制到无线详情。 */
async function importPcToWireless(): Promise<string> {
  const frame = document.querySelector<HTMLIFrameElement>('#descriptionForm iframe.cke_wysiwyg_frame');
  let before: string | undefined;
  try { before = frame?.contentDocument?.body?.innerHTML; } catch { /* 编辑器尚未就绪时留给用户检查。 */ }
  if (!before?.trim()) return '无线详情：PC 编辑器未就绪或原文为空，未导入';
  const trigger = [...document.querySelectorAll<HTMLElement>('#descriptionForm .button')]
    .find(e => e.innerText.trim().toLowerCase() === '导入pc端描述');
  if (!trigger) return '无线详情：未找到导入 PC 端描述入口';
  trigger.click();
  const dialog = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('.seeData-dialog[aria-label="导入PC端详描预览"]');
    return el && isVisible(el) ? el : null;
  }, 10000);
  if (!dialog) throw new Error('无线详情导入预览未出现，请检查页面');
  const preview = await waitFor(() => dialog.querySelector('.drag-right .content-contain'), 10000);
  if (!preview) {
    clickText(dialog, '取消');
    return '无线详情：ERP 未生成可导入内容，已取消';
  }
  const previewContent = mobileContentSignature(dialog.querySelector<HTMLElement>('.drag-right'));
  clickText(dialog, '确定');
  const imported = await waitFor(() => {
    const mobile = document.querySelector<HTMLElement>('#descriptionForm .drag-right');
    const blocks = mobile?.querySelectorAll('.content-contain');
    return !isVisible(dialog) && blocks?.length && mobileContentSignature(mobile) === previewContent ? blocks.length : null;
  }, 10000);
  if (!imported) throw new Error('无线详情导入结果未确认，请检查页面');
  if (frame?.contentDocument?.body?.innerHTML !== before) throw new Error('PC 原文发生变化，请检查详情描述');
  return `无线详情：已导入 PC 端描述并确认，共 ${imported} 个内容块；PC 原文未改写`;
}

function mobileContentSignature(container: HTMLElement | null): string {
  return JSON.stringify([...(container?.querySelectorAll<HTMLElement>('.content-contain') || [])].map(block => {
    const content = block.querySelector<HTMLElement>('.my') || block;
    return { text: content.textContent?.trim(), images: [...content.querySelectorAll('img')].map(image => image.getAttribute('src')) };
  }));
}

/** 内容完整时必须点击确定，才能把 ERP 返回的海关配置写入当前表单。 */
async function configureCustoms(): Promise<string> {
  const item = findItem('海关监管属性');
  const trigger = item?.querySelector<HTMLButtonElement>('button');
  if (!trigger) return '海关监管属性：未识别设置入口，请检查';
  trigger.click();
  const dialog = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('.el-dialog[aria-label="添加海关监管属性"]');
    return el && isVisible(el) ? el : null;
  });
  if (!dialog) return '海关监管属性：窗口未加载，请检查';
  const confirm = () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(e => e.innerText.replace(/\s/g, '') === '确定');
  const complete = await waitFor(() => dialog.innerText.includes('无需补充') && confirm() && !confirm()!.disabled || null, 8000);
  if (complete) {
    confirm()!.click();
    const configured = await waitFor(() => !isVisible(dialog) && findItem('海关监管属性')?.innerText.includes('已配置') || null, 8000);
    if (!configured) throw new Error('海关确认后未显示“已配置”，请检查页面');
    return '海关监管属性：已打开设置并点击确定，表单已显示“已配置”';
  }
  const cancel = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(e => e.innerText.replace(/\s/g, '') === '取消');
  cancel?.click();
  return '海关监管属性：ERP 尚有待核对内容，未确认；请打开设置检查缺项';
}

async function fillSkuAndPacking(): Promise<string> {
  const table = document.querySelector<HTMLTableElement>('#priceForm table.light-table');
  if (!table) return '价格/库存：未识别 SKU 表格';
  const headings = [...table.querySelectorAll<HTMLElement>('th')].map(e => e.innerText);
  const skuDimensions = splitValue('skuDimensions', ['20', '20', '2']);
  const rules: [string, string[], string][] = [
    ['零售价', [value('price', '85')], 'price'], ['货值', [value('cargoValue', '45')], 'cargoValue'],
    ['库存', [value('inventory', '999')], 'inventory'], ['重量', [value('skuWeight', '0.22')], 'skuWeight'],
    ['尺寸（cm）', skuDimensions, 'skuDimensions'],
  ];
  const rows = [...table.querySelectorAll<HTMLTableRowElement>('tbody tr')];
  for (const row of rows) {
    for (const [heading, values, id] of rules) {
      if (!enabled(id)) continue;
      const index = headings.findIndex(e => e.includes(heading));
      if (index < 0) continue;
      const inputs = [...(cellAt(row, index)?.querySelectorAll<HTMLInputElement>('input') || [])];
      values.forEach((value, i) => { if (inputs[i]) setInput(inputs[i], value); });
    }
    const boxIndex = headings.findIndex(e => e.includes('是否原箱'));
    const boxCell = boxIndex >= 0 ? cellAt(row, boxIndex) : null;
    if (boxCell) await chooseOption(boxCell, { label: '是否原箱', aliases: ['是'] });
  }
  const weightInput = formInputs('包装后重量')[0];
  if (weightInput && enabled('packageWeight')) setInput(weightInput, value('packageWeight', '0.22'));
  const packageDimensions = splitValue('packageDimensions', ['15', '15', '2']);
  const dimensionInputs = formInputs('包装后尺寸');
  for (const [index, input] of dimensionInputs.slice(0, 3).entries()) {
    if (enabled('packageDimensions') && packageDimensions[index]) setInput(input, packageDimensions[index]);
  }
  await delay(300);
  return `价格/库存：已处理 ${rows.length} 行，包裹参数已填充`;
}

/** 批量报告读取表单实际值，不用“点击过按钮”代替填写成功。 */
function skuAndPackingIssues(): string[] {
  const issues: string[] = [];
  const table = document.querySelector<HTMLTableElement>('#priceForm table.light-table');
  const headings = [...(table?.querySelectorAll<HTMLElement>('thead th') || [])].map(e => e.innerText);
  for (const [heading, expected, id] of [
    ['零售价', [value('price', '85')], 'price'], ['货值', [value('cargoValue', '45')], 'cargoValue'],
    ['库存', [value('inventory', '999')], 'inventory'], ['重量', [value('skuWeight', '0.22')], 'skuWeight'],
    ['尺寸（cm）', splitValue('skuDimensions', ['20', '20', '2']), 'skuDimensions'], ['是否原箱', ['是'], 'box'],
  ] as [string, string[], string][]) {
    if (id !== 'box' && !enabled(id)) continue;
    const index = headings.findIndex(e => e.includes(heading));
    const rows = [...(table?.querySelectorAll('tbody tr') || [])];
    if (index < 0 || !rows.length || rows.some(row => {
      const inputs = skuInputs(cellAt(row, index));
      return expected.some((value, i) => !inputs[i] || (heading === '是否原箱' ? inputs[i].value.trim() !== value : Number(inputs[i].value) !== Number(value)));
    })) issues.push(`SKU ${heading}：部分行未符合目标值`);
  }
  const weight = formInputs('包装后重量')[0];
  if (enabled('packageWeight') && (!weight || Number(weight.value) !== Number(value('packageWeight', '0.22')))) issues.push(`包装后重量未符合 ${value('packageWeight', '0.22')}kg`);
  const packageDimensions = splitValue('packageDimensions', ['15', '15', '2']).map(Number);
  const dimensionInputs = formInputs('包装后尺寸');
  const axes = ['长', '宽', '高'];
  for (const [index, input] of dimensionInputs.slice(0, 3).entries()) {
    if (enabled('packageDimensions') && (!input || Number(input.value) !== packageDimensions[index])) issues.push(`包装后尺寸${axes[index]}未符合 ${packageDimensions[index]}`);
  }
  if (enabled('packageDimensions') && dimensionInputs.length < 3) issues.push('包装后尺寸未识别到长、宽、高三个输入框');
  return issues;
}

function formInputs(label: string): HTMLInputElement[] {
  const visibleInputs = (scope: ParentNode | null | undefined) => [...(scope?.querySelectorAll<HTMLInputElement>('input') || [])]
    .filter(input => input.type !== 'hidden' && !input.disabled && isVisible(input));
  const direct = findItem(label);
  if (direct) return visibleInputs(direct);

  const form = document.querySelector<HTMLElement>('#packingForm');
  if (!form) return [];
  const normalize = (text: string) => text.replace(/[\s（）()：:]/g, '').toLocaleLowerCase();
  const item = [...form.querySelectorAll<HTMLElement>('.el-form-item')].find(candidate => {
    const itemLabel = candidate.querySelector<HTMLElement>('.el-form-item__label')?.innerText || '';
    return normalize(itemLabel).includes(normalize(label));
  });
  if (item) return visibleInputs(item);

  const candidates = visibleInputs(form);
  const fieldText = (input: HTMLInputElement) => [input.placeholder, input.getAttribute('aria-label') || '', input.title,
    input.closest<HTMLElement>('.el-form-item')?.innerText || ''].join(' ');
  if (label === '包装后重量') {
    return candidates.filter(input => /包装.*重量|重量.*包装|package.*weight/i.test(fieldText(input))).slice(0, 1);
  }
  if (label === '包装后尺寸') {
    const axisPatterns = [/长|长度|length/i, /宽|宽度|width/i, /高|高度|height/i];
    const matched = axisPatterns.map(pattern => candidates.find(input => pattern.test(fieldText(input))));
    if (matched.every((input): input is HTMLInputElement => Boolean(input))) return matched;
    return candidates.filter(input => /包装.*尺寸|尺寸.*包装|长（?cm|宽（?cm|高（?cm/i.test(fieldText(input))).slice(0, 3);
  }
  return [];
}
