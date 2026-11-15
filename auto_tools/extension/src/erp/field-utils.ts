/** 只匹配完整选项或中英文括号内的名称，避免 summer 命中 Spring And Summer。 */
export function aliasesMatch(value: string, aliases: string[]): boolean {
  const normalize = (text: string) => text.toLocaleLowerCase().replace(/\s/g, '').replace(/（/g, '(').replace(/）/g, ')');
  const actual = normalize(value);
  const parts = value.split(/[（）()]/).map(normalize);
  return aliases.some(alias => {
    const target = normalize(alias);
    return !!target && (actual === target || actual.startsWith(`${target}(`) || parts.includes(target));
  });
}

/** ERP 会给运费模板加数量不固定的 copy 前缀；按稳定模板名匹配。 */
export function shippingTemplateMatches(value: string, aliases: string[]): boolean {
  const normalize = (text: string) => text.toLocaleLowerCase()
    .trim()
    .replace(/^(?:copy\s+)+/i, '')
    .replace(/\s/g, '');
  const actual = normalize(value);
  return !!actual && aliases.some(alias => normalize(alias) === actual);
}

/** 多颜色表格通过 rowspan 合并尺码列，物理单元格序号不能当作逻辑列号。 */
export function cellAt(row: Element, index: number): HTMLTableCellElement | null {
  const cells = [...row.querySelectorAll<HTMLTableCellElement>(':scope > td')];
  if (cells.some(cell => cell.hasAttribute('index'))) {
    return cells.find(cell => cell.getAttribute('index') === String(index)) ?? null;
  }
  return cells[index] ?? null;
}

/** 表格的下拉框前面可能有隐藏校验输入，检查时读取用户看到的控件。 */
export function skuInputs(cell: Element | null): HTMLInputElement[] {
  return [...(cell?.querySelectorAll<HTMLInputElement>('input') || [])]
    .filter(input => input.type !== 'hidden' && input.style.display !== 'none' && !input.hidden);
}

/** 只转换已经核实的颜色同义词，其余规格必须在新选项中同名匹配。 */
export function specAliases(value: string): string[] {
  // 规格升级时优先映射到平台中文属性，避免 Black 留在旧的英文值上。
  const colors: Record<string, string[]> = { black: ['黑色', 'Black'], '黑色': ['黑色', 'Black'], white: ['白色', 'White'], '白色': ['白色', 'White'] };
  return colors[value.trim().toLowerCase()] || [value.trim()];
}

/** 按可见字符截断标题，避免在代理对中间切开 emoji。 */
export function truncateTitle(value: string, maxLength = 128): string {
  return Array.from(value).slice(0, maxLength).join('').trimEnd();
}

/** 使用最大合规裁剪框；已经符合比例的原图保持原尺寸，避免 1799 方图被截成中心 800。 */
export function marketingCrop(width: number, height: number, portrait = height > width * 1.15): { portrait: boolean; width: number; height: number } | null {
  if (portrait) {
    // ERP 的裁剪器可按目标尺寸导出。方形 800px 首图裁成 3:4 后有 600×800，
    // 允许按 750×1000 输出；更小的源图则避免过度放大。
    const sourceUnit = Math.floor(Math.min(width / 3, height / 4));
    return sourceUnit >= 200 ? { portrait: true, width: 750, height: 1000 } : null;
  }
  const unit = Math.floor(Math.min(width, height));
  return unit >= 800 ? { portrait: false, width: unit, height: unit } : null;
}
