import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AiTitleMaterial, AiTitlePreviewItem } from '@shared/types';
import { api } from '../api';
import { useNativePrompt } from '../components/NativePromptProvider';

interface Row extends AiTitlePreviewItem {
  selected: boolean;
}

const MATERIAL_LABEL: Record<AiTitleMaterial, string> = {
  cotton: '棉',
  polyester: '聚酯纤维',
};

export function AiTitleDialog({
  ids,
  material,
  busy,
  onClose,
  onApply,
}: {
  ids: string[];
  material: AiTitleMaterial;
  busy: boolean;
  onClose: () => void;
  onApply: (items: Array<{ id: string; title: string; tags?: string[] }>, syncRemote: boolean) => Promise<void>;
}) {
  const nativePrompt = useNativePrompt();
  const [generating, setGenerating] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const started = useRef(false);

  const selectedRows = useMemo(() => rows.filter((r) => r.selected && r.ok && r.title?.trim()), [rows]);

  async function generate() {
    if (!ids.length || generating) return;
    setGenerating(true);
    setError('');
    try {
      const items = await api.batchAiTitles({ ids, material, includeTags: true });
      setRows(items.map((item) => ({ ...item, selected: item.ok })));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api
      .getAiConfig()
      .then((c) => {
        setConfigured(c.configured);
        if (c.configured) generate();
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  async function apply() {
    if (!selectedRows.length || busy) return;
    const syncRemote = await nativePrompt.confirm('是否同时把已发布商品的新标题提交到 Joom？未发布商品只保存本地草稿。');
    await onApply(
      selectedRows.map((r) => ({
        id: r.id,
        title: r.title!.trim(),
        tags: r.tags?.length ? r.tags : undefined,
      })),
      syncRemote,
    );
  }

  const patchRow = (id: string, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="ai-title-dialog-title">
      <div className="modal ai-modal">
        <div className="modal-head">
          <div>
            <h2 id="ai-title-dialog-title">预览 AI 标题 · {MATERIAL_LABEL[material]}</h2>
            <p className="hint">核对后再写入。不想预览时，关掉批量条上的「先预览」即可直接改写。</p>
          </div>
          <button className="ghost" onClick={onClose} disabled={generating || busy}>
            关闭
          </button>
        </div>

        <div className="modal-body">
          {error && <div className="error">{error}</div>}
          {!configured && (
            <div className="error">
              还没配置 DeepSeek API Key。<Link to="/settings">去采集预设页填写</Link>
            </div>
          )}

          {!rows.length && configured && (
            <p className="muted">{generating ? `正在按「${MATERIAL_LABEL[material]}」生成 ${ids.length} 个标题…` : '准备生成…'}</p>
          )}

          {rows.length > 0 && (
            <div className="ai-preview">
              <div className="ai-preview-bar">
                <span>
                  成功 {rows.filter((r) => r.ok).length}/{rows.length} · 将应用 {selectedRows.length} 条
                </span>
                <button className="ghost" type="button" onClick={() => setRows((prev) => prev.map((r) => ({ ...r, selected: r.ok })))}>
                  全选成功项
                </button>
              </div>
              {rows.map((row) => (
                <div key={row.id} className={`ai-row ${row.ok ? '' : 'ai-row-fail'}`}>
                  <label className="ck">
                    <input
                      type="checkbox"
                      checked={row.selected}
                      disabled={!row.ok}
                      onChange={(e) => patchRow(row.id, { selected: e.target.checked })}
                    />
                  </label>
                  {row.image ? <img src={row.image} alt="" /> : <div className="ai-ph" />}
                  <div className="ai-cols">
                    <div>
                      <span className="muted">原标题</span>
                      <p>{row.original || '（无标题）'}</p>
                    </div>
                    <div>
                      <span className="muted">新标题{row.title ? ` · ${row.title.length} 字` : ''}</span>
                      {row.ok ? (
                        <textarea rows={2} value={row.title ?? ''} onChange={(e) => patchRow(row.id, { title: e.target.value })} />
                      ) : (
                        <p className="ai-fail">{row.error}</p>
                      )}
                      {row.warning && <small className="ai-warn">{row.warning}</small>}
                      {row.tags?.length ? <small className="hint">tags: {row.tags.join(', ')}</small> : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <span className="muted">已选 {ids.length} 个 · 不会自动发布</span>
          <div className="modal-actions">
            <button className="ghost" onClick={onClose} disabled={generating || busy}>
              取消
            </button>
            <button className="ghost preset-action" onClick={generate} disabled={generating || busy || !configured}>
              {generating ? `生成中…(${ids.length} 个)` : '重新生成'}
            </button>
            <button onClick={apply} disabled={busy || generating || !selectedRows.length}>
              {busy ? '写入中…' : `应用选中 ${selectedRows.length} 条`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
