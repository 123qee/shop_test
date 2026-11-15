import { Fragment, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useBlocker, useNavigate, useParams } from 'react-router-dom';
import type {
  CategoryRequirements,
  EditableProduct,
  EditableVariant,
  ProductRecord,
  ValidationIssue,
  AuditLogEntry,
  ImageCheckResult,
  JoomIssueDetail,
} from '@shared/types';
import { api } from '../api';
import { fallbackToAllegroOriginal, imagePreviewSource } from '../image-utils';
import { normCategories, type CatOption } from '../categories';
import { CategoryPicker } from '../CategoryPicker';
import { ConfirmPopover } from '../components/ConfirmPopover';
import { useNativePrompt } from '../components/NativePromptProvider';
import { ErrorSummary } from '../components/ErrorSummary';
import { DANGER_KINDS } from '../danger';
import {
  hasNonLatinListingText,
  normalizeJoomColorList,
  normalizeProductColors,
  suggestMappedColor,
} from '@shared/listing-language';
import { classifyJoomListing, JOOM_BUCKET_META } from '@shared/joom-listing';
import { QUALITY_GRADE_META, scoreProduct } from '@shared/quality';
import { summarizeJoomIssues } from '@shared/joom-review';
import { compareProductQueue, isUnpublished, productSku } from '../product-queue';
import { showFeedback } from '../feedback';

const STATUS_LABEL: Record<string, string> = {
  collected: '已采集',
  edited: '已编辑',
  publishing: '发布中',
  published: '已发布',
  failed: '发布失败',
  discarded: '废弃箱',
};

const VIDEO_STATUS_LABEL: Record<string, string> = {
  queued: '排队中', downloading: '缓存视频中', uploading: '上传 Joom 中', processing: 'Joom 处理中',
  ready: '等待 Joom 审核', approved: '审核通过，关联中', linked: '已关联商品', rejected: '审核未通过', failed: '视频发布失败',
};

const EDITOR_NAV = [
  { id: 'editor-basic', label: '基础信息', hint: '标题、SKU、品牌' },
  { id: 'editor-images', label: '商品图片', hint: '主图与附图' },
  { id: 'editor-variants', label: '变体与库存', hint: '颜色、尺码、价格' },
  { id: 'editor-attributes', label: '类目属性', hint: '必填属性与模板' },
  { id: 'editor-publish', label: '发布信息', hint: '店铺、类目、标签' },
  { id: 'editor-overview', label: '商品概览' },
  { id: 'editor-history', label: '操作记录' },
];

function EditorAnchorNav() {
  return (
    <nav className="anchor-nav editor-anchor" aria-label="商品编辑导航">
      <div className="anchor-nav-title">编辑导航</div>
      <div className="anchor-nav-list">
        {EDITOR_NAV.map((item, index) => (
          <a href={`#${item.id}`} key={item.id}>
            <span className="anchor-index">{String(index + 1).padStart(2, '0')}</span>
            <span><strong>{item.label}</strong>{item.hint && <small>{item.hint}</small>}</span>
          </a>
        ))}
      </div>
      <a className="anchor-top" href="#editor-top">↑ 回到顶部</a>
    </nav>
  );
}

const DEFAULT_VARIANT_SIZES = ['2XS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'];

function normalizeVariantAxis(value?: string): string {
  return (value ?? '').trim().toLowerCase();
}

function sortVariantSizes(sizes: string[]): string[] {
  const order = new Map(DEFAULT_VARIANT_SIZES.map((size, index) => [size.toLowerCase(), index]));
  return [...sizes].sort((a, b) => (order.get(a.toLowerCase()) ?? 999) - (order.get(b.toLowerCase()) ?? 999));
}

function uniqueVariantSku(productSku: string, color: string, size: string, existing: Set<string>): string {
  const part = (value: string) => value.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toUpperCase() || 'VALUE';
  const base = `${productSku}-${part(color)}-${part(size)}`.slice(0, 50);
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate.toLowerCase())) {
    const tail = `-${suffix++}`;
    candidate = `${base.slice(0, Math.max(1, 50 - tail.length))}${tail}`;
  }
  return candidate;
}

export function ProductEditor() {
  const nativePrompt = useNativePrompt();
  const blockerPromptOpen = useRef(false);
  const saveNavigationTarget = useRef<string | null>(null);
  const { id } = useParams();
  const navigate = useNavigate();
  const [record, setRecord] = useState<ProductRecord | null>(null);
  const [form, setForm] = useState<EditableProduct | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [publishJobId, setPublishJobId] = useState('');

  const [categories, setCategories] = useState<CatOption[]>([]);
  const [colors, setColors] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [newImage, setNewImage] = useState('');
  const [newVideo, setNewVideo] = useState('');
  const [openRow, setOpenRow] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ src: string; x: number; y: number } | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null);
  const [requirements, setRequirements] = useState<CategoryRequirements | null>(null);
  const [templates, setTemplates] = useState<Array<{ id: string; name: string }>>([]);
  const [attributeTemplates, setAttributeTemplates] = useState<Array<{ id: string; name: string; categoryId?: string; attributes: Record<string, string> }>>([]);
  const [imageResults, setImageResults] = useState<ImageCheckResult[] | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [matrixMode, setMatrixMode] = useState(false);
  const [colorMap, setColorMap] = useState<Record<string, string>>({});
  const [savedJson, setSavedJson] = useState('');
  const [presetApplied, setPresetApplied] = useState(false);
  const [queueIds, setQueueIds] = useState<string[]>([]);
  const [skuOwners, setSkuOwners] = useState<Map<string, string>>(new Map());
  const [batchVariantOpen, setBatchVariantOpen] = useState(false);
  const [batchColor, setBatchColor] = useState('');
  const [batchImage, setBatchImage] = useState('');
  const [batchSourceColor, setBatchSourceColor] = useState('');
  const [batchSizes, setBatchSizes] = useState<string[]>([]);
  const [batchImageUploading, setBatchImageUploading] = useState(false);

  const videoPreviewUrl = (assetId?: string, url?: string) => assetId
    ? `/api/media/videos/${encodeURIComponent(assetId)}`
    : (url || '');

  useEffect(() => {
    if (!id) return;
    saveNavigationTarget.current = null;
    let cancelled = false;
    setPublishJobId('');
    setPresetApplied(false);
    api.listPublishJobs().then((jobs) => {
      if (cancelled) return;
      const active = jobs.find((job) => job.items.some((item) => item.productId === id && (item.status === 'queued' || item.status === 'running')));
      if (active) setPublishJobId(active.id);
    }).catch(() => {});
    api
      .getProduct(id)
      .then(({ record, editable }) => {
        setRecord(record);
        setForm(editable);
        setSavedJson(JSON.stringify(editable));
      })
      .catch((e) => setError((e as Error).message));
    api.listProducts().then((list) => {
      const unpublished = list.filter((p) => isUnpublished(p.status)).sort(compareProductQueue);
      const all = [...list].sort(compareProductQueue);
      const current = list.find((p) => p.id === id);
      const queue = current && isUnpublished(current.status) ? unpublished : all;
      setQueueIds(queue.map((p) => p.id));
      const map = new Map<string, string>();
      for (const p of list) {
        const sku = productSku(p);
        if (sku && p.id !== id) map.set(sku.toLowerCase(), p.id);
      }
      setSkuOwners(map);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (!id || !publishJobId) return;
    let cancelled = false;
    const check = async () => {
      try {
        const job = await api.getPublishJob(publishJobId);
        if (cancelled) return;
        const item = job.items.find((entry) => entry.productId === id);
        if (!item || item.status === 'queued' || item.status === 'running') return;
        const latest = await api.getProduct(id);
        if (cancelled) return;
        setRecord(latest.record);
        if (item.status === 'failed') { setError(item.error || '发布失败'); setMsg(''); }
        else { setError(''); setMsg(`发布成功，Joom 商品 id: ${item.joomProductId || latest.record.joomProductId || '—'}`); }
        setPublishJobId('');
      } catch (e) { if (!cancelled) setError((e as Error).message); }
    };
    void check();
    const timer = window.setInterval(() => void check(), 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [id, publishJobId]);

  useEffect(() => {
    if (!id || !record?.joomVideo || !['queued', 'downloading', 'uploading', 'processing', 'ready', 'approved'].includes(record.joomVideo.status)) return;
    const timer = window.setInterval(() => {
      api.getProduct(id).then(({ record: latest }) => setRecord(latest)).catch(() => {});
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [id, record?.joomVideo?.status]);

  // 类目/颜色需已连接 Joom,拉取失败则静默降级为手动输入
  useEffect(() => {
    api.joomCategories().then((d) => setCategories(normCategories(d))).catch(() => {});
    api.joomColors().then((d) => setColors(normalizeJoomColorList(d))).catch(() => {});
    api.getSettings().then((c) => {
      setTemplates(c.templates.map((t) => ({ id: t.id, name: t.name })));
      setAttributeTemplates(c.categoryAttributeTemplates ?? []);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const templateId = record?.templateId;
    api.getSettings().then((c) => {
      const tpl =
        (templateId && c.templates.find((t) => t.id === templateId)) ||
        c.templates.find((t) => t.id === c.activeId) ||
        c.templates[0];
      setColorMap(tpl?.defaults.colorMap ?? {});
    }).catch(() => {});
  }, [record?.templateId]);

  // 选中类目后拉取该类目的属性要求,动态渲染属性表单
  const categoryId = form?.categoryId;
  useEffect(() => {
    if (!categoryId) {
      setRequirements(null);
      return;
    }
    let cancelled = false;
    api
      .joomCategoryRequirements(categoryId)
      .then((r) => !cancelled && setRequirements(r))
      .catch(() => !cancelled && setRequirements(null));
    return () => {
      cancelled = true;
    };
  }, [categoryId]);

  useEffect(() => {
    if (id) api.auditLogs(id).then(setAuditLogs).catch(() => {});
  }, [id, record?.updatedAt]);

  const dirty = Boolean(form && savedJson && JSON.stringify(form) !== savedJson) || Boolean(presetApplied && !record?.templateConfirmed);
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirty && currentLocation.pathname !== nextLocation.pathname && nextLocation.pathname !== saveNavigationTarget.current,
  );
  useEffect(() => {
    if (blocker.state !== 'blocked' || blockerPromptOpen.current) return;
    blockerPromptOpen.current = true;
    void nativePrompt.confirm('有未保存的修改，离开后会丢失。确定离开？').then((leave) => {
      if (leave) blocker.proceed();
      else blocker.reset();
    }).finally(() => { blockerPromptOpen.current = false; });
  }, [blocker, nativePrompt]);
  const quality = form && record ? scoreProduct(form, record) : null;
  const queueIdx = id ? queueIds.indexOf(id) : -1;
  const prevId = queueIdx > 0 ? queueIds[queueIdx - 1] : undefined;
  const nextId = queueIdx >= 0 && queueIdx < queueIds.length - 1 ? queueIds[queueIdx + 1] : undefined;
  const dupSkuId = form?.sku?.trim() ? skuOwners.get(form.sku.trim().toLowerCase()) : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 's') return;
      e.preventDefault();
      if (!id || !form || busy) return;
      void (async () => {
        setBusy(true);
        setError('');
        setMsg('');
        try {
          const saved = await api.saveProduct(id, form, presetApplied);
          setRecord(saved);
          setSavedJson(JSON.stringify(form));
          setPresetApplied(false);
          setMsg('已保存');
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      })();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id, form, busy, presetApplied]);

  if (error && !form) return <div className="error"><ErrorSummary message={error} /></div>;
  if (!form || !record) return <p className="muted">加载中…</p>;

  const currentForm = form;
  const isPublished = Boolean(record.joomProductId);
  const reviewGroups = summarizeJoomIssues(record.joomIssueDetails, record.joomIssues);
  const patch = (p: Partial<EditableProduct>) => setForm({ ...form, ...p });

  // ---- 图片 ----
  const setMainImage = (idx: number) => {
    const imgs = [...form.images];
    const [pick] = imgs.splice(idx, 1);
    patch({ images: [pick, ...imgs] });
  };
  const removeImage = (idx: number) => patch({ images: form.images.filter((_, i) => i !== idx) });
  const showImagePreview = (src: string, event: MouseEvent) => setPreview({ src: imagePreviewSource(src), x: event.clientX, y: event.clientY });
  const addImage = () => {
    const url = newImage.trim();
    if (!url) return;
    patch({ images: [...form.images, url] });
    setNewImage('');
  };
  const addVideo = () => {
    const url = newVideo.trim();
    if (!url) return;
    patch({ video: { url } });
    setNewVideo('');
  };
  const moveImage = (idx: number, dir: -1 | 1) => {
    const next = idx + dir;
    if (next < 0 || next >= form.images.length) return;
    const imgs = [...form.images];
    [imgs[idx], imgs[next]] = [imgs[next], imgs[idx]];
    patch({ images: imgs });
  };
  const applyLogisticsToAll = () => {
    const src = form.variants[0];
    if (!src) return;
    patch({
      variants: form.variants.map((v, i) =>
        i === 0
          ? v
          : {
              ...v,
              msrPrice: src.msrPrice,
              declaredValue: src.declaredValue,
              shippingPrice: src.shippingPrice,
              shippingWeight: src.shippingWeight,
              shippingLength: src.shippingLength,
              shippingWidth: src.shippingWidth,
              shippingHeight: src.shippingHeight,
              committedFulfillmentDays: src.committedFulfillmentDays,
            },
      ),
    });
    setMsg('已把第一条变体的物流信息套用到全部变体，请检查后保存');
  };

  // ---- 标签 ----
  const addTag = () => {
    const t = tagInput.trim();
    if (!t || form.tags?.includes(t)) return setTagInput('');
    patch({ tags: [...(form.tags ?? []), t] });
    setTagInput('');
  };
  const removeTag = (t: string) => patch({ tags: (form.tags ?? []).filter((x) => x !== t) });

  // ---- 变体 ----
  const numOr = (s: string): number | undefined => (s === '' ? undefined : Number(s));
  const updateVariant = (i: number, p: Partial<EditableVariant>) =>
    patch({ variants: form.variants.map((v, idx) => (idx === i ? { ...v, ...p } : v)) });
  const removeVariant = async (i: number) => {
    if (
      isPublished &&
      !await nativePrompt.confirm('Joom 的“删除变体”是不可恢复操作。当前这里只会从待更新数据中移除，远端变体不会自动删除；确定继续吗？')
    ) {
      return;
    }
    patch({ variants: form.variants.filter((_, idx) => idx !== i) });
  };
  const addVariant = () =>
    patch({
      variants: [
        ...form.variants,
        { sku: `${form.sku}-${form.variants.length + 1}`, price: form.variants[0]?.price ?? 0, inventory: 999 },
      ],
    });

  const variantColors = Array.from(new Set(currentForm.variants.map((v) => v.colors?.trim()).filter(Boolean))) as string[];
  const variantSizes = sortVariantSizes(Array.from(new Set(currentForm.variants.map((v) => v.size?.trim()).filter(Boolean))) as string[]);
  const batchDuplicateSizes = new Set(
    currentForm.variants
      .filter((v) => normalizeVariantAxis(v.colors) === normalizeVariantAxis(batchColor))
      .map((v) => normalizeVariantAxis(v.size)),
  );
  const batchNewSizes = batchSizes.filter((size) => !batchDuplicateSizes.has(normalizeVariantAxis(size)));

  function openBatchVariant() {
    const sizes = variantSizes.length ? variantSizes : DEFAULT_VARIANT_SIZES;
    setBatchSizes(sizes);
    setBatchColor('');
    setBatchImage(currentForm.images[0] ?? '');
    setBatchSourceColor(variantColors[0] ?? '');
    setBatchVariantOpen(true);
  }

  function addBatchVariants() {
    const color = batchColor.trim();
    if (!color) return setError('请先填写新变体颜色');
    if (!batchImage.trim()) return setError('请选择商品图片或填写图片 URL');
    if (!batchNewSizes.length) return setError('所选颜色的尺码都已存在，无需重复添加');

    const sourceColor = normalizeVariantAxis(batchSourceColor);
    const sourceVariants = currentForm.variants.filter((v) => normalizeVariantAxis(v.colors) === sourceColor);
    const allSkus = new Set(currentForm.variants.map((v) => v.sku.trim().toLowerCase()));
    const additions = batchNewSizes.map((size) => {
      const source = sourceVariants.find((v) => normalizeVariantAxis(v.size) === normalizeVariantAxis(size))
        ?? currentForm.variants.find((v) => normalizeVariantAxis(v.size) === normalizeVariantAxis(size))
        ?? currentForm.variants[0];
      const sku = uniqueVariantSku(currentForm.sku, color, size, allSkus);
      allSkus.add(sku.toLowerCase());
      return {
        ...source,
        sku,
        colors: color,
        size,
        image: batchImage.trim(),
      };
    });
    patch({ variants: [...currentForm.variants, ...additions] });
    setBatchVariantOpen(false);
    setError('');
    setMsg(`已批量添加 ${color} ${additions.length} 个尺码变体，请检查后保存${isPublished ? '并更新 Joom' : ''}`);
  }

  async function uploadBatchImage(file?: File) {
    if (!file) return;
    setBatchImageUploading(true);
    setError('');
    try {
      const uploaded = await api.uploadImage(file);
      setBatchImage(uploaded.url);
      setMsg('图片已上传到 PICUI，可用于生成颜色变体');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBatchImageUploading(false);
    }
  }

  const colorOpts = { colorMap, officialColors: colors };
  function normalizeColors() {
    if (!form) return;
    const result = normalizeProductColors(form, colorOpts);
    patch({ variants: result.product.variants });
    if (result.unresolved.length) {
      setMsg(`已映射 ${result.mappedCount} 个颜色，自动补齐 ${result.defaultedCount} 个颜色；未识别：${result.unresolved.join('、')}。请补颜色映射或手动改成 Joom 英文色名。`);
    } else if (result.mappedCount || result.defaultedCount) {
      setMsg(`已映射 ${result.mappedCount} 个颜色，自动补齐 ${result.defaultedCount} 个颜色，请检查后保存${isPublished ? '并更新 Joom' : ''}`);
    } else {
      setMsg('颜色已是英文，无需映射');
    }
  }

  // ---- 类目属性(动态) ----
  const setAttr = (attrId: string, value: string) => {
    const next = { ...(form.attributes ?? {}) };
    if (value) next[attrId] = value;
    else delete next[attrId];
    patch({ attributes: next });
  };
  const isRequired = (sev: string) => sev.toLowerCase() === 'required';

  // ---- 敏感货 ----
  const dangerous = form.dangerInfo?.isDangerous ?? false;
  const dangerKinds = form.dangerInfo?.dangerKinds ?? [];
  const setDangerous = (on: boolean) => patch({ dangerInfo: { isDangerous: on, dangerKinds: on ? dangerKinds : undefined } });
  const toggleKind = (k: string) => {
    const next = dangerKinds.includes(k) ? dangerKinds.filter((x) => x !== k) : [...dangerKinds, k];
    patch({ dangerInfo: { isDangerous: true, dangerKinds: next } });
  };

  /** 手动套用当前模板预设(保留标题/SKU/品牌/标签/图片),不自动保存 */
  async function applyPreset() {
    if (!await nativePrompt.confirm('用当前模板重新套用预设?会刷新价格/库存/尺码/描述/类目/长宽高/敏感货等预设字段,保留你改过的标题、SKU、品牌、标签、图片。套用后请检查并保存。')) return;
    setBusy(true);
    setError('');
    setMsg('');
    try {
      const { editable } = await api.applyPreset(id!);
      setForm(editable);
      setPresetApplied(true);
      setIssues(null);
      setMsg('已套用预设,请检查后点「保存」');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<ProductRecord | null> {
    setBusy(true);
    setError('');
    setMsg('');
    try {
      const saved = await api.saveProduct(id!, form!, presetApplied);
      setRecord(saved);
      setSavedJson(JSON.stringify(form));
      setPresetApplied(false);
      setMsg('已保存');
      return saved;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function retryVideo() {
    setBusy(true);
    setError('');
    try {
      const latest = await api.retryProductVideo(id!);
      setRecord(latest);
      setMsg('已重新提交视频任务');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveAndNavigate(targetId: string | undefined) {
    if (!targetId || busy) return;
    const targetPath = `/products/${targetId}`;
    const saved = await save();
    if (!saved) return;
    // React may not have committed savedJson yet; allow this saved navigation.
    saveNavigationTarget.current = targetPath;
    navigate(targetPath);
  }

  /** 手动校验:保存后跑发布前校验,展示问题清单。 */
  async function runValidate(): Promise<ValidationIssue[] | null> {
    const saved = await save();
    if (!saved) return null;
    setBusy(true);
    setMsg('校验中(含图片可达性)…');
    try {
      const res = await api.validateProduct(id!);
      setIssues(res.issues);
      setMsg(res.ok ? (res.issues.length ? '校验通过(仅有提醒)' : '校验通过 ✓') : '');
      if (!res.ok) setError('');
      return res.issues;
    } catch (e) {
      setError((e as Error).message);
      setMsg('');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function changeTemplate(templateId: string) {
    if (!await nativePrompt.confirm('切换模板会用该模板重新生成草稿,覆盖未保存的编辑。继续?')) return;
    setBusy(true);
    setError('');
    setMsg('');
    setIssues(null);
    try {
      const { record: rec, editable } = await api.setProductTemplate(id!, templateId);
      setPresetApplied(false);
      setRecord(rec);
      setForm(editable);
      setSavedJson(JSON.stringify(editable));
      setMsg('已按新模板重新生成草稿');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function syncRemote() {
    setBusy(true); setError(''); setMsg('同步 Joom 状态中…');
    try {
      const next = await api.syncProduct(id!);
      setRecord(next);
      const bucket = classifyJoomListing(next);
      const label = bucket ? JOOM_BUCKET_META[bucket].label : next.joomState ?? '未知';
      setMsg(`已同步店铺状态：${label}${typeof next.joomInventory === 'number' ? ` · 库存 ${next.joomInventory}` : ''}`);
    }
    catch (e) { setError((e as Error).message); setMsg(''); }
    finally { setBusy(false); }
  }

  async function checkImages() {
    setBusy(true); setError(''); setMsg('检查图片中…');
    try { setImageResults(await api.imageCheck(id!)); setMsg('图片检查完成'); }
    catch (e) { setError((e as Error).message); setMsg(''); }
    finally { setBusy(false); }
  }

  const applyAttributeTemplate = (templateId: string) => {
    const t = attributeTemplates.find((x) => x.id === templateId);
    if (!t) return;
    patch({ attributes: { ...(form.attributes ?? {}), ...t.attributes } });
    setMsg(`已套用类目属性模板「${t.name}」，请检查后保存`);
  };

  async function rollback(log: AuditLogEntry) {
    if (!await nativePrompt.confirm(`恢复到「${log.summary}」之前的版本？当前未保存编辑会被替换。`)) return;
    setBusy(true); setError('');
    try {
      const next = await api.rollback(id!, log.id);
      const restored = next.edited ?? form;
      setRecord(next);
      setForm(restored);
      setSavedJson(JSON.stringify(restored));
      setAuditLogs(await api.auditLogs(id!));
      setMsg('已恢复历史版本，请检查后再同步 Joom');
    }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function publish() {
    const saved = await save();
    if (!saved) return;
    setBusy(true);
    try {
      const job = await api.enqueuePublish([id!]);
      setPublishJobId(job.id);
      setIssues(null);
      const message = job.aheadCount > 0
        ? `已追加到发布队列末尾，前面还有 ${job.aheadCount} 件；完成后会自动发布这个商品。`
        : '已加入后台发布队列，可以继续浏览，结果会自动更新。';
      setMsg(message);
      showFeedback(message);
    } catch (e) {
      setError((e as Error).message);
      setMsg('');
    } finally {
      setBusy(false);
    }
  }

  async function removeFromJoom() {
    if (!id || !isPublished) return;
    if (
      !await nativePrompt.confirm(
        '确定从 Joom 删除该商品？此操作不可恢复，会删除线上商品及全部变体。不要用于临时下架。本地记录将移入废弃箱。',
      )
    ) {
      return;
    }
    setBusy(true);
    setError('');
    setMsg('正在从 Joom 删除…');
    try {
      const items = await api.batchRemoveRemote({ ids: [id], reason: 'stopSelling' });
      const item = items[0];
      if (!item?.ok) throw new Error(item?.error || '删除失败');
      const latest = await api.getProduct(id);
      setRecord(latest.record);
      setForm(latest.editable);
      setSavedJson(JSON.stringify(latest.editable));
      setMsg(item.alreadyGone ? 'Joom 上已不存在该商品，本地已移入废弃箱' : '已从 Joom 删除，本地已移入废弃箱');
    } catch (e) {
      setError((e as Error).message);
      setMsg('');
    } finally {
      setBusy(false);
    }
  }

  async function deleteLocalProduct() {
    if (!id) return;
    setBusy(true);
    setError('');
    setMsg('');
    try {
      await api.deleteProduct(id);
      setRecord(null);
      setForm(null);
      setSavedJson('');
      navigate(nextId ? `/products/${nextId}` : '/joom', { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const prices = form.variants.map((v) => v.price || 0);
  const totalInventory = form.variants.reduce((s, v) => s + (v.inventory || 0), 0);
  return (
    <>
      <div className="ed-bar" id="editor-top">
        <button className="ghost" onClick={() => navigate('/joom')}>
          ← 返回
        </button>
        <button className="ghost" disabled={!prevId || busy} onClick={() => void saveAndNavigate(prevId)}>
          上一件
        </button>
        <button className="ghost" disabled={!nextId || busy} onClick={() => void saveAndNavigate(nextId)}>
          下一件
        </button>
        <ConfirmPopover
          title="删除当前商品？"
          description={`将永久删除这件本地商品${isPublished ? '，不影响 Joom 线上商品' : ''}。${dirty ? '未保存的修改也会丢失。' : ''}删除后${nextId ? '打开下一件' : '返回商品列表'}。`}
          disabled={busy}
          onConfirm={deleteLocalProduct}
        >
          <button className="ghost danger" type="button" disabled={busy}>删除本地</button>
        </ConfirmPopover>
        <span className={`badge ${record.status}`}>{STATUS_LABEL[record.status] ?? record.status}</span>
        {dirty && <span className="badge just-edited">未保存</span>}
        {(() => {
          const bucket = classifyJoomListing(record);
          if (!bucket) return record.joomProductId ? <span className="badge listing-unsynced">未同步</span> : null;
          return <span className={`badge listing-${bucket}`}>{JOOM_BUCKET_META[bucket].label}</span>;
        })()}
        <a href={record.collected.sourceUrl} target="_blank" rel="noreferrer" className="muted">
          查看来源页 ↗
        </a>
        <div style={{ flex: 1 }} />
        {templates.length > 0 && (
          <select
            className="status-filter editor-template-select"
            aria-label="选择预设模板"
            title="切换后会按所选模板重新生成草稿"
            value={record.templateId ?? ''}
            onChange={(e) => changeTemplate(e.target.value)}
            disabled={busy}
          >
            {!record.templateId && <option value="">选择预设模板…</option>}
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        )}
        <button className="ghost" onClick={applyPreset} disabled={busy}>
          重新应用预设
        </button>
        <button className="ghost" onClick={normalizeColors} disabled={busy}>
          规范化颜色
        </button>
        <button className="ghost" onClick={save} disabled={busy} title="⌘S / Ctrl+S">
          保存
        </button>
        <button className="ghost" onClick={runValidate} disabled={busy}>
          校验
        </button>
        {isPublished && <button className="ghost" onClick={syncRemote} disabled={busy}>同步 Joom 状态</button>}
        {isPublished && (
          <button className="ghost danger" onClick={removeFromJoom} disabled={busy}>
            从 Joom 删除
          </button>
        )}
        <button onClick={publish} disabled={busy || !!publishJobId}>
          {publishJobId ? '后台发布中' : isPublished ? '保存并后台更新 Joom' : '保存并后台发布到 Joom'}
        </button>
      </div>

      {error && <div className="error"><ErrorSummary message={error} /></div>}
      {msg && <div className="ok">{msg}</div>}

      {issues && issues.length > 0 && (
        <div className="issues">
          <strong>校验结果</strong>
          <ul>
            {issues.map((it, i) => (
              <li key={i} className={`iss-${it.severity}`}>
                <span className="tag">{it.severity === 'error' ? '必修' : '提醒'}</span>
                <code>{it.field}</code> {it.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {issues && issues.length === 0 && <div className="ok">校验通过,没有发现问题 ✓</div>}
      {(record.lastError || record.joomIssues || record.joomState === 'rejected' || record.joomState === 'warning' || classifyJoomListing(record) === 'error' || classifyJoomListing(record) === 'optimize') && (
        <div className="diagnostic-card">
          <div>
            <strong>Joom 店铺诊断</strong>
            {(() => {
              const bucket = classifyJoomListing(record);
              return <span className={`badge listing-${bucket ?? 'unsynced'}`}>{bucket ? JOOM_BUCKET_META[bucket].label : '需要关注'}</span>;
            })()}
          </div>
          {!reviewGroups.length && <ErrorSummary message={record.lastError || 'Joom 返回了需要关注的商品状态，请先同步店铺状态。'} />}
          {reviewGroups[0] && (
            <div className="review-summary editor-review-summary">
              <div className="review-reason-row">
                <strong>初步判断：{reviewGroups[0].meta.label}</strong>
                {reviewGroups.slice(1, 3).map((group) => <span className="review-reason-chip" key={group.key}>{group.meta.label}</span>)}
              </div>
              <p>{reviewGroups[0].meta.advice}</p>
            </div>
          )}
          {record.joomIssueDetails?.length ? (
            <details className="joom-issue-details editor-issue-details">
              <summary>查看平台原始审核信息（{record.joomIssueDetails.length}）</summary>
              <ul>
                {record.joomIssueDetails.map((detail: JoomIssueDetail, index: number) => (
                  <li key={`${detail.code ?? 'issue'}-${index}`}>
                    <span className="joom-issue-message">{detail.message}</span>
                    {(detail.field || detail.variantSku || detail.code) && (
                      <span className="joom-issue-meta">
                        {[detail.field && `字段：${detail.field}`, detail.variantSku && `变体 SKU：${detail.variantSku}`, detail.code && `平台代码：${detail.code}`].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {typeof record.joomInventory === 'number' && record.lastSyncedAt && (
            <p className="muted">店铺库存 {record.joomInventory}{record.lastSyncedAt ? ` · 同步于 ${new Date(record.lastSyncedAt).toLocaleString()}` : ''}</p>
          )}
          <div className="diagnostic-actions">
            <button className="ghost" onClick={runValidate} disabled={busy}>重新校验本地数据</button>
            {isPublished && <button className="ghost" onClick={syncRemote} disabled={busy}>重新同步 Joom</button>}
          </div>
        </div>
      )}

      <div className="ed-layout">
        {/* 左:主体 */}
        <div>
          <section className="section" id="editor-basic">
            <h3>基本信息</h3>
            <div className="field">
              <label>
                商品名称 <span className="req">*</span>
              </label>
              <input
                className={hasNonLatinListingText(form.title) ? 'lang-risk' : undefined}
                value={form.title}
                onChange={(e) => patch({ title: e.target.value })}
              />
              {hasNonLatinListingText(form.title) && (
                <p className="color-hint">标题含非英文字符，Joom 审核可能拒绝。请用「批量 AI 改标题」或手动改成英文。</p>
              )}
            </div>
            <div className="row2">
              <div className="field">
                <label>
                  商品 SKU <span className="req">*</span> <span className="hint">全店唯一</span>
                </label>
                <input
                  value={form.sku}
                  disabled={isPublished}
                  onChange={(e) => patch({ sku: e.target.value })}
                />
                {isPublished && <div className="hint">已发布商品的 Joom SKU 用于定位，不能在此修改。</div>}
                {dupSkuId && (
                  <p className="color-hint">
                    采集箱里已有相同 SKU，<a href={`/products/${dupSkuId}`} target="_blank" rel="noreferrer">打开另一件</a> 避免发布冲突。
                  </p>
                )}
              </div>
              <div className="field">
                <label>品牌</label>
                <input value={form.brand ?? ''} onChange={(e) => patch({ brand: e.target.value })} />
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>
                描述 <span className="hint">纯文本,不支持 HTML</span>
              </label>
              <textarea value={form.description} onChange={(e) => patch({ description: e.target.value })} />
            </div>
          </section>

          <section className="section" id="editor-images">
            <h3>
              商品图片 <span className="hint">第一张为主图,其余为附图(最多 20 张)</span>
            </h3>
            <div className="images">
              {form.images.map((src, i) => (
                <div
                  className={`thumb ${i === 0 ? 'main' : ''}`}
                  key={src + i}
                  title="悬浮查看大图"
                  onMouseEnter={(e) => showImagePreview(src, e)}
                  onMouseMove={(e) => showImagePreview(src, e)}
                  onMouseLeave={() => setPreview(null)}
                >
                  {i === 0 && <span className="maintag">主图</span>}
                  <img src={src} alt="" onError={(e) => fallbackToAllegroOriginal(e.currentTarget)} />
                  <div className="tools">
                    {i !== 0 && <button onClick={() => setMainImage(i)}>设主图</button>}
                    <button onClick={() => moveImage(i, -1)} disabled={i === 0} title="左移">‹</button>
                    <button onClick={() => moveImage(i, 1)} disabled={i === form.images.length - 1} title="右移">›</button>
                    <button onClick={() => removeImage(i)}>删除</button>
                  </div>
                </div>
              ))}
              {form.images.length === 0 && <span className="muted">无图片(发布需要主图)</span>}
            </div>
            <div className="inline-add">
              <input
                placeholder="粘贴图片 URL 添加"
                value={newImage}
                onChange={(e) => setNewImage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addImage()}
              />
              <button className="ghost" onClick={addImage}>
                添加
              </button>
            </div>
            <div className="image-toolbar">
              <button className="ghost" onClick={checkImages} disabled={busy}>检查图片质量</button>
              <span className="hint">检查 URL 可达性、Content-Type 和重复图片</span>
            </div>
            {imageResults && <div className="image-results">{imageResults.map((r, i) => <div className={r.ok && !r.duplicate && !r.issue ? 'image-ok' : 'image-bad'} key={`${r.url}-${i}`}><span>{i === 0 ? '主图' : `附图 ${i}`}</span><code>{r.url}</code><b>{r.duplicate ? '重复' : r.issue ?? (r.width && r.height ? `${r.width}×${r.height}` : r.ok ? '正常' : '异常')}</b></div>)}</div>}
            <div className="product-video-editor">
              <div className="section-head">
                <h4>商品视频</h4>
                <span className="hint">Joom 每件商品最多 1 个；上传后需经 Joom 审核</span>
              </div>
              {form.video ? (
                <div className="product-video-row">
                  <video controls preload="metadata" poster={form.video.poster} src={videoPreviewUrl(form.video.localAssetId, form.video.url)} />
                  <div>
                    <code>{form.video.url}</code>
                    <div className="tools"><button onClick={() => patch({ video: undefined })}>移除视频</button></div>
                  </div>
                </div>
              ) : <p className="muted">未采集到商品视频</p>}
              <div className="inline-add">
                <input placeholder="粘贴 MP4 / WebM 视频直链" value={newVideo} onChange={(e) => setNewVideo(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addVideo()} />
                <button className="ghost" onClick={addVideo}>添加</button>
              </div>
              {record.joomVideo && (
                <div className={`video-publish-status ${record.joomVideo.status}`}>
                  <strong>{VIDEO_STATUS_LABEL[record.joomVideo.status] ?? record.joomVideo.status}</strong>
                  {record.joomVideo.error && <span>{record.joomVideo.error}</span>}
                  {(record.joomVideo.status === 'failed' || record.joomVideo.status === 'rejected') && (
                    <button className="ghost" onClick={() => void retryVideo()} disabled={busy}>重试视频</button>
                  )}
                </div>
              )}
              <p className="hint">请确认你拥有视频的使用权；来源平台的版权素材也会接受 Joom 审核。</p>
            </div>
          </section>

          <section className="section" id="editor-variants">
            <div className="section-head">
              <h3 style={{ margin: 0 }}>
                变体 / SKU{' '}
                <span className="hint">
                  共 {form.variants.length} 个 · 价格不含 VAT
                  {isPublished ? ' · 已有变体 SKU 不要改名，改名会被 Joom 视为新增变体' : ''}
                </span>
              </h3>
              <div className="section-actions">
                <button className="ghost" onClick={normalizeColors}>
                  规范化颜色
                </button>
                <button className="ghost" onClick={openBatchVariant}>
                  按颜色批量添加
                </button>
                <button className="ghost" onClick={addVariant}>
                  + 添加变体
                </button>
              </div>
            </div>
            {batchVariantOpen && (
              <div className="batch-variant-panel">
                <div className="batch-variant-head">
                  <div>
                    <strong>按颜色批量添加变体</strong>
                    <span className="hint">一张颜色图自动生成整组尺码，价格、库存和物流继承已有变体</span>
                  </div>
                  <button className="ghost" onClick={() => setBatchVariantOpen(false)}>关闭</button>
                </div>
                <div className="batch-variant-fields">
                  <label>
                    新颜色 *
                    <input list="joom-colors" value={batchColor} placeholder="例如 White" onChange={(e) => setBatchColor(e.target.value)} />
                  </label>
                  <label>
                    继承哪种颜色的数据
                    <select value={batchSourceColor} onChange={(e) => setBatchSourceColor(e.target.value)}>
                      <option value="">自动按相同尺码继承</option>
                      {variantColors.map((color) => <option key={color} value={color}>{color}</option>)}
                    </select>
                  </label>
                  <label>
                    颜色图片 *
                    <input
                      type="file"
                      accept="image/*"
                      disabled={batchImageUploading}
                      onChange={(e) => {
                        void uploadBatchImage(e.target.files?.[0]);
                        e.currentTarget.value = '';
                      }}
                    />
                    <select value={currentForm.images.includes(batchImage) ? batchImage : '__custom__'} onChange={(e) => e.target.value !== '__custom__' && setBatchImage(e.target.value)}>
                      <option value="__custom__">选择商品图库图片</option>
                      {currentForm.images.map((src, index) => <option key={`${src}-${index}`} value={src}>图{index + 1}{index === 0 ? '（主图）' : ''}</option>)}
                    </select>
                    <input value={batchImage} placeholder="或粘贴可访问的图片 URL" onChange={(e) => setBatchImage(e.target.value)} />
                  </label>
                </div>
                <div className="batch-variant-image-preview">
                  {batchImage ? <img src={batchImage} alt="颜色图片预览" onError={(e) => fallbackToAllegroOriginal(e.currentTarget)} /> : <span>未选择图片</span>}
                </div>
                <div className="batch-size-head">
                  <strong>生成尺码（{batchNewSizes.length} 个新变体）</strong>
                  <span className="hint">默认使用当前商品已有尺码：{variantSizes.length ? variantSizes.join('、') : '未识别'}</span>
                  <button className="copy-btn" onClick={() => setBatchSizes(batchSizes.length === (variantSizes.length || DEFAULT_VARIANT_SIZES.length) ? [] : (variantSizes.length ? variantSizes : DEFAULT_VARIANT_SIZES))}>
                    {batchSizes.length ? '清空尺码' : '全选尺码'}
                  </button>
                </div>
                <div className="batch-size-chips">
                  {(variantSizes.length ? variantSizes : DEFAULT_VARIANT_SIZES).map((size) => {
                    const selectedSize = batchSizes.includes(size);
                    const duplicate = batchDuplicateSizes.has(normalizeVariantAxis(size));
                    return (
                      <button
                        type="button"
                        key={size}
                        className={`${selectedSize ? 'on' : ''} ${duplicate ? 'duplicate' : ''}`}
                        onClick={() => setBatchSizes((current) => selectedSize ? current.filter((x) => x !== size) : [...current, size])}
                        title={duplicate ? '该颜色已有此尺码，将跳过' : undefined}
                      >
                        {size}{duplicate ? ' ✓' : ''}
                      </button>
                    );
                  })}
                </div>
                <p className="hint batch-variant-note">本地图片会自动上传到 PICUI，转换为 Joom 可访问的 http(s) URL；也可以直接粘贴公网图片地址。{batchImageUploading ? ' 正在上传…' : ''}</p>
                <div className="batch-variant-actions">
                  <button className="ghost" onClick={() => setBatchVariantOpen(false)}>取消</button>
                  <button onClick={addBatchVariants} disabled={!batchNewSizes.length || !batchColor.trim() || !batchImage.trim()}>
                    添加 {batchNewSizes.length} 个变体
                  </button>
                </div>
              </div>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 76 }}>图</th>
                    <th>变体 SKU *</th>
                    <th style={{ width: '15%' }}>颜色</th>
                    <th style={{ width: '11%' }}>尺码</th>
                    <th style={{ width: '13%' }}>价格 *</th>
                    <th style={{ width: '13%' }}>促销价</th>
                    <th style={{ width: '11%' }}>库存</th>
                    <th style={{ width: 40 }} />
                  </tr>
                </thead>
                <tbody>
                  {form.variants.map((v, i) => (
                    <Fragment key={i}>
                    <tr>
                      <td className="vimg">
                        <div
                          className="vthumb"
                          onMouseEnter={(e) => v.image && setPreview({ src: v.image, x: e.clientX, y: e.clientY })}
                          onMouseMove={(e) => v.image && setPreview({ src: v.image, x: e.clientX, y: e.clientY })}
                          onMouseLeave={() => setPreview(null)}
                        >
                          {v.image ? <img src={v.image} alt="" onError={(e) => fallbackToAllegroOriginal(e.currentTarget)} /> : <span className="ph">无图</span>}
                        </div>
                        <select
                          value={v.image ?? ''}
                          onChange={(e) => updateVariant(i, { image: e.target.value || undefined })}
                          title="选择变体图片"
                        >
                          <option value="">无图</option>
                          {form.images.map((src, idx) => (
                            <option key={src + idx} value={src}>
                              图{idx + 1}
                              {idx === 0 ? '(主图)' : ''}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input value={v.sku} onChange={(e) => updateVariant(i, { sku: e.target.value })} />
                      </td>
                      <td>
                        <input
                          list="joom-colors"
                          className={hasNonLatinListingText(v.colors) ? 'color-risk' : undefined}
                          value={v.colors ?? ''}
                          onChange={(e) => updateVariant(i, { colors: e.target.value || undefined })}
                        />
                        {(() => {
                          const hint = suggestMappedColor(v.colors, colorOpts);
                          return hint ? <div className="color-hint">将映射为 {hint}</div> : null;
                        })()}
                      </td>
                      <td>
                        <input
                          value={v.size ?? ''}
                          onChange={(e) => updateVariant(i, { size: e.target.value || undefined })}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          value={v.price}
                          onChange={(e) => updateVariant(i, { price: Number(e.target.value) })}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          value={v.salePrice ?? ''}
                          placeholder="可选"
                          onChange={(e) =>
                            updateVariant(i, {
                              salePrice: e.target.value === '' ? undefined : Number(e.target.value),
                            })
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          value={v.inventory}
                          onChange={(e) => updateVariant(i, { inventory: Number(e.target.value) })}
                        />
                      </td>
                      <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                        <button
                          className="icon-btn"
                          title="物流 / 标识"
                          onClick={() => setOpenRow(openRow === i ? null : i)}
                        >
                          {openRow === i ? '▾' : '⋯'}
                        </button>
                        <button className="icon-btn" title="删除变体" onClick={() => removeVariant(i)}>
                          ✕
                        </button>
                      </td>
                    </tr>
                    {openRow === i && (
                      <tr className="detail-row">
                        <td colSpan={8}>
                          <div className="vdetail">
                            <label>
                              建议零售价 msrPrice
                              <input
                                type="number"
                                value={v.msrPrice ?? ''}
                                onChange={(e) => updateVariant(i, { msrPrice: numOr(e.target.value) })}
                              />
                            </label>
                            <label>
                              申报价值 declaredValue
                              <input
                                type="number"
                                value={v.declaredValue ?? ''}
                                onChange={(e) => updateVariant(i, { declaredValue: numOr(e.target.value) })}
                              />
                            </label>
                            <label>
                              运费 shippingPrice
                              <input
                                type="number"
                                value={v.shippingPrice ?? ''}
                                onChange={(e) => updateVariant(i, { shippingPrice: numOr(e.target.value) })}
                              />
                            </label>
                            <label>
                              毛重 kg
                              <input
                                type="number"
                                value={v.shippingWeight ?? ''}
                                onChange={(e) => updateVariant(i, { shippingWeight: numOr(e.target.value) })}
                              />
                            </label>
                            <label>
                              长 cm
                              <input
                                type="number"
                                value={v.shippingLength ?? ''}
                                onChange={(e) => updateVariant(i, { shippingLength: numOr(e.target.value) })}
                              />
                            </label>
                            <label>
                              宽 cm
                              <input
                                type="number"
                                value={v.shippingWidth ?? ''}
                                onChange={(e) => updateVariant(i, { shippingWidth: numOr(e.target.value) })}
                              />
                            </label>
                            <label>
                              高 cm
                              <input
                                type="number"
                                value={v.shippingHeight ?? ''}
                                onChange={(e) => updateVariant(i, { shippingHeight: numOr(e.target.value) })}
                              />
                            </label>
                            <label>
                              GTIN
                              <input
                                value={v.gtin ?? ''}
                                placeholder="8~14 位数字"
                                onChange={(e) => updateVariant(i, { gtin: e.target.value || undefined })}
                              />
                            </label>
                            <label>
                              HS 编码
                              <input
                                value={v.hsCode ?? ''}
                                onChange={(e) => updateVariant(i, { hsCode: e.target.value || undefined })}
                              />
                            </label>
                            <label>
                              履约天数(1~7)
                              <input
                                type="number"
                                value={v.committedFulfillmentDays ?? ''}
                                onChange={(e) =>
                                  updateVariant(i, { committedFulfillmentDays: numOr(e.target.value) })
                                }
                              />
                            </label>
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <datalist id="joom-colors">
              {colors.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <p className="hint" style={{ marginTop: 8 }}>
              颜色必须使用 Joom 允许的英文色名
              {colors.length ? `(已加载 ${colors.length} 个可选)` : '(连接 Joom 后可下拉选择)'}
              ；可用 &、,、and 分隔多个颜色。俄语/中文色名点「规范化颜色」会自动映射，不会改变体 SKU。
            </p>
            <div className="matrix-toolbar">
              <button className="ghost" onClick={applyLogisticsToAll}>套用第一条物流到全部</button>
              <button className="ghost" onClick={() => setMatrixMode((v) => !v)}>{matrixMode ? '隐藏变体矩阵' : '打开变体矩阵'}</button>
              <span className="hint">物流含重量、运费、尺寸和履约天数</span>
            </div>
            {matrixMode && <VariantMatrix form={form} />}
          </section>

          {requirements && requirements.attributes.length > 0 && (
            <section className="section" id="editor-attributes">
              <div className="section-head">
                <h3 style={{ margin: 0 }}>
                  类目属性{' '}
                  <span className="hint">
                    来自所选类目 · 共 {requirements.attributes.length} 项 · 必填项影响审核
                  </span>
                </h3>
                {attributeTemplates.length > 0 && <select className="small-select" defaultValue="" onChange={(e) => applyAttributeTemplate(e.target.value)}><option value="">套用属性模板…</option>{attributeTemplates.filter((t) => !t.categoryId || t.categoryId === form.categoryId).map((t) => <option value={t.id} key={t.id}>{t.name}</option>)}</select>}
              </div>
              <div className="attrs">
                {requirements.attributes.map((a) => {
                  const val = form.attributes?.[a.attributeId] ?? '';
                  const listId = `attrvals-${a.attributeId}`;
                  return (
                    <div className="field" key={a.attributeId}>
                      <label>
                        {a.attributeName}
                        {isRequired(a.severity) && <span className="req"> *</span>}
                        {!isRequired(a.severity) && <span className="hint"> {a.severity}</span>}
                      </label>
                      <input
                        list={a.allowedValues?.length ? listId : undefined}
                        value={val}
                        placeholder={a.goodDescriptionSamples?.[0] ?? '填写属性值'}
                        onChange={(e) => setAttr(a.attributeId, e.target.value)}
                      />
                      {a.allowedValues?.length ? (
                        <datalist id={listId}>
                          {a.allowedValues.map((v) => (
                            <option key={v} value={v} />
                          ))}
                        </datalist>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>

        {/* 右:发布侧栏 */}
        <aside className="side">
          <EditorAnchorNav />
          {quality && (
            <section className="section" id="editor-quality">
              <div className="section-head">
                <h3 style={{ margin: 0 }}>发布准备度</h3>
                <b className={`score-${quality.grade}`}>{quality.score}</b>
              </div>
              <p className="hint" style={{ marginTop: -6 }}>{QUALITY_GRADE_META[quality.grade].label} · 边改边看还缺什么</p>
              <div className="quality-breakdown">
                {quality.breakdown.map((row) => (
                  <div className="quality-row" key={row.key}>
                    <span>{row.label}</span>
                    <div className="bar"><i style={{ width: `${row.max ? (row.score / row.max) * 100 : 0}%` }} /></div>
                    <strong>{row.score}/{row.max}</strong>
                    {row.hint && <small>{row.hint}</small>}
                  </div>
                ))}
              </div>
            </section>
          )}
          <section className="section" id="editor-publish">
            <h3>发布信息</h3>
            <div className="field">
              <label>目标平台</label>
              <div className="target">
                <span className="dot on" /> Joom
              </div>
            </div>
            <div className="field">
              <label>
                店铺 storeId <span className="hint">留空则用当前店铺档案</span>
              </label>
              <input
                value={form.storeId ?? ''}
                placeholder="留空则跟当前店铺"
                onChange={(e) => patch({ storeId: e.target.value || undefined })}
              />
            </div>
            <div className="field">
              <label>类目</label>
              <CategoryPicker
                categories={categories}
                value={form.categoryId}
                onChange={(categoryId) => patch({ categoryId })}
                disabled={busy}
              />
            </div>
            <div className="field">
              <label>币种 currency</label>
              <input value={form.currency} onChange={(e) => patch({ currency: e.target.value.toUpperCase() })} />
            </div>
            <div className="field">
              <label>
                敏感货 dangerInfo <span className="hint">普通货(如服装)不勾选</span>
              </label>
              <label className="ck">
                <input type="checkbox" checked={dangerous} onChange={(e) => setDangerous(e.target.checked)} />
                这是危险品 / 敏感货
              </label>
              {dangerous && (
                <div className="danger-kinds">
                  {DANGER_KINDS.map((k) => (
                    <label className="ck" key={k.value}>
                      <input type="checkbox" checked={dangerKinds.includes(k.value)} onChange={() => toggleKind(k.value)} />
                      {k.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>
                标签 tags <span className="hint">搜索关键词,买家不可见</span>
              </label>
              <div className="chips">
                {(form.tags ?? []).map((t) => (
                  <span className="chip" key={t}>
                    {t}
                    <button onClick={() => removeTag(t)}>×</button>
                  </span>
                ))}
              </div>
              <div className="inline-add">
                <input
                  placeholder="输入后回车添加"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addTag()}
                />
                <button className="ghost" onClick={addTag}>
                  添加
                </button>
              </div>
            </div>
          </section>

          <section className="section" id="editor-overview">
            <h3>概览</h3>
            <dl className="summary">
              <dt>变体数</dt>
              <dd>{form.variants.length}</dd>
              <dt>总库存</dt>
              <dd>{totalInventory}</dd>
              <dt>价格区间</dt>
              <dd>
                {prices.length ? Math.min(...prices) : 0}–{prices.length ? Math.max(...prices) : 0} {form.currency}
              </dd>
              {record.joomProductId && (
                <>
                  <dt>Joom 商品 id</dt>
                  <dd className="mono">{record.joomProductId}</dd>
                </>
              )}
            </dl>
          </section>

          <section className="section" id="editor-source">
            <h3>来源信息</h3>
            <dl className="summary">
              <dt>平台</dt>
              <dd>{record.collected.source}</dd>
              <dt>来源 id</dt>
              <dd className="mono">{record.collected.sourceProductId}</dd>
              <dt>原价</dt>
              <dd>
                {record.collected.price?.value ?? '—'} {record.collected.price?.currency ?? ''}
              </dd>
            </dl>
          </section>
          {isPublished && <section className="section" id="editor-history"><div className="section-head"><h3>操作记录</h3><span className="hint">保存、同步和发布会留下记录</span></div><div className="activity-list">{auditLogs.length ? auditLogs.slice(0, 8).map((a) => <div className="activity-item" key={a.id}><span className="activity-icon">✦</span><span><strong>{a.summary}</strong><small>{new Date(a.createdAt).toLocaleString()}</small></span>{Boolean(a.before) && a.action !== 'product.rollback' && a.action !== 'product.delete' && <button className="copy-btn" onClick={() => rollback(a)}>恢复</button>}</div>) : <span className="muted">暂无记录</span>}</div></section>}
        </aside>
      </div>

      {preview && (
        <div
          className="hover-preview"
          style={{
            left: Math.min(preview.x + 24, Math.max(12, window.innerWidth - 340)),
            top: Math.min(preview.y + 16, Math.max(12, window.innerHeight - 340)),
          }}
        >
          <img src={preview.src} alt="" onError={(e) => fallbackToAllegroOriginal(e.currentTarget)} />
        </div>
      )}
    </>
  );
}

function VariantMatrix({ form }: { form: EditableProduct }) {
  const colors = Array.from(new Set(form.variants.map((v) => v.colors || '默认')));
  const sizes = Array.from(new Set(form.variants.map((v) => v.size || '均码')));
  const key = (color: string, size: string) => form.variants.find((v) => (v.colors || '默认') === color && (v.size || '均码') === size);
  return <div className="matrix-wrap"><table className="matrix"><thead><tr><th>颜色 / 尺码</th>{sizes.map((s) => <th key={s}>{s}</th>)}</tr></thead><tbody>{colors.map((c) => <tr key={c}><th>{c}</th>{sizes.map((s) => { const v = key(c, s); return <td className={v ? 'matrix-exists' : 'matrix-missing'} key={s}>{v ? <><b>✓</b><small>{v.inventory} 件</small></> : <span>缺失</span>}</td>; })}</tr>)}</tbody></table></div>;
}
