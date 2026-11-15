import type { CategoryAttributeRequirement, CategoryRequirements, JoomCategory } from '@shared/types';

/** client.request 已解包 data;顶层可能是数组或 {categories|items:[...]}. 统一取数组。 */
function toArray(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  const o = raw as Record<string, unknown> | undefined;
  if (Array.isArray(o?.categories)) return o!.categories as any[];
  if (Array.isArray(o?.items)) return o!.items as any[];
  return [];
}

export function normalizeCategories(raw: unknown): JoomCategory[] {
  return toArray(raw)
    .filter((c) => c && c.id)
    .map((c) => ({
      id: String(c.id),
      name: String(c.name ?? ''),
      path: String(c.path ?? c.name ?? ''),
      parentId: c.parentId ? String(c.parentId) : undefined,
      takeRate: typeof c.takeRate === 'number' ? c.takeRate : undefined,
    }));
}

/**
 * 合并 requirements 与 attributeValues(按 attributeName 关联可选值)。
 * requirements.attributesRequirements.attributeRequirements[] 为属性列表。
 */
export function normalizeRequirements(
  categoryId: string,
  requirementsRaw: unknown,
  attributeValuesRaw?: unknown,
): CategoryRequirements {
  const r = requirementsRaw as any;
  const reqs: any[] = r?.attributesRequirements?.attributeRequirements ?? [];

  // attributeValues: { items: [{ attributeName, attributeValues: string[] }] }
  const valuesByName = new Map<string, string[]>();
  const items: any[] = (attributeValuesRaw as any)?.items ?? [];
  for (const it of items) {
    if (!it?.attributeName) continue;
    const uniq = Array.from(new Set<string>((it.attributeValues ?? []).map((v: unknown) => String(v))));
    valuesByName.set(String(it.attributeName), uniq);
  }

  const attributes: CategoryAttributeRequirement[] = reqs
    .filter((a) => a && a.attributeId)
    .map((a) => ({
      attributeId: String(a.attributeId),
      attributeName: String(a.attributeName ?? a.attributeId),
      severity: String(a.severity ?? 'optional'),
      supportedKeys: Array.isArray(a.supportedKeys) ? a.supportedKeys.map(String) : undefined,
      goodDescriptionSamples: Array.isArray(a.goodDescriptionSamples) ? a.goodDescriptionSamples : undefined,
      badDescriptionSamples: Array.isArray(a.badDescriptionSamples) ? a.badDescriptionSamples : undefined,
      allowedValues: valuesByName.get(String(a.attributeName)) ?? undefined,
    }));

  const generalLimitations = Array.isArray(r?.generalLimitations)
    ? r.generalLimitations.map((g: any) => ({ description: String(g.description ?? ''), severity: String(g.severity ?? '') }))
    : undefined;

  return { categoryId, attributes, generalLimitations };
}

/** 从要求里挑出必填属性(severity === 'required')。 */
export function requiredAttributes(req: CategoryRequirements): Array<{ id: string; name: string }> {
  return req.attributes
    .filter((a) => a.severity.toLowerCase() === 'required')
    .map((a) => ({ id: a.attributeId, name: a.attributeName }));
}
