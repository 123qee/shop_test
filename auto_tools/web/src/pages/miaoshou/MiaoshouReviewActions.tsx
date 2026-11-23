import { useState } from 'react';
import type { MiaoshouCandidate, MiaoshouSummary } from '@shared/miaoshou';
import { useNativePrompt } from '../../components/NativePromptProvider';
import { miaoshouApi } from './api';

export function MiaoshouReviewActions({ draft, busy, run }: { draft: MiaoshouSummary; busy: boolean; run: (work: () => Promise<unknown>, message: string) => Promise<void> }) {
  const [candidates, setCandidates] = useState<MiaoshouCandidate[] | null>(null);
  const { confirm, prompt } = useNativePrompt();
  return <>
    <button className="ghost" disabled={busy} onClick={() => void run(async () => setCandidates(await miaoshouApi.reviewCandidates(draft.id, draft.version)), '已查询当前来源 ID 在目标店铺的采集箱商品。')}>查询妙手结果</button>
    {candidates && <div className="ms-review-candidates">{candidates.length ? candidates.map(c => <div key={c.remoteId}><span>{c.title}</span><small>采集箱 ID：{c.remoteId}</small><button className="ghost" disabled={busy} onClick={() => void run(() => miaoshouApi.reconcile(draft.id, draft.version, c.remoteId), '已核对并关联妙手采集箱商品。')}>核对此条并关联</button></div>) : <p className="ms-note">前 20 条查询结果中没有目标店铺匹配项，请在妙手继续核对。</p>}</div>}
    <button className="ghost" disabled={busy} onClick={async () => { const id = await prompt('填写妙手采集箱商品 ID，系统会核对来源、店铺、标题、SKU、站点和净收益。', draft.remoteId ?? ''); if (id) void run(() => miaoshouApi.reconcile(draft.id, draft.version, id.trim()), '已核对并关联妙手采集箱商品。'); }}>手动关联 ID</button>
    {!draft.remoteId && <button className="ghost" disabled={busy} onClick={async () => { if (await confirm('请先在妙手核对该商品确实没有入箱。确认后将允许重新提交，若商品已经存在会造成重复创建。')) void run(() => miaoshouApi.release(draft.id, draft.version), '已解除待核对状态，可以重新提交。'); }}>已核对未入箱</button>}
  </>;
}
