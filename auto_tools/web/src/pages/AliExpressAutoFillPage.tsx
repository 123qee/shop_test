import { useEffect, useMemo, useState } from 'react';
import { cloneAliExpressAutoFillDefaults, type AliExpressAutoFillConfig, type AliExpressFillField } from '@shared/aliexpress-auto-fill';
import { api } from '../api';

const GROUP_ORDER = ['标题与基础', '分类与基础', '商品属性', '模板与资质', '成分信息', '价格与库存', '包裹与物流'];

export function AliExpressAutoFillPage() {
  const [config, setConfig] = useState<AliExpressAutoFillConfig | null>(null);
  const [saved, setSaved] = useState<AliExpressAutoFillConfig | null>(null);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void api.aliexpressAutoFillConfig().then((value) => {
      setConfig(value);
      setSaved(value);
    }).catch((reason) => setError((reason as Error).message));
  }, []);

  const dirty = Boolean(config && saved && JSON.stringify(config.fields) !== JSON.stringify(saved.fields));
  const enabledCount = config?.fields.filter((field) => field.enabled).length ?? 0;
  const groups = useMemo(() => {
    if (!config) return [];
    const query = search.trim().toLocaleLowerCase();
    return GROUP_ORDER.map((group) => ({
      group,
      fields: config.fields.filter((field) => field.group === group && (!query || `${field.label} ${field.value} ${field.help}`.toLocaleLowerCase().includes(query))),
    })).filter((entry) => entry.fields.length > 0);
  }, [config, search]);

  function updateField(id: string, patch: Partial<AliExpressFillField>) {
    setConfig((current) => current ? { ...current, fields: current.fields.map((field) => field.id === id ? { ...field, ...patch } : field) } : current);
    setMessage('');
  }

  async function save() {
    if (!config) return;
    const titleLimit = Number(config.fields.find((field) => field.id === 'titleMaxChars')?.value);
    if (!Number.isInteger(titleLimit) || titleLimit < 1 || titleLimit > 255) {
      setError('标题上限需要填写 1–255 的整数。');
      return;
    }
    for (const field of config.fields.filter((item) => item.kind === 'number')) {
      if (!Number.isFinite(Number(field.value)) || Number(field.value) < 0) {
        setError(`「${field.label}」请输入不小于 0 的数字。`);
        return;
      }
    }
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const next = await api.saveAliExpressAutoFillConfig(config);
      setConfig(next);
      setSaved(next);
      setMessage('已保存。新配置会在下一次点击速卖通自动填充时读取。');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    if (!config) return;
    const defaults = cloneAliExpressAutoFillDefaults();
    setConfig({ ...defaults, fields: defaults.fields.map((field) => {
      const current = config.fields.find((item) => item.id === field.id);
      return current ? { ...field, enabled: current.enabled } : field;
    }) });
    setMessage('默认值已载入页面，点击保存后生效。');
    setError('');
  }

  return (
    <div className="autofill-page">
      <section className="autofill-intro">
        <div>
          <span className="autofill-eyebrow">ALIEXPRESS · AUTOMATION</span>
          <h2>速卖通自动填充字段</h2>
          <p>集中查看每个字段当前使用的值。修改并保存后，扩展下次自动填充会读取这里的配置。</p>
        </div>
        <div className="autofill-summary"><strong>{enabledCount}<small> / {config?.fields.length ?? 0}</small></strong><span>启用字段</span></div>
      </section>

      <section className="autofill-toolbar">
        <label className="autofill-search"><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索字段、当前值或说明" /></label>
        <div className="autofill-actions">
          <span className="autofill-save-state">{dirty ? '有未保存的修改' : saved?.updatedAt ? `上次保存 ${new Date(saved.updatedAt).toLocaleString()}` : '使用默认配置'}</span>
          <button className="button secondary" type="button" onClick={reset} disabled={!config || saving}>恢复默认值</button>
          <button className="button primary" type="button" onClick={() => void save()} disabled={!dirty || saving}>{saving ? '保存中…' : '保存配置'}</button>
        </div>
      </section>

      {message && <div className="autofill-message success" role="status">✓ {message}</div>}
      {error && <div className="autofill-message error" role="alert">{error}</div>}
      {!config && !error && <div className="autofill-loading">正在读取字段配置…</div>}

      <div className="autofill-groups">
        {groups.map(({ group, fields }) => (
          <section className="autofill-group" key={group}>
            <header><div><h3>{group}</h3><span>{fields.length} 个字段</span></div><small>修改当前值，或关闭不需要自动处理的字段</small></header>
            <div className="autofill-table-head"><span>字段</span><span>当前填充值</span><span>自动填充</span></div>
            {fields.map((field) => (
              <div className={`autofill-row${field.enabled ? '' : ' disabled'}`} key={field.id}>
                <div className="autofill-field-name"><strong>{field.label}</strong><small>{field.help}</small></div>
                <label className="autofill-value">
                  <span className="sr-only">{field.label}当前填充值</span>
                  <input type={field.kind === 'number' ? 'number' : 'text'} min={field.kind === 'number' ? 0 : undefined} step={field.kind === 'number' ? 'any' : undefined} value={field.value} disabled={!field.enabled || saving} onChange={(event) => updateField(field.id, { value: event.target.value })} />
                </label>
                <label className="autofill-toggle"><input type="checkbox" checked={field.enabled} disabled={saving} onChange={(event) => updateField(field.id, { enabled: event.target.checked })} /><span>{field.enabled ? '启用' : '停用'}</span></label>
              </div>
            ))}
          </section>
        ))}
        {config && groups.length === 0 && <div className="autofill-empty">没有找到匹配字段。</div>}
      </div>

      <p className="autofill-footnote">自动化仅填写页面，不会替你保存或发布商品。带有多个匹配值时用 <code>|</code> 分隔；尺寸和多选属性也按页面提示输入。</p>
    </div>
  );
}

