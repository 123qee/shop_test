export interface CatOption {
  id: string;
  label: string;
  /** 可选的本地化显示名/搜索别名；原始 label 仍用于提交和兜底展示。 */
  localizedLabel?: string;
}

/** 兼容 Joom /productCategories 的多种可能结构,归一化为 {id,label}。 */
export function normCategories(data: unknown): CatOption[] {
  const arr: any[] = Array.isArray(data)
    ? data
    : ((data as any)?.categories ?? (data as any)?.items ?? (data as any)?.data ?? []);
  return arr
    .map((c) => ({ id: String(c?.id ?? c?.categoryId ?? ''), label: String(c?.path ?? c?.name ?? c?.id ?? '') }))
    .filter((c) => c.id);
}

export function categoryLabelFor(categories: CatOption[], categoryId?: string): string {
  if (!categoryId) return '';
  return categories.find((c) => c.id === categoryId)?.label ?? categoryId;
}

/** 把 "A > B > C" 拆成末级类目 + 上级路径，方便窄栏里看全。 */
export function splitCategoryPath(label: string): { leaf: string; parents: string } {
  const parts = label.split(/\s*(?:>|\/)\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return { leaf: label, parents: '' };
  return { leaf: parts[parts.length - 1], parents: parts.slice(0, -1).join(' › ') };
}
