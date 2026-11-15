import { useEffect, useMemo, useRef, useState } from 'react';
import { splitCategoryPath, type CatOption } from './categories';

const MAX_RESULTS = 60;

export function CategoryPicker({
  categories,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  categories: CatOption[];
  value?: string;
  onChange: (categoryId: string | undefined) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const selected = useMemo(
    () => (value ? categories.find((c) => c.id === value) : undefined),
    [categories, value],
  );
  const selectedLabel = selected?.localizedLabel ?? selected?.label ?? value ?? '';
  const selectedSourceLabel = selected?.localizedLabel ? selected.label : '';
  const selectedParts = splitCategoryPath(selectedLabel);

  const { results, hiddenCount } = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return { results: [] as CatOption[], hiddenCount: 0 };
    const matched = categories.filter(
      (c) => `${c.label} ${c.localizedLabel ?? ''} ${c.id}`.toLowerCase().includes(q),
    );
    return { results: matched.slice(0, MAX_RESULTS), hiddenCount: Math.max(0, matched.length - MAX_RESULTS) };
  }, [categories, query]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => setActive(0), [query]);

  function pick(id: string) {
    onChange(id);
    setQuery('');
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!open || !results.length) {
      if (e.key === 'Enter' && query.trim()) {
        const exact = categories.find((c) => c.id === query.trim() || c.label === query.trim() || c.localizedLabel === query.trim());
        if (exact) pick(exact.id);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = results[active];
      if (hit) pick(hit.id);
    }
  }

  return (
    <div className="cat-picker" ref={rootRef}>
      {value ? (
        <div className="cat-selected">
          <div>
            <strong>{selectedParts.leaf || '已选类目'}</strong>
            {selectedParts.parents && <p>{selectedParts.parents}</p>}
            {selectedSourceLabel && <p className="cat-source-label">平台名称：{selectedSourceLabel}</p>}
            {!selected && <p className="mono">{value}</p>}
          </div>
          <button type="button" className="ghost" disabled={disabled} onClick={() => onChange(undefined)}>
            清除
          </button>
        </div>
      ) : (
        <p className="muted" style={{ margin: '0 0 8px' }}>
          还没选类目
        </p>
      )}

      <input
        ref={inputRef}
        value={query}
        disabled={disabled}
        placeholder={placeholder ?? (categories.length ? '搜索中文、西语类目名称或 ID…' : '连接 Joom 后可搜索')}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        autoComplete="off"
      />

      {open && (
        <div className="cat-menu" role="listbox">
          {!query.trim() && (
            <div className="cat-empty">输入关键词筛选，例如 unisex、童装、t-shirt。结果会显示完整路径。</div>
          )}
          {query.trim() && !results.length && (
            <div className="cat-empty">没有匹配的类目。也可以粘贴完整 categoryId 后回车。</div>
          )}
          {results.map((c, i) => {
            const displayLabel = c.localizedLabel ?? c.label;
            const parts = splitCategoryPath(displayLabel);
            return (
              <button
                key={c.id}
                type="button"
                role="option"
                className={`cat-option ${c.id === value ? 'picked' : ''} ${i === active ? 'active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(c.id)}
              >
                <strong>{highlight(parts.leaf, query)}</strong>
                {parts.parents && <span>{highlight(parts.parents, query)}</span>}
                {c.localizedLabel && <span className="cat-source-label">平台名称：{c.label}</span>}
              </button>
            );
          })}
          {hiddenCount > 0 && <div className="cat-empty">还有 {hiddenCount} 条，再输入几个字可以缩小范围</div>}
        </div>
      )}

      {value && <div className="hint">categoryId: {value}</div>}
    </div>
  );
}

function highlight(text: string, query: string) {
  const q = query.trim();
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}
