import type { ProductIndexItem } from '@shared/product-catalog';
import { useMemo, useState } from 'react';
import type { GroupTemplateBinding, ProductGroupId, ProductMaterial, ProductRecord } from '@shared/types';
import { findGroupTemplateBinding, groupLabel, inferProductGrouping, materialLabel, PRODUCT_GROUPS, PRODUCT_MATERIALS } from '@shared/product-grouping';

export type TemplateFilter = 'all' | 'pending' | 'confirmed';
export interface GroupFilters {
  group: ProductGroupId | 'all';
  material: ProductMaterial | 'all';
  template: TemplateFilter;
}
export const EMPTY_GROUP_FILTERS: GroupFilters = { group: 'all', material: 'all', template: 'all' };
export const groupingOf = (p: ProductRecord) => p.grouping ?? inferProductGrouping(p.collected);
export function matchesGroupFilters(p: ProductIndexItem, filters: GroupFilters) {
  const g = p.grouping;
  return (filters.group === 'all' || g.groupId === filters.group)
    && (filters.material === 'all' || g.material === filters.material)
    && (filters.template === 'all' || Boolean(p.templateConfirmed) === (filters.template === 'confirmed'));
}

export function ProductGroupingPanel(props: {
  items: ProductIndexItem[];
  visible: ProductIndexItem[];
  filters: GroupFilters;
  onChange: (filters: GroupFilters) => void;
  templates: Array<{ id: string; name: string }>;
  bindings: GroupTemplateBinding[];
  onBind: (binding: Omit<GroupTemplateBinding, 'templateId'> & { templateId: string | null }) => Promise<void>;
  onApply: (ids: string[], templateId: string) => void;
  onSelect: (ids: string[]) => void;
  onCorrect: (groupId: ProductGroupId, material?: ProductMaterial) => void;
  selectedCount: number;
  activeIds: Set<string>;
  disabled: boolean;
  locked: boolean;
}) {
  const { items, visible, filters, templates, bindings, disabled, locked } = props;
  const [bindingTemplateId, setBindingTemplateId] = useState('');
  const [correctionGroup, setCorrectionGroup] = useState<ProductGroupId>(filters.group === 'all' ? 'men-short' : filters.group);
  const [correctionMaterial, setCorrectionMaterial] = useState<ProductMaterial | 'keep'>('keep');
  const groups = useMemo(() => PRODUCT_GROUPS.map((g) => ({ ...g, count: items.filter((p) => p.grouping.groupId === g.id).length })), [items]);
  const inGroup = items.filter((p) => filters.group === 'all' || p.grouping.groupId === filters.group);
  const counts = PRODUCT_MATERIALS.map((m) => ({ ...m, count: inGroup.filter((p) => p.grouping.material === m.id).length }));
  const withMaterial = inGroup.filter((p) => filters.material === 'all' || p.grouping.material === filters.material);
  const confirmedCount = withMaterial.filter((p) => p.templateConfirmed).length;
  const eligible = visible.filter((p) => p.status !== 'discarded' && p.status !== 'publishing' && !props.activeIds.has(p.id));
  const pending = eligible.filter((p) => !p.templateConfirmed);
  const binding = findGroupTemplateBinding(bindings, filters.group, filters.material);
  const recommended = templates.find((t) => t.id === binding?.templateId);
  const canBind = filters.group !== 'all' && filters.group !== 'pending' && filters.material !== 'unknown';
  const exactBinding = bindings.find((b) => b.groupId === filters.group && b.material === filters.material);
  const nextGroup = groups.find((g) => g.id !== filters.group && items.some((p) => p.grouping.groupId === g.id && !p.templateConfirmed && p.status !== 'discarded' && p.status !== 'publishing' && !props.activeIds.has(p.id)));
  const canAct = !disabled && !locked;

  return <section className="collection-group-panel" aria-label="采集自动分组">
    <div className="collection-group-head">
      <div><strong>采集自动分组</strong><span>按原商品信息分组 · 选组 → 筛材质 → 套预设 → 发布</span></div>
      {(filters.group !== 'all' || filters.material !== 'all' || filters.template !== 'all') &&
        <button className="ghost" disabled={!canAct} onClick={() => props.onChange(EMPTY_GROUP_FILTERS)}>清除分组筛选</button>}
    </div>
    {locked && <p className="hint">ID 检索期间暂停分组筛选，退出检索后可继续处理。</p>}
    <div className="collection-group-tabs" role="group" aria-label="按商品类型分组">
      <button className={filters.group === 'all' ? 'on' : ''} aria-pressed={filters.group === 'all'} disabled={!canAct}
        onClick={() => props.onChange({ ...filters, group: 'all', material: 'all' })}>全部分组 <b>{items.length}</b></button>
      {groups.filter((g) => g.count > 0 || g.id === filters.group).map((g) =>
        <button key={g.id} className={filters.group === g.id ? 'on' : ''} aria-pressed={filters.group === g.id} disabled={!canAct}
          onClick={() => props.onChange({ ...filters, group: g.id, material: 'all' })}>{g.label} <b>{g.count}</b></button>)}
    </div>
    <div className="collection-group-filters">
      <label>材质
        <select aria-label="按原商品材质筛选" value={filters.material} disabled={!canAct}
          onChange={(e) => props.onChange({ ...filters, material: e.target.value as GroupFilters['material'] })}>
          <option value="all">全部材质（{inGroup.length}）</option>
          {counts.map((m) => <option key={m.id} value={m.id}>{m.label}（{m.count}）</option>)}
        </select>
      </label>
      <div className="collection-group-tabs" role="group" aria-label="预设确认状态">
        {([{ id: 'all', label: '全部', count: withMaterial.length }, { id: 'pending', label: '待确认预设', count: withMaterial.length - confirmedCount }, { id: 'confirmed', label: '已确认预设', count: confirmedCount }] as const).map((f) =>
          <button key={f.id} className={filters.template === f.id ? 'on' : ''} aria-pressed={filters.template === f.id} disabled={!canAct}
            onClick={() => props.onChange({ ...filters, template: f.id })}>{f.label} <b>{f.count}</b></button>)}
      </div>
      <button className="ghost" disabled={!canAct || !eligible.length} onClick={() => props.onSelect(eligible.map((p) => p.id))}>
        全选当前{filters.group === 'all' ? '筛选' : '组'}（{eligible.length}）
      </button>
      <button className="ghost" disabled={!canAct || !nextGroup} onClick={() => nextGroup && props.onChange({ group: nextGroup.id, material: 'all', template: 'pending' })}>下一个待处理组</button>
    </div>
    {filters.group !== 'all' && <div className="collection-group-binding">
      <div className="collection-group-recommendation">
        <span>{recommended ? `建议预设：${recommended.name}` : filters.material === 'unknown' ? '材质未知，请确认后选择预设' : filters.group === 'pending' ? '请先确认商品类型，再选择预设' : '此组尚未设置常用预设，可从下方快捷模板选择'}</span>
        {recommended && <button disabled={!canAct || !pending.length} onClick={() => props.onApply(pending.map((p) => p.id), recommended.id)}>套用本组待确认商品（{pending.length}）</button>}
        {filters.material === 'all' && <small>整组可能包含不同或未知材质，套用前请确认。</small>}
      </div>
      {canBind && <div className="collection-group-filters">
        <span className="hint">常用预设：{groupLabel(filters.group as ProductGroupId)} · {filters.material === 'all' ? '全部材质' : materialLabel(filters.material)}</span>
        <select aria-label="选择此组常用预设" value={bindingTemplateId || exactBinding?.templateId || ''} disabled={!canAct} onChange={(e) => setBindingTemplateId(e.target.value)}>
          <option value="">请选择预设</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button className="ghost" disabled={!canAct || !(bindingTemplateId || exactBinding)} onClick={() => void props.onBind({ groupId: filters.group as ProductGroupId, material: filters.material, templateId: bindingTemplateId || exactBinding!.templateId })}>保存为此组常用预设</button>
        {exactBinding && <button className="ghost" disabled={!canAct} onClick={() => void props.onBind({ groupId: filters.group as ProductGroupId, material: filters.material, templateId: null })}>取消绑定</button>}
      </div>}
    </div>}
    <details className="collection-group-correction">
      <summary>分组有误？批量调整分组 / 材质</summary>
      <div className="collection-group-filters">
        <select aria-label="调整到分组" value={correctionGroup} disabled={!canAct} onChange={(e) => setCorrectionGroup(e.target.value as ProductGroupId)}>
          {PRODUCT_GROUPS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
        </select>
        <select aria-label="调整商品材质" value={correctionMaterial} disabled={!canAct} onChange={(e) => setCorrectionMaterial(e.target.value as ProductMaterial | 'keep')}>
          <option value="keep">保留原材质判断</option>
          {PRODUCT_MATERIALS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <button className="ghost" disabled={!canAct || !props.selectedCount} onClick={() => props.onCorrect(correctionGroup, correctionMaterial === 'keep' ? undefined : correctionMaterial)}>调整所选 {props.selectedCount} 件</button>
        <small>类型或材质改变后，商品会重新进入“待确认预设”。</small>
      </div>
    </details>
  </section>;
}

export function ProductGroupingBadges({ product }: { product: ProductIndexItem }) {
  const grouping = product.grouping;
  return <div className="collection-group-badges" title={grouping.reason}>
    <span>{groupLabel(grouping.groupId)}{grouping.source === 'manual' ? ' · 手动' : ''}</span>
    <span className={grouping.material === 'unknown' ? 'unknown' : ''}>{materialLabel(grouping.material)}</span>
    <span className={product.templateConfirmed ? 'confirmed' : 'unknown'}>{product.templateConfirmed ? '已确认预设' : '待确认预设'}</span>
  </div>;
}
