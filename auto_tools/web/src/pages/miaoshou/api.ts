import type { MiaoshouCandidate, MiaoshouCategory, MiaoshouConfigPublic, MiaoshouDraft, MiaoshouRules, MiaoshouShop, MiaoshouTemplate, MiaoshouWorkspace } from '@shared/miaoshou';

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api/miaoshou' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error([data.error || `请求失败 (${response.status})`, ...(data.details ?? []).map((d: { message: string }) => d.message)].join('；'));
  return data as T;
}
let shopsPromise: Promise<{ shops: MiaoshouShop[] }> | undefined;
export const miaoshouApi = {
  workspace: () => request<MiaoshouWorkspace>('/workspace'),
  config: (input: { appKey?: string; appSecret?: string; defaultShopId: string; defaultSites: MiaoshouConfigPublic['defaultSites'] }) => { shopsPromise = undefined; return request<MiaoshouConfigPublic>('/config', 'PUT', input); },
  shops: (refresh = false) => { if (refresh || !shopsPromise) shopsPromise = request<{ shops: MiaoshouShop[] }>('/test-connection', 'POST').catch(e => { shopsPromise = undefined; throw e; }); return shopsPromise; },
  categories: () => request<MiaoshouCategory[]>('/categories'),
  rules: (shopId: string, categoryId: string) => request<MiaoshouRules>(`/rules?shopId=${encodeURIComponent(shopId)}&categoryId=${encodeURIComponent(categoryId)}`),
  saveTemplate: (template: MiaoshouTemplate) => { const { id, ...body } = template; return request<MiaoshouTemplate>(`/templates/${id}`, 'PUT', body); },
  deleteTemplate: (id: string) => request<void>(`/templates/${id}`, 'DELETE'),
  open: (productId: string) => request<MiaoshouDraft>('/drafts', 'POST', { productId }),
  get: (id: string) => request<MiaoshouDraft>(`/drafts/${id}`),
  update: (draft: MiaoshouDraft, patch: Partial<MiaoshouDraft>) => request<MiaoshouDraft>(`/drafts/${draft.id}`, 'PATCH', { version: draft.version, patch }),
  decide: (draft: Pick<MiaoshouDraft, 'id' | 'version'>, action: 'ready' | 'pending' | 'skipped', templateId?: string) => request<MiaoshouDraft>(`/drafts/${draft.id}/decision`, 'POST', { version: draft.version, action, templateId }),
  undo: (id: string) => request<MiaoshouDraft>(`/undo/${id}`, 'POST'),
  validate: (id: string) => request<{ issues: string[] }>(`/drafts/${id}/validate`, 'POST'),
  submit: (items: { id: string; version: number }[]) => request<MiaoshouDraft[]>('/submit', 'POST', { items }),
  reconcile: (id: string, version: number, remoteId: string) => request<MiaoshouDraft>(`/drafts/${id}/reconcile`, 'POST', { version, remoteId }),
  reviewCandidates: (id: string, version: number) => request<MiaoshouCandidate[]>(`/drafts/${id}/review-candidates?version=${version}`),
  release: (id: string, version: number) => request<MiaoshouDraft>(`/drafts/${id}/release`, 'POST', { version, checkedNotCreated: true }),
};
