/** 注入采集按钮与提示的 UI 层(样式内联,避免额外 CSS 构建)。 */

const STYLE_ID = 'joom-collector-style';

export function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .joom-collect-btn {
      position: absolute; top: 8px; right: 8px; z-index: 99999;
      background: #ff4747; color: #fff; border: none; border-radius: 6px;
      padding: 5px 10px; font-size: 12px; font-weight: 600; cursor: pointer;
      box-shadow: 0 2px 6px rgba(0,0,0,.2); line-height: 1.2;
      font-family: -apple-system, system-ui, sans-serif;
    }
    .joom-collect-btn:hover { background: #e63636; }
    .joom-collect-btn:disabled { opacity: .6; cursor: default; }
    .joom-collect-float {
      position: fixed; right: 20px; bottom: 90px; z-index: 100000;
      background: #ff4747; color: #fff; border: none; border-radius: 24px;
      padding: 12px 20px; font-size: 14px; font-weight: 700; cursor: grab;
      box-shadow: 0 4px 16px rgba(0,0,0,.25);
      font-family: -apple-system, system-ui, sans-serif;
      touch-action: none; user-select: none; -webkit-user-select: none;
    }
    .joom-collect-float.dragging { cursor: grabbing; }
    .joom-toast {
      position: fixed; left: 50%; top: 24px; transform: translateX(-50%);
      z-index: 100001; padding: 10px 18px; border-radius: 8px; color: #fff;
      font-size: 14px; font-family: -apple-system, system-ui, sans-serif;
      box-shadow: 0 4px 16px rgba(0,0,0,.25); opacity: 0; transition: opacity .2s;
    }
    .joom-toast.show { opacity: 1; }
    .joom-toast.ok { background: #16a34a; }
    .joom-toast.err { background: #dc2626; }
    .joom-card-ck {
      position: absolute; top: 8px; left: 8px; z-index: 99999;
      width: 30px; height: 30px; background: #fff;
      border: 2px solid #ff4747; border-radius: 7px;
      box-shadow: 0 2px 6px rgba(0,0,0,.3);
      display: flex; align-items: center; justify-content: center; cursor: pointer;
    }
    .joom-card-ck.on { background: #ff4747; }
    .joom-card-ck .tick { width: 16px; height: 16px; border-radius: 3px; }
    .joom-card-ck.on .tick { color: #fff; font-weight: 900; }
    .joom-batchbar {
      position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
      z-index: 100001; display: flex; align-items: center; gap: 12px;
      background: #1f2937; color: #fff; padding: 10px 16px; border-radius: 12px;
      box-shadow: 0 6px 24px rgba(0,0,0,.35);
      font-family: -apple-system, system-ui, sans-serif; font-size: 13px;
      touch-action: none;
    }
    .joom-batchbar .jb-title { font-weight: 700; color: #fca5a5; cursor: move; user-select: none; }
    .joom-batchbar .jb-collapse { padding: 4px 8px; font-size: 16px; line-height: 1; cursor: pointer; }
    .joom-batchbar.collapsed { left: auto; right: 20px; top: auto; bottom: 20px; transform: none; padding: 8px 10px; border-radius: 10px; cursor: move; }
    .joom-batchbar.collapsed > :not(.jb-collapse) { display: none; }
    .joom-batchbar.collapsed .jb-collapse { display: block; }
    .joom-batchbar .jb-count { color: #d1d5db; }
    .joom-batchbar .jb-status { color: #86efac; min-width: 0; }
    .joom-batchbar .jb-template { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .joom-batchbar .jb-template-label { color: #d1d5db; white-space: nowrap; }
    .joom-batchbar .jb-template-select {
      max-width: 170px; min-width: 100px; border: 1px solid #818cf8; border-radius: 7px;
      padding: 6px 26px 6px 9px; background: #eef2ff; color: #312e81; font-size: 12px;
      font-weight: 700; cursor: pointer; outline: none;
    }
    .joom-batchbar .jb-template-select:focus { box-shadow: 0 0 0 2px rgba(129,140,248,.35); }
    .joom-batchbar .jb-template-select:disabled { opacity: .65; cursor: wait; }
    .joom-batchbar .jb-template-select.unpicked { border-color: #6b7280; background: #374151; color: #e5e7eb; font-weight: 600; }
    .joom-batchbar .jb-template-select.picked { border-color: #fbbf24; background: #fef3c7; color: #78350f; box-shadow: 0 0 0 2px rgba(251,191,36,.35); }
    @media (max-width: 900px) {
      .joom-batchbar { gap: 7px; padding: 9px 11px; }
      .joom-batchbar .jb-template-select { max-width: 145px; }
    }
    @media (max-width: 680px) {
      .joom-batchbar:not(.collapsed) { left: 10px; right: 10px; bottom: 10px; transform: none; flex-wrap: wrap; }
      .joom-batchbar:not(.collapsed) .jb-status { flex-basis: 100%; }
    }
    .joom-batchbar button {
      border: none; border-radius: 7px; padding: 6px 12px; font-size: 13px; cursor: pointer;
      background: #374151; color: #fff; font-weight: 600;
    }
    .joom-batchbar button:hover { background: #4b5563; }
    .joom-batchbar button.primary { background: #ff4747; }
    .joom-batchbar button.primary:hover { background: #e63636; }
    .joom-batchbar button:disabled { opacity: .55; cursor: default; }
  `;
  document.head.appendChild(style);
}

/** 给卡片注入多选复选框(左上角)。返回可外部更新勾选态的句柄。 */
export function attachCardCheckbox(
  card: HTMLElement,
  checked: boolean,
  onToggle: (checked: boolean) => void,
): { set: (v: boolean) => void } {
  ensureStyles();
  if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
  const wrap = document.createElement('div'); // 用 div 而非 label,自行管理勾选态
  wrap.className = 'joom-card-ck' + (checked ? ' on' : '');
  const tick = document.createElement('span');
  tick.className = 'tick';
  tick.textContent = checked ? '✓' : '';
  wrap.appendChild(tick);
  let on = checked;
  const render = () => {
    wrap.classList.toggle('on', on);
    tick.textContent = on ? '✓' : '';
  };
  // 卡片是 <a>,必须阻止默认跳转 + 冒泡,再手动切换选中态
  const handler = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    on = !on;
    render();
    onToggle(on);
  };
  wrap.addEventListener('click', handler, true);
  wrap.addEventListener('mousedown', (e) => e.stopPropagation(), true);
  card.appendChild(wrap);
  return {
    set: (v: boolean) => {
      on = v;
      render();
    },
  };
}

export interface BatchBarHandlers {
  onSelectAll: () => void;
  onClear: () => void;
  onCollectSelected: () => void;
  onCollectPage: () => void;
  onStop: () => void;
}

export interface BatchBar {
  setCount: (n: number) => void;
  setStatus: (t: string) => void;
  setBusy: (b: boolean) => void;
  setTemplates: (templates: PresetOption[]) => void;
  /** 用户主动选的模板；「不指定」时为 undefined，由服务端推荐。 */
  getTemplateId: () => string | undefined;
}

export interface PresetOption {
  id: string;
  name: string;
}

type FloatingPosition = { left: number; top: number };

function readFloatingPosition(key: string): FloatingPosition | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null') as Partial<FloatingPosition> | null;
    return Number.isFinite(value?.left) && Number.isFinite(value?.top) ? { left: value!.left!, top: value!.top! } : null;
  } catch {
    return null;
  }
}

function writeFloatingPosition(key: string, rect: DOMRect): void {
  try {
    localStorage.setItem(key, JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) }));
  } catch {
    /* 页面禁用 localStorage 时仍可正常拖动 */
  }
}

function clampFloatingPosition(el: HTMLElement, position: FloatingPosition): FloatingPosition {
  return {
    left: Math.min(Math.max(0, position.left), Math.max(0, window.innerWidth - el.offsetWidth)),
    top: Math.min(Math.max(0, position.top), Math.max(0, window.innerHeight - el.offsetHeight)),
  };
}

function restoreFloatingPosition(el: HTMLElement, key: string): void {
  const saved = readFloatingPosition(key);
  if (!saved) return;
  const position = clampFloatingPosition(el, saved);
  el.style.left = `${position.left}px`;
  el.style.top = `${position.top}px`;
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  el.style.transform = 'none';
}

function makeFloatingDraggable(el: HTMLElement, key: string, handle: HTMLElement = el): void {
  restoreFloatingPosition(el, key);
  let drag: { offsetX: number; offsetY: number; startX: number; startY: number; moved: boolean } | null = null;
  let suppressClick = false;

  handle.addEventListener('pointerdown', (e) => {
    const control = e.target instanceof HTMLElement ? e.target.closest('button, select, input, textarea') : null;
    if (e.button !== 0 || (control && control !== el)) return;
    const rect = el.getBoundingClientRect();
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.transform = 'none';
    drag = {
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    el.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const movedX = Math.abs(e.clientX - drag.startX);
    const movedY = Math.abs(e.clientY - drag.startY);
    if (movedX > 3 || movedY > 3) drag.moved = true;
    const position = clampFloatingPosition(el, { left: e.clientX - drag.offsetX, top: e.clientY - drag.offsetY });
    el.style.left = `${position.left}px`;
    el.style.top = `${position.top}px`;
  });
  const endDrag = () => {
    if (!drag) return;
    suppressClick = drag.moved;
    drag = null;
    el.classList.remove('dragging');
    if (suppressClick) window.setTimeout(() => (suppressClick = false), 0);
    writeFloatingPosition(key, el.getBoundingClientRect());
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  el.addEventListener('click', (e) => {
    if (!suppressClick) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    suppressClick = false;
  }, true);
  window.addEventListener('resize', () => {
    const rect = el.getBoundingClientRect();
    const position = clampFloatingPosition(el, { left: rect.left, top: rect.top });
    el.style.left = `${position.left}px`;
    el.style.top = `${position.top}px`;
    if (el.style.left || el.style.top) writeFloatingPosition(key, el.getBoundingClientRect());
  });
}

/** 底部批量采集操作条。 */
export function createBatchBar(h: BatchBarHandlers, label = 'Joom'): BatchBar {
  ensureStyles();
  const bar = document.createElement('div');
  bar.className = 'joom-batchbar';
  const mk = (cls: string, text: string, primary = false) => {
    const b = document.createElement('button');
    b.className = primary ? 'primary' : '';
    b.dataset.cls = cls;
    b.textContent = text;
    return b;
  };
  const title = document.createElement('span');
  title.className = 'jb-title';
  title.textContent = `${label} 批量采集`;
  const count = document.createElement('span');
  count.className = 'jb-count';
  count.textContent = '已选 0';
  const templateWrap = document.createElement('span');
  templateWrap.className = 'jb-template';
  const templateLabel = document.createElement('span');
  templateLabel.className = 'jb-template-label';
  templateLabel.textContent = '预设';
  const templateSelect = document.createElement('select');
  templateSelect.className = 'jb-template-select unpicked';
  templateSelect.title = '整页同一类时选对应模板：核对没有矛盾的入库直接算已确认。页面混杂就保持「不指定」，入库后系统推荐，到采集箱分拣。';
  templateSelect.setAttribute('aria-label', '选择采集预设模板');
  templateSelect.disabled = true;
  const loadingOption = document.createElement('option');
  loadingOption.value = '';
  loadingOption.textContent = '加载模板…';
  templateSelect.appendChild(loadingOption);
  templateWrap.append(templateLabel, templateSelect);
  const allBtn = mk('all', '全选本页');
  const clearBtn = mk('clear', '清空');
  const selBtn = mk('sel', '采集选中', true);
  const pageBtn = mk('page', '采集本页', true);
  const stopBtn = mk('stop', '■ 停止');
  stopBtn.style.display = 'none';
  stopBtn.style.background = '#b91c1c';
  const status = document.createElement('span');
  status.className = 'jb-status';
  const collapseBtn = mk('collapse', '−');
  collapseBtn.className += ' jb-collapse';
  collapseBtn.title = '收起采集栏';
  collapseBtn.setAttribute('aria-label', '收起采集栏');
  bar.append(title, count, templateWrap, allBtn, clearBtn, selBtn, pageBtn, stopBtn, status, collapseBtn);
  document.body.appendChild(bar);
  allBtn.addEventListener('click', h.onSelectAll);
  clearBtn.addEventListener('click', h.onClear);
  selBtn.addEventListener('click', h.onCollectSelected);
  pageBtn.addEventListener('click', h.onCollectPage);
  stopBtn.addEventListener('click', h.onStop);
  collapseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const collapsed = bar.classList.toggle('collapsed');
    collapseBtn.textContent = collapsed ? '+' : '−';
    collapseBtn.title = collapsed ? '展开采集栏' : '收起采集栏';
    collapseBtn.setAttribute('aria-label', collapseBtn.title);
  });

  // 标题栏和收起后的小面板都可拖动，并记住位置。
  makeFloatingDraggable(bar, 'joom-collector.batchbar', bar);
  const actionBtns = [allBtn, clearBtn, selBtn, pageBtn];
  let collectionBusy = false;
  const refreshDisabledState = () => {
    actionBtns.forEach((x) => (x.disabled = collectionBusy));
    templateSelect.disabled = collectionBusy || templateSelect.options.length <= 1;
  };
  // 默认「不指定」：没有主动选择时，不能把默认模板当成用户的判断。
  // 选择只在当前页面内保留（翻页、懒加载不丢），换页面重新回到「不指定」。
  let selectedTemplateId: string | undefined;
  const renderTemplateChoice = () => {
    templateSelect.classList.toggle('picked', Boolean(selectedTemplateId));
    templateSelect.classList.toggle('unpicked', !selectedTemplateId);
  };
  templateSelect.addEventListener('change', () => {
    selectedTemplateId = templateSelect.value || undefined;
    renderTemplateChoice();
    const name = templateSelect.selectedOptions[0]?.textContent ?? '';
    status.textContent = selectedTemplateId
      ? `已选「${name}」：核对没有矛盾的入库直接算已确认`
      : '不指定：入库后系统推荐模板，到采集箱分拣';
  });
  return {
    setCount: (n) => {
      count.textContent = `已选 ${n}`;
      selBtn.textContent = `采集选中(${n})`;
    },
    setStatus: (t) => (status.textContent = t),
    setBusy: (b) => {
      collectionBusy = b;
      refreshDisabledState();
      stopBtn.style.display = b ? '' : 'none';
      stopBtn.disabled = false;
    },
    setTemplates: (templates) => {
      // 已选的模板被删除时退回「不指定」，不替用户换成别的模板。
      const preferred = selectedTemplateId && templates.some((t) => t.id === selectedTemplateId) ? selectedTemplateId : undefined;
      if (selectedTemplateId && !preferred) status.textContent = '之前选的模板已被删除，已改为「不指定」';
      templateSelect.replaceChildren();
      const unpicked = document.createElement('option');
      unpicked.value = '';
      unpicked.textContent = templates.length ? '不指定 · 到采集箱再定' : '不指定 · 系统推荐';
      templateSelect.appendChild(unpicked);
      for (const template of templates) {
        const option = document.createElement('option');
        option.value = template.id;
        option.textContent = template.name;
        templateSelect.appendChild(option);
      }
      selectedTemplateId = preferred;
      templateSelect.value = preferred || '';
      templateSelect.disabled = collectionBusy || !templates.length;
      renderTemplateChoice();
    },
    getTemplateId: () => selectedTemplateId,
  };
}

export function toast(message: string, kind: 'ok' | 'err' = 'ok'): void {
  ensureStyles();
  const el = document.createElement('div');
  el.className = `joom-toast ${kind}`;
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 2200);
}

/** 给卡片注入按钮;onClick 返回 Promise 以驱动按钮 loading 态。 */
export function attachCardButton(card: HTMLElement, onClick: () => Promise<void>): void {
  ensureStyles();
  // 确保卡片可作为定位父级
  if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
  const btn = document.createElement('button');
  btn.className = 'joom-collect-btn';
  btn.textContent = '采集此产品';
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.disabled = true;
    btn.textContent = '采集中…';
    try {
      await onClick();
      btn.textContent = '✓ 已采集';
    } catch {
      btn.textContent = '采集此产品';
      btn.disabled = false;
    }
  });
  card.appendChild(btn);
}

export function attachFloatingButton(onClick: () => Promise<void>): void {
  ensureStyles();
  if (document.querySelector('.joom-collect-float')) return;
  const btn = document.createElement('button');
  btn.className = 'joom-collect-float';
  btn.title = '按住拖动可移动，单击采集当前商品';
  btn.textContent = '采集当前商品到 Joom';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = '采集中…';
    try {
      await onClick();
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  });
  document.body.appendChild(btn);
  makeFloatingDraggable(btn, 'joom-collector.current-product');
}
