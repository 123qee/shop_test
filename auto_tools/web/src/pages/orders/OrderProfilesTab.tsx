import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useBlocker } from 'react-router-dom';
import {
  chinaDate,
  createDefaultOrderExportProfile,
  DEFAULT_ORDER_COLUMNS,
  EXPORT_MATERIALS,
  FILE_NAME_VARIABLES,
  formatChinaDateTime,
  ORDER_COLUMN_GROUPS,
  ORDER_COLUMN_KEYS,
  ORDER_COLUMNS,
  ORDER_STATUSES,
  ORDER_STATUS_LABELS,
  renderFileName,
  sanitizeFileName,
  type ExportMaterial,
  type OrderColumnKey,
  type OrderExportBucketConfig,
  type OrderExportLayout,
  type OrderExportProfile,
  type OrderMaterialRule,
  type OrderStatus,
  type UnknownMaterialHandling,
} from '@shared/orders';
import { addDays } from '@shared/planner';
import { materialLabel } from '@shared/product-grouping';
import { api } from '../../api';
import { ConfirmPopover } from '../../components/ConfirmPopover';
import { useNativePrompt } from '../../components/NativePromptProvider';
import { showFeedback } from '../../feedback';
import { PlannerIcon } from '../planner/PlannerIcon';
import {
  describeProfile,
  errorMessage,
  MATERIAL_OPTIONS,
  PROFILE_STORAGE_KEY,
  readStored,
  writeStored,
} from './order-ui';

/** 与后端 routes/orders.ts、orders/profile-service.ts 的校验保持一致 */
const MAX_PROFILES = 20;
const NAME_MAX = 40;
const LABEL_MAX = 20;
const TEMPLATE_MAX = 200;

const LAYOUTS: Array<{ id: OrderExportLayout; label: string; hint: string }> = [
  { id: 'file-per-material', label: '每种材质一个文件', hint: '每种材质各生成一个 Excel，方便分别发给不同的工厂' },
  { id: 'sheet-per-material', label: '一个文件，每种材质一个工作表', hint: '只生成一个 Excel，每种材质放在单独的工作表里' },
];

const UNKNOWN_OPTIONS: Array<{ id: UnknownMaterialHandling; label: string }> = [
  { id: 'separate', label: '单独导出' },
  { id: 'skip', label: '本次不导出' },
];

/** 文件名预览用的示例数量，依次对应各材质 */
const SAMPLE_COUNTS = [
  { count: 32, qty: 41 },
  { count: 18, qty: 20 },
  { count: 6, qty: 7 },
  { count: 4, qty: 5 },
];
const SAMPLE_UNKNOWN = { count: 3, qty: 3 };

type TemplateField = 'main' | 'unknown' | `bucket:${ExportMaterial}`;
type Problems = Partial<Record<string, string>>;

interface Props {
  profiles: OrderExportProfile[];
  onChange: (profiles: OrderExportProfile[]) => void;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 后端要求方案 id 匹配 [a-zA-Z0-9_-]{1,60} */
function newProfileId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function uniqueName(base: string, profiles: OrderExportProfile[]): string {
  const taken = new Set(profiles.map((profile) => profile.name.trim()));
  const root = base.slice(0, NAME_MAX - 3);
  if (!taken.has(root)) return root;
  for (let i = 2; ; i++) {
    const name = `${root} ${i}`;
    if (!taken.has(name)) return name;
  }
}

/** 去掉首尾空格和空的文件名覆盖。保存、判断「有没有改动」都用它，键的顺序固定。 */
function cleanProfile(profile: OrderExportProfile): OrderExportProfile {
  const fileNameOf = (value: string | undefined) => (value?.trim() ? { fileName: value.trim() } : {});
  return {
    id: profile.id,
    name: profile.name.trim(),
    layout: profile.layout,
    fileName: profile.fileName.trim(),
    buckets: profile.buckets.map((bucket) => ({
      material: bucket.material,
      label: bucket.label.trim(),
      ...fileNameOf(bucket.fileName),
    })),
    unknown: {
      handling: profile.unknown.handling,
      label: profile.unknown.label.trim(),
      ...fileNameOf(profile.unknown.fileName),
    },
    columns: [...profile.columns],
    defaults: {
      shops: profile.defaults.shops.map(({ platform, shopId }) => ({ platform, shopId })),
      statuses: [...profile.defaults.statuses],
      onlyNew: profile.defaults.onlyNew,
    },
    updatedAt: profile.updatedAt,
  };
}

function sameContent(a: OrderExportProfile, b: OrderExportProfile): boolean {
  return JSON.stringify({ ...cleanProfile(a), updatedAt: '' }) === JSON.stringify({ ...cleanProfile(b), updatedAt: '' });
}

function bucketLabel(bucket: OrderExportBucketConfig): string {
  return bucket.label.trim() || materialLabel(bucket.material);
}

function profileSummary(profile: OrderExportProfile): string {
  const layout = profile.layout === 'sheet-per-material' ? '一个文件' : '按材质分文件';
  return `${layout} · ${profile.buckets.map(bucketLabel).join(' / ') || '未选材质'}`;
}

/** 返回各字段的问题；键的插入顺序就是页面从上到下的顺序，第一条显示在保存按钮旁。 */
function validate(draft: OrderExportProfile, profiles: OrderExportProfile[]): Problems {
  const problems: Problems = {};
  const name = draft.name.trim();
  if (!name) problems.name = '请填写方案名称';
  else if (name.length > NAME_MAX) problems.name = `方案名称最多 ${NAME_MAX} 个字`;
  else if (profiles.some((profile) => profile.id !== draft.id && profile.name.trim() === name)) {
    problems.name = `已经有名为「${name}」的方案`;
  }

  const template = draft.fileName.trim();
  if (!template) problems.main = '请填写文件名模板';
  else if (template.length > TEMPLATE_MAX) problems.main = `文件名模板最多 ${TEMPLATE_MAX} 个字符`;

  if (!draft.buckets.length) problems.buckets = '至少勾选一种单独导出的材质';
  const owners = new Map<string, string>();
  const labels: Array<[string, string, string]> = [
    ...draft.buckets.map((bucket): [string, string, string] => [bucket.material, bucket.label, materialLabel(bucket.material)]),
    ['unknown', draft.unknown.label, '未识别'],
  ];
  for (const [key, raw, owner] of labels) {
    const label = raw.trim();
    const lower = label.toLowerCase();
    if (!label) problems[`label:${key}`] = '请填写显示名';
    else if (label.length > LABEL_MAX) problems[`label:${key}`] = `显示名最多 ${LABEL_MAX} 个字`;
    else if (owners.has(lower)) problems[`label:${key}`] = `和「${owners.get(lower)}」的显示名重复`;
    else owners.set(lower, owner);
  }
  for (const bucket of draft.buckets) {
    if ((bucket.fileName ?? '').trim().length > TEMPLATE_MAX) {
      problems[`bucket:${bucket.material}`] = `文件名最多 ${TEMPLATE_MAX} 个字符`;
    }
  }
  if ((draft.unknown.fileName ?? '').trim().length > TEMPLATE_MAX) problems.unknown = `文件名最多 ${TEMPLATE_MAX} 个字符`;
  if (!draft.columns.length) problems.columns = '至少选择一列';
  if (!draft.defaults.statuses.length) problems.statuses = '至少选择一个订单状态';
  return problems;
}

interface FileNamePreview {
  files: Array<{ name: string; note: string }>;
  /** 模板里认不出的变量，会原样留在文件名里 */
  unknownTokens: string[];
  strayBrace: boolean;
  duplicated: boolean;
}

/** 用示例数据渲染将生成的文件名，规则与后端 export-service 的 planFiles 一致。 */
function previewFileNames(draft: OrderExportProfile, now: Date): FileNamePreview {
  const yesterday = addDays(chinaDate(now), -1);
  const context = {
    platforms: ['Joom'],
    shops: ['店铺A', '店铺B'],
    profile: draft.name.trim() || '方案名',
    now,
    from: yesterday,
    to: yesterday,
    seq: 1,
  };
  const mainTemplate = draft.fileName.trim();
  const templateOf = (override: string | undefined) => override?.trim() || mainTemplate;
  const unknownLabel = draft.unknown.label.trim() || '待确认';
  const separate = draft.unknown.handling === 'separate';
  const raw: Array<{ name: string; note: string }> = [];

  if (draft.layout === 'sheet-per-material') {
    const labels = draft.buckets.map(bucketLabel);
    if (labels.length) {
      const stats = SAMPLE_COUNTS.slice(0, labels.length).reduce(
        (sum, item) => ({ count: sum.count + item.count, qty: sum.qty + item.qty }),
        { count: 0, qty: 0 },
      );
      raw.push({
        name: renderFileName(mainTemplate, { ...context, material: labels.join('+'), ...stats }),
        note: `工作表：${labels.join('、')}${separate ? `；有未识别的订单时再加一个「${unknownLabel}」` : ''}`,
      });
    }
  } else {
    draft.buckets.forEach((bucket, index) => {
      raw.push({
        name: renderFileName(templateOf(bucket.fileName), {
          ...context,
          material: bucketLabel(bucket),
          ...SAMPLE_COUNTS[index % SAMPLE_COUNTS.length],
        }),
        note: bucketLabel(bucket),
      });
    });
    if (separate) {
      raw.push({
        name: renderFileName(templateOf(draft.unknown.fileName), { ...context, material: unknownLabel, ...SAMPLE_UNKNOWN }),
        note: `${unknownLabel}（有未识别的订单时才生成）`,
      });
    }
  }

  const tokens = new Set<string>();
  let strayBrace = false;
  let duplicated = false;
  const taken = new Set<string>();
  const files = raw.map((file) => {
    for (const token of file.name.match(/\{[^{}]*\}/g) ?? []) tokens.add(token);
    strayBrace ||= /[{}]/.test(file.name.replace(/\{[^{}]*\}/g, ''));
    // 与后端一致：清理非法字符，重名时加 (2)(3)
    const clean = sanitizeFileName(file.name);
    let name = clean;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${clean} (${i})`;
    duplicated ||= name !== clean;
    taken.add(name.toLowerCase());
    return { name: `${name}.xlsx`, note: file.note };
  });
  return { files, unknownTokens: [...tokens], strayBrace, duplicated };
}

export function OrderProfilesTab({ profiles, onChange }: Props) {
  const { confirm } = useNativePrompt();
  const [draft, setDraft] = useState<OrderExportProfile>(() => {
    const stored = readStored(PROFILE_STORAGE_KEY);
    return clone(profiles.find((profile) => profile.id === stored) ?? profiles[0] ?? createDefaultOrderExportProfile());
  });
  const [isNew, setIsNew] = useState(() => profiles.length === 0);
  const [saving, setSaving] = useState(false);
  const [activeField, setActiveField] = useState<TemplateField>('main');
  const inputs = useRef(new Map<TemplateField, HTMLInputElement>());
  /** 新建或复制前在看的方案，取消新建时回到这里 */
  const returnTo = useRef('');
  const blockerPromptOpen = useRef(false);

  const saved = isNew ? undefined : profiles.find((profile) => profile.id === draft.id);
  const dirty = isNew || (saved ? !sameContent(draft, saved) : false);
  const problems = useMemo(() => validate(draft, profiles), [draft, profiles]);
  const firstProblem = Object.values(problems)[0] ?? '';
  const preview = useMemo(() => previewFileNames(draft, new Date()), [draft]);
  const unknownLabel = draft.unknown.label.trim() || '待确认';
  const perFile = draft.layout === 'file-per-material';
  const selectedColumns = new Set(draft.columns);
  const orderedMaterials: ExportMaterial[] = [
    ...draft.buckets.map((bucket) => bucket.material),
    ...EXPORT_MATERIALS.filter((material) => !draft.buckets.some((bucket) => bucket.material === material)),
  ];

  // 正在看的方案被删掉（例如另一个窗口里）时回到第一个方案
  useEffect(() => {
    if (!isNew && !saved && profiles.length) setDraft(clone(profiles[0]));
  }, [isNew, saved, profiles]);

  // 有未保存的修改时，切换标签页或离开页面前先确认（标签页通过 ?tab= 切换，所以也比较 search）
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirty && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
  );
  useEffect(() => {
    if (blocker.state !== 'blocked' || blockerPromptOpen.current) return;
    blockerPromptOpen.current = true;
    void confirm('导出方案有未保存的修改，离开后会丢失。确定离开吗？')
      .then((leave) => {
        if (leave) blocker.proceed();
        else blocker.reset();
      })
      .finally(() => {
        blockerPromptOpen.current = false;
      });
  }, [blocker, confirm]);

  const update = (patch: Partial<OrderExportProfile>) => setDraft((current) => ({ ...current, ...patch }));
  const updateUnknown = (patch: Partial<OrderExportProfile['unknown']>) =>
    setDraft((current) => ({ ...current, unknown: { ...current.unknown, ...patch } }));
  const updateDefaults = (patch: Partial<OrderExportProfile['defaults']>) =>
    setDraft((current) => ({ ...current, defaults: { ...current.defaults, ...patch } }));
  const updateBucket = (material: ExportMaterial, patch: Partial<OrderExportBucketConfig>) =>
    setDraft((current) => ({
      ...current,
      buckets: current.buckets.map((bucket) => (bucket.material === material ? { ...bucket, ...patch } : bucket)),
    }));

  function toggleBucket(material: ExportMaterial, on: boolean) {
    setDraft((current) => ({
      ...current,
      buckets: on
        ? [...current.buckets, { material, label: materialLabel(material) }]
        : current.buckets.filter((bucket) => bucket.material !== material),
    }));
  }

  function moveBucket(index: number, offset: -1 | 1) {
    setDraft((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.buckets.length) return current;
      const buckets = [...current.buckets];
      [buckets[index], buckets[target]] = [buckets[target], buckets[index]];
      return { ...current, buckets };
    });
  }

  /** 列的顺序固定为 ORDER_COLUMNS 的顺序 */
  function toggleColumn(key: OrderColumnKey, on: boolean) {
    setDraft((current) => {
      const selected = new Set(current.columns);
      if (on) selected.add(key);
      else selected.delete(key);
      return { ...current, columns: ORDER_COLUMN_KEYS.filter((item) => selected.has(item)) };
    });
  }

  function toggleStatus(status: OrderStatus) {
    setDraft((current) => {
      const selected = new Set(current.defaults.statuses);
      if (selected.has(status)) selected.delete(status);
      else selected.add(status);
      return { ...current, defaults: { ...current.defaults, statuses: ORDER_STATUSES.filter((item) => selected.has(item)) } };
    });
  }

  // ---- 文件名变量：插入到正在编辑的那个文件名输入框 ----

  const effectiveField: TemplateField = (() => {
    if (activeField === 'main' || !perFile) return 'main';
    if (activeField === 'unknown') return draft.unknown.handling === 'separate' ? 'unknown' : 'main';
    const material = activeField.slice('bucket:'.length) as ExportMaterial;
    return draft.buckets.some((bucket) => bucket.material === material) ? activeField : 'main';
  })();

  const fieldLabel = (field: TemplateField): string => {
    if (field === 'main') return '「模板」';
    if (field === 'unknown') return `「${unknownLabel}」的文件名`;
    const bucket = draft.buckets.find((item) => `bucket:${item.material}` === field);
    return bucket ? `「${bucketLabel(bucket)}」的文件名` : '「模板」';
  };

  function templateValue(field: TemplateField): string {
    if (field === 'main') return draft.fileName;
    if (field === 'unknown') return draft.unknown.fileName ?? '';
    return draft.buckets.find((bucket) => `bucket:${bucket.material}` === field)?.fileName ?? '';
  }

  function setTemplateValue(field: TemplateField, value: string) {
    if (field === 'main') update({ fileName: value });
    else if (field === 'unknown') updateUnknown({ fileName: value });
    else updateBucket(field.slice('bucket:'.length) as ExportMaterial, { fileName: value });
  }

  const registerInput = (field: TemplateField) => (element: HTMLInputElement | null) => {
    if (element) inputs.current.set(field, element);
    else inputs.current.delete(field);
  };

  function insertToken(token: string) {
    const field = effectiveField;
    const input = inputs.current.get(field);
    const current = templateValue(field);
    // 输入框失焦后仍保留光标位置；变量按钮按下时也阻止了失焦
    const start = input?.selectionStart ?? current.length;
    const end = input?.selectionEnd ?? current.length;
    setTemplateValue(field, current.slice(0, start) + token + current.slice(end));
    window.requestAnimationFrame(() => {
      if (!input) return;
      input.focus();
      input.setSelectionRange(start + token.length, start + token.length);
    });
  }

  // ---- 方案切换、新建、保存、删除 ----

  async function confirmLeaveDraft(): Promise<boolean> {
    if (!dirty) return true;
    return confirm(isNew
      ? '新方案还没保存，切换后会丢失。确定切换吗？'
      : `「${saved?.name ?? draft.name}」有未保存的修改，切换后会丢失。确定切换吗？`);
  }

  async function selectProfile(id: string) {
    if (id === draft.id) return;
    const next = profiles.find((profile) => profile.id === id);
    if (!next || !(await confirmLeaveDraft())) return;
    setDraft(clone(next));
    setIsNew(false);
    setActiveField('main');
  }

  function openNewDraft(source: OrderExportProfile, name: string) {
    if (!isNew) returnTo.current = draft.id;
    setDraft({ ...clone(source), id: newProfileId(), name, updatedAt: new Date().toISOString() });
    setIsNew(true);
    setActiveField('main');
  }

  async function startNew() {
    if (profiles.length >= MAX_PROFILES) {
      showFeedback(`最多保存 ${MAX_PROFILES} 个导出方案，请先删除不用的方案`, 'error');
      return;
    }
    if (!(await confirmLeaveDraft())) return;
    openNewDraft(createDefaultOrderExportProfile(), uniqueName('新方案', profiles));
  }

  /** 复制当前编辑的内容（含未保存的修改）为新方案，原方案保持已保存的内容。 */
  function copyCurrent() {
    if (profiles.length >= MAX_PROFILES) {
      showFeedback(`最多保存 ${MAX_PROFILES} 个导出方案，请先删除不用的方案`, 'error');
      return;
    }
    const sourceName = saved?.name ?? draft.name;
    const name = uniqueName(`${draft.name.trim() || '方案'} 副本`, profiles);
    openNewDraft(draft, name);
    showFeedback(`已复制「${sourceName}」为「${name}」，改好后点「保存新方案」`, 'info');
  }

  function discard() {
    if (isNew) {
      const back = profiles.find((profile) => profile.id === returnTo.current) ?? profiles[0];
      if (!back) return;
      setDraft(clone(back));
      setIsNew(false);
    } else if (saved) {
      setDraft(clone(saved));
    }
    setActiveField('main');
  }

  async function save() {
    if (firstProblem) {
      showFeedback(firstProblem, 'error');
      return;
    }
    const creating = isNew;
    const payload = cleanProfile(draft);
    setSaving(true);
    try {
      const next = await api.saveOrderProfile(payload);
      onChange(next);
      const stored = next.find((profile) => profile.id === payload.id);
      if (stored) setDraft(clone(stored));
      setIsNew(false);
      // 新建的方案保存后，导出页直接选中它
      if (creating) writeStored(PROFILE_STORAGE_KEY, payload.id);
      showFeedback(creating ? `已保存方案「${payload.name}」，导出页会默认选中它` : `已保存方案「${payload.name}」`);
    } catch (error) {
      showFeedback(errorMessage(error), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const name = saved?.name ?? draft.name;
    try {
      const next = await api.deleteOrderProfile(draft.id);
      onChange(next);
      if (next[0]) setDraft(clone(next[0]));
      setIsNew(false);
      setActiveField('main');
      showFeedback(`已删除方案「${name}」`);
    } catch (error) {
      showFeedback(errorMessage(error), 'error');
    }
  }

  const listItems = isNew ? [...profiles, draft] : profiles;
  const atLimit = profiles.length >= MAX_PROFILES;
  const statusText = firstProblem
    || (isNew ? '新方案还没保存' : dirty ? '有未保存的修改' : saved ? `上次保存于 ${formatChinaDateTime(saved.updatedAt)}` : '');

  return (
    <div className="orders-settings">
      <section className="orders-card orders-profiles">
        <aside className="orders-profile-list" aria-label="导出方案列表">
          <div className="orders-profile-list-head">
            <h3>导出方案</h3>
            <span className="orders-hint">{profiles.length} / {MAX_PROFILES}</span>
          </div>
          <ul>
            {listItems.map((item) => {
              const current = item.id === draft.id;
              const shown = current ? draft : item;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`orders-profile-item${current ? ' on' : ''}`}
                    aria-current={current ? 'true' : undefined}
                    onClick={() => void selectProfile(item.id)}
                  >
                    <span className="orders-profile-name">
                      <span>{shown.name.trim() || '未命名方案'}</span>
                      {current && isNew && <span className="orders-badge new">未保存</span>}
                      {current && !isNew && dirty && <span className="orders-badge">有修改</span>}
                    </span>
                    <small>{profileSummary(shown)}</small>
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className="ghost orders-small orders-profile-add"
            disabled={atLimit || saving}
            title={atLimit ? `最多保存 ${MAX_PROFILES} 个导出方案` : undefined}
            onClick={() => void startNew()}
          >
            <PlannerIcon name="plus" size={14} /> 新建方案
          </button>
        </aside>

        <div className="orders-profile-editor">
          <div className="orders-editor-head">
            <div className="orders-editor-title">
              <h3>{draft.name.trim() || '未命名方案'}</h3>
              <span className="orders-hint">{describeProfile(cleanProfile(draft))}</span>
            </div>
            <div className="orders-editor-actions">
              <button
                type="button"
                className="ghost orders-small"
                disabled={isNew || saving || atLimit}
                title="把当前内容（含未保存的修改）复制成一个新方案"
                onClick={copyCurrent}
              >
                复制为新方案
              </button>
              <ConfirmPopover
                title={`删除方案「${saved?.name ?? draft.name}」？`}
                description="删除后不能恢复。导出记录和已经下载的文件不受影响。"
                disabled={isNew || saving || profiles.length <= 1}
                onConfirm={remove}
              >
                <button
                  type="button"
                  className="ghost orders-small orders-danger"
                  disabled={isNew || saving || profiles.length <= 1}
                  title={profiles.length <= 1 ? '至少保留一个导出方案' : undefined}
                >
                  <PlannerIcon name="trash" size={14} /> 删除
                </button>
              </ConfirmPopover>
            </div>
          </div>

          <Section title="基本信息">
            <div className="orders-row">
              <label className="orders-label" htmlFor="orders-profile-name">方案名称</label>
              <div className="orders-control orders-control-stack">
                <input
                  id="orders-profile-name"
                  className={`orders-input${problems.name ? ' invalid' : ''}`}
                  value={draft.name}
                  placeholder="如：每日发厂、月度对账"
                  onChange={(event) => update({ name: event.target.value })}
                />
                <FieldError message={problems.name} />
              </div>
            </div>
            <div className="orders-row">
              <span className="orders-label">拆分方式</span>
              <div className="orders-control">
                <div className="orders-segmented" role="radiogroup" aria-label="拆分方式">
                  {LAYOUTS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="radio"
                      aria-checked={draft.layout === item.id}
                      className={draft.layout === item.id ? 'on' : ''}
                      onClick={() => update({ layout: item.id })}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <span className="orders-hint">{LAYOUTS.find((item) => item.id === draft.layout)?.hint}</span>
              </div>
            </div>
          </Section>

          <Section title="文件名" hint="不用写扩展名，会自动加 .xlsx；文件名里不能用的字符会换成 _">
            <div className="orders-row">
              <label className="orders-label" htmlFor="orders-profile-template">模板</label>
              <div className="orders-control orders-control-stack">
                <input
                  id="orders-profile-template"
                  ref={registerInput('main')}
                  className={`orders-input mono${problems.main ? ' invalid' : ''}`}
                  value={draft.fileName}
                  spellCheck={false}
                  onFocus={() => setActiveField('main')}
                  onChange={(event) => update({ fileName: event.target.value })}
                />
                <FieldError message={problems.main} />
                <div className="orders-variables" role="group" aria-label="插入变量">
                  {FILE_NAME_VARIABLES.map((item) => (
                    <button
                      key={item.token}
                      type="button"
                      className="orders-variable"
                      title={`插入 ${item.token}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insertToken(item.token)}
                    >
                      {item.label}<code>{item.token}</code>
                    </button>
                  ))}
                </div>
                <span className="orders-hint">
                  点变量插入到{fieldLabel(effectiveField)}的光标处。日期可以指定格式，如 {'{date:YYYY-MM-DD}'}、{'{time:HHmm}'}。
                </span>
              </div>
            </div>
            <div className="orders-row">
              <span className="orders-label">预览</span>
              <div className="orders-control orders-control-stack">
                {preview.files.length ? (
                  <ul className="orders-filename-preview">
                    {preview.files.map((file, index) => (
                      <li key={`${index}-${file.name}`}>
                        <span className="orders-filename mono">{file.name}</span>
                        <small>{file.note}</small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="orders-hint">先在下面勾选要单独导出的材质</span>
                )}
                <span className="orders-hint">示例数据：Joom「店铺A」「店铺B」昨天的订单，今天第 1 次导出。</span>
                {preview.unknownTokens.length > 0 && (
                  <span className="orders-field-error">认不出的变量：{preview.unknownTokens.join('、')}，会原样出现在文件名里</span>
                )}
                {preview.strayBrace && <span className="orders-field-error">模板里有不成对的花括号</span>}
                {preview.duplicated && (
                  <span className="orders-warn-text">有文件名重复，导出时会自动加 (2)、(3) 区分；建议在模板里加上 {'{material}'}。</span>
                )}
              </div>
            </div>
          </Section>

          <Section title="材质" hint={`勾选的材质各自导出；没勾选的材质和识别不出材质的订单，都归入「${unknownLabel}」`}>
            {problems.buckets && <FieldError message={problems.buckets} />}
            <div className="orders-materials">
              <div className="orders-material-row head" aria-hidden="true">
                <span>材质</span>
                <span>显示名（用于文件名和工作表名）</span>
                <span>{perFile ? '文件名（留空用上面的模板）' : '位置'}</span>
                <span>顺序</span>
              </div>
              {orderedMaterials.map((material) => {
                const index = draft.buckets.findIndex((bucket) => bucket.material === material);
                const bucket = index >= 0 ? draft.buckets[index] : undefined;
                const field: TemplateField = `bucket:${material}`;
                const labelProblem = problems[`label:${material}`];
                return (
                  <div key={material} className={`orders-material-row${bucket ? ' on' : ''}`}>
                    <label className="orders-check orders-material-name">
                      <input type="checkbox" checked={Boolean(bucket)} onChange={(event) => toggleBucket(material, event.target.checked)} />
                      <span className={`orders-material-dot ${material}`} aria-hidden="true" />
                      {materialLabel(material)}
                    </label>
                    {bucket ? (
                      <>
                        <div className="orders-material-cell">
                          <input
                            className={`orders-input${labelProblem ? ' invalid' : ''}`}
                            value={bucket.label}
                            aria-label={`${materialLabel(material)}的显示名`}
                            onChange={(event) => updateBucket(material, { label: event.target.value })}
                          />
                          <FieldError message={labelProblem} />
                        </div>
                        {perFile ? (
                          <div className="orders-material-cell">
                            <input
                              ref={registerInput(field)}
                              className={`orders-input mono${problems[field] ? ' invalid' : ''}`}
                              value={bucket.fileName ?? ''}
                              placeholder={draft.fileName}
                              spellCheck={false}
                              aria-label={`${materialLabel(material)}的文件名`}
                              onFocus={() => setActiveField(field)}
                              onChange={(event) => updateBucket(material, { fileName: event.target.value })}
                            />
                            <FieldError message={problems[field]} />
                          </div>
                        ) : (
                          <span className="orders-hint">第 {index + 1} 个工作表</span>
                        )}
                        <span className="orders-move">
                          <button
                            type="button"
                            className="ghost orders-icon-button"
                            disabled={index === 0}
                            title="上移"
                            aria-label={`上移${materialLabel(material)}`}
                            onClick={() => moveBucket(index, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="ghost orders-icon-button"
                            disabled={index === draft.buckets.length - 1}
                            title="下移"
                            aria-label={`下移${materialLabel(material)}`}
                            onClick={() => moveBucket(index, 1)}
                          >
                            ↓
                          </button>
                        </span>
                      </>
                    ) : (
                      <span className="orders-hint orders-material-off">不单独导出，归入「{unknownLabel}」</span>
                    )}
                  </div>
                );
              })}
              <div className="orders-material-row unknown on">
                <span className="orders-material-name">
                  <span className="orders-material-dot unknown" aria-hidden="true" />
                  未识别
                </span>
                <div className="orders-material-cell">
                  <input
                    className={`orders-input${problems['label:unknown'] ? ' invalid' : ''}`}
                    value={draft.unknown.label}
                    aria-label="未识别订单的显示名"
                    onChange={(event) => updateUnknown({ label: event.target.value })}
                  />
                  <FieldError message={problems['label:unknown']} />
                </div>
                {perFile && draft.unknown.handling === 'separate' ? (
                  <div className="orders-material-cell">
                    <input
                      ref={registerInput('unknown')}
                      className={`orders-input mono${problems.unknown ? ' invalid' : ''}`}
                      value={draft.unknown.fileName ?? ''}
                      placeholder={draft.fileName}
                      spellCheck={false}
                      aria-label="未识别订单的文件名"
                      onFocus={() => setActiveField('unknown')}
                      onChange={(event) => updateUnknown({ fileName: event.target.value })}
                    />
                    <FieldError message={problems.unknown} />
                  </div>
                ) : (
                  <span className="orders-hint">
                    {draft.unknown.handling === 'skip' ? '本次不导出' : '有未识别的订单时，放在最后一个工作表'}
                  </span>
                )}
                <span />
              </div>
            </div>
            <div className="orders-row">
              <span className="orders-label">未识别的订单</span>
              <div className="orders-control">
                <div className="orders-segmented" role="radiogroup" aria-label="未识别的订单">
                  {UNKNOWN_OPTIONS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="radio"
                      aria-checked={draft.unknown.handling === item.id}
                      className={draft.unknown.handling === item.id ? 'on' : ''}
                      onClick={() => updateUnknown({ handling: item.id })}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <span className="orders-hint">
                  {draft.unknown.handling === 'separate'
                    ? `单独放进「${unknownLabel}」，导出前可以在预览里逐条改材质`
                    : '本次不导出，也不标记为已导出；在预览里改好材质后，下次导出会带上'}
                </span>
              </div>
            </div>
          </Section>

          <Section title="导出列" hint={`已选 ${draft.columns.length} 列，在 Excel 里按下面的顺序从左到右排列`}>
            {problems.columns && <FieldError message={problems.columns} />}
            <div className="orders-columns">
              {ORDER_COLUMN_GROUPS.map((group) => {
                const columns = ORDER_COLUMNS.filter((column) => column.group === group.id);
                const count = columns.filter((column) => selectedColumns.has(column.key)).length;
                return (
                  <div key={group.id} className="orders-column-group">
                    <div className="orders-column-group-head">
                      <b>{group.label}</b>
                      <span className="orders-hint">{count} / {columns.length}</span>
                    </div>
                    <div className="orders-column-options">
                      {columns.map((column) => {
                        const on = selectedColumns.has(column.key);
                        return (
                          <label key={column.key} className={`orders-column-option${on ? ' on' : ''}`}>
                            <input type="checkbox" checked={on} onChange={(event) => toggleColumn(column.key, event.target.checked)} />
                            {column.label}
                          </label>
                        );
                      })}
                    </div>
                    {group.id === 'recipient' && <span className="orders-hint">含买家姓名、电话和地址，只在需要工厂代发时勾选</span>}
                  </div>
                );
              })}
            </div>
            <div className="orders-inline-actions">
              <button
                type="button"
                className="ghost orders-small"
                disabled={draft.columns.join() === DEFAULT_ORDER_COLUMNS.join()}
                onClick={() => update({ columns: [...DEFAULT_ORDER_COLUMNS] })}
              >
                恢复默认列
              </button>
            </div>
          </Section>

          <Section title="默认条件" hint="在导出页选中这个方案时自动勾选；每次导出后会更新为当次的选择">
            <div className="orders-row">
              <span className="orders-label">订单状态</span>
              <div className="orders-control">
                <div className="orders-chips">
                  {ORDER_STATUSES.map((status) => {
                    const on = draft.defaults.statuses.includes(status);
                    return (
                      <button
                        key={status}
                        type="button"
                        aria-pressed={on}
                        className={`orders-chip${on ? ' on' : ''}`}
                        onClick={() => toggleStatus(status)}
                      >
                        {ORDER_STATUS_LABELS[status]}
                      </button>
                    );
                  })}
                </div>
                <label className="orders-check">
                  <input type="checkbox" checked={draft.defaults.onlyNew} onChange={(event) => updateDefaults({ onlyNew: event.target.checked })} />
                  只导出这个方案没导过的订单
                </label>
                <FieldError message={problems.statuses} />
              </div>
            </div>
            <div className="orders-row">
              <span className="orders-label">店铺</span>
              <div className="orders-control">
                <span className="orders-hint">
                  {draft.defaults.shops.length ? `上次导出时勾选的 ${draft.defaults.shops.length} 家店铺` : '全部已授权的店铺'}
                </span>
                {draft.defaults.shops.length > 0 && (
                  <button type="button" className="ghost orders-small" onClick={() => updateDefaults({ shops: [] })}>改为全部店铺</button>
                )}
              </div>
            </div>
          </Section>

          <div className="orders-editor-bar">
            <span className={firstProblem ? 'orders-error-text' : 'orders-hint'}>{statusText}</span>
            {dirty && (
              <button type="button" className="ghost" disabled={saving} onClick={discard}>
                {isNew ? '取消新建' : '放弃修改'}
              </button>
            )}
            <button type="button" disabled={!dirty || saving || Boolean(firstProblem)} onClick={() => void save()}>
              {saving ? '正在保存…' : isNew ? '保存新方案' : '保存方案'}
            </button>
          </div>
        </div>
      </section>

      <MaterialRules />
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="orders-section">
      <div className="orders-section-head">
        <h4>{title}</h4>
        {hint && <span className="orders-hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function FieldError({ message }: { message?: string }) {
  return message ? <span className="orders-field-error">{message}</span> : null;
}

/** 在导出预览里「记住」的商品材质：查看、改材质、删除。 */
function MaterialRules() {
  const [rules, setRules] = useState<OrderMaterialRule[] | null>(null);
  const [error, setError] = useState('');
  const [platformLabels, setPlatformLabels] = useState<Record<string, string>>({});
  const [keyword, setKeyword] = useState('');
  const [busyId, setBusyId] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await api.orderMaterialRules();
      if (!mounted.current) return;
      setRules(data);
      setError('');
    } catch (err) {
      if (mounted.current) setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
    api.orderSources()
      .then((data) => {
        if (mounted.current) setPlatformLabels(Object.fromEntries(data.platforms.map((item) => [item.platform, item.label])));
      })
      .catch(() => {
        /* 读不到平台名时直接显示平台 id */
      });
  }, [load]);

  const filtered = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    if (!rules) return [];
    if (!text) return rules;
    return rules.filter((rule) => [rule.title, rule.productId, rule.productSku].some((value) => value?.toLowerCase().includes(text)));
  }, [rules, keyword]);

  async function changeMaterial(rule: OrderMaterialRule, material: ExportMaterial) {
    setBusyId(rule.id);
    try {
      const updated = await api.updateOrderMaterialRule(rule.id, material);
      if (!mounted.current) return;
      setRules((current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? null);
      showFeedback(`已改为「${materialLabel(material)}」，下次预览和导出时生效`);
    } catch (err) {
      showFeedback(errorMessage(err), 'error');
    } finally {
      if (mounted.current) setBusyId('');
    }
  }

  async function remove(rule: OrderMaterialRule) {
    try {
      await api.deleteOrderMaterialRule(rule.id);
      if (!mounted.current) return;
      setRules((current) => current?.filter((item) => item.id !== rule.id) ?? null);
      showFeedback('已删除，这个商品之后会重新自动判定材质');
    } catch (err) {
      showFeedback(errorMessage(err), 'error');
    }
  }

  return (
    <section className="orders-card orders-rules">
      <div className="orders-rules-head">
        <div>
          <h3>记住的商品材质</h3>
          <span className="orders-hint">
            在导出预览里改材质并勾选「改材质时记住这个商品」后，会保存在这里，以后判定材质时优先使用。只影响订单导出，不会改商品库。
          </span>
        </div>
        {rules && rules.length > 0 && (
          <label className="orders-search">
            <PlannerIcon name="search" size={14} />
            <input
              value={keyword}
              placeholder="搜索商品名、商品 ID 或 SKU"
              aria-label="搜索记住的商品材质"
              onChange={(event) => setKeyword(event.target.value)}
            />
          </label>
        )}
      </div>

      <details className="orders-judge">
        <summary>材质是怎么判定的</summary>
        <ol>
          <li>导出预览里本次手动改的材质</li>
          <li>这里记住的商品材质（先按平台商品 ID 匹配，再按商品 SKU 匹配）</li>
          <li>商品库里人工确认过的分组</li>
          <li>平台商品上填写的材质属性</li>
          <li>商品库自动识别的分组</li>
          <li>商品标题里的关键词：cotton、棉、хлопок 判为棉，polyester、涤纶、полиэстер 判为聚酯纤维，同时出现多种材质判为混纺</li>
        </ol>
        <p>
          按顺序判断，前面的命中就不再往下看；都判断不出的订单归入方案里的「未识别」。导出文件的「材质判定依据」列会写明每一行用的是哪一条。
        </p>
      </details>

      {error && (
        <div className="error">
          {error}
          {' '}
          <button type="button" className="ghost orders-small" onClick={() => void load()}>重试</button>
        </div>
      )}
      {!rules && !error && <div className="orders-loading">正在加载…</div>}
      {rules && rules.length === 0 && <div className="orders-empty">还没有记住的商品。</div>}
      {rules && rules.length > 0 && filtered.length === 0 && (
        <div className="orders-empty">没有找到和「{keyword.trim()}」相关的商品。</div>
      )}
      {filtered.length > 0 && (
        <div className="orders-table-wrap">
          <table className="orders-table orders-rules-table">
            <thead>
              <tr>
                <th>商品</th>
                <th>材质</th>
                <th>更新时间</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((rule) => {
                const known = MATERIAL_OPTIONS.some((option) => option.id === rule.material);
                const ids = [
                  platformLabels[rule.platform] ?? rule.platform,
                  rule.productId ? `商品 ID ${rule.productId}` : '',
                  rule.productSku ? `SKU ${rule.productSku}` : '',
                ].filter(Boolean).join(' · ');
                return (
                  <tr key={rule.id}>
                    <td>
                      <div className="orders-title" title={rule.title}>{rule.title || '（没有商品名称）'}</div>
                      <div className="orders-sub mono">{ids}</div>
                    </td>
                    <td>
                      <select
                        className="orders-select small"
                        value={known ? rule.material : ''}
                        disabled={busyId === rule.id}
                        aria-label={`${rule.title || rule.productSku || rule.productId || '商品'}的材质`}
                        onChange={(event) => void changeMaterial(rule, event.target.value as ExportMaterial)}
                      >
                        {!known && <option value="" disabled>{materialLabel(rule.material)}</option>}
                        {MATERIAL_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                      </select>
                    </td>
                    <td className="nowrap">{formatChinaDateTime(rule.updatedAt)}</td>
                    <td className="orders-cell-action">
                      <ConfirmPopover
                        title="删除这条记住的材质？"
                        description="删除后，这个商品的订单会重新按商品库、材质属性和标题自动判定。"
                        disabled={busyId === rule.id}
                        onConfirm={() => remove(rule)}
                      >
                        <button type="button" className="ghost orders-small" disabled={busyId === rule.id}>删除</button>
                      </ConfirmPopover>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
