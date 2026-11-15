/** 合并不同变体上的同类错误；原始报错由界面完整保留。 */
export function summarizeError(message: string) {
  const entries = message.split(/[；;\n]+/).map((text) => text.trim()).filter(Boolean);
  const groups = new Map<string, { count: number; variants: Set<string> }>();
  for (const entry of entries) {
    const field = entry.match(/^variants\.(\d+)\.([\w.]+)\s*[:：]\s*/);
    const body = field ? entry.slice(field[0].length) : entry;
    const variant = body.match(/^变体\s*(\d+)\s*[:：]\s*/);
    const text = variant ? body.slice(variant[0].length) : body;
    // 保留字段名，避免不同字段恰好使用相同文案时被误合并。
    const key = `${field?.[2] ?? ''}\0${text}`;
    const group = groups.get(key) ?? { count: 0, variants: new Set<string>() };
    group.count += 1;
    if (field) group.variants.add(String(Number(field[1]) + 1));
    else if (variant) group.variants.add(variant[1]);
    groups.set(key, group);
  }
  const summaries = [...groups].map(([key, group]) => {
    const text = key.split('\0')[1];
    const count = group.variants.size;
    return `${text}${count ? `（${count} 个变体）` : group.count > 1 ? `（重复 ${group.count} 次）` : ''}`;
  });
  const summary = summaries.slice(0, 3).join('；') + (summaries.length > 3 ? `；另有 ${summaries.length - 3} 类问题` : '');
  return {
    summary: summary.length > 220 ? `${summary.slice(0, 219)}…` : summary,
    count: entries.length,
    expandable: message.length > 180 || entries.length > 1,
  };
}
