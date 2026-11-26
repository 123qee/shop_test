import type { ProductIndexItem, ProductListCard, CatalogIndexResponse, ProductSortCandidate } from '@shared/product-catalog';
import type {
  ApiError,
  BatchPublishItem,
  PublishJob,
  PublishReviewAction,
  BatchRemoveRemoteItem,
  BatchValidateItem,
  CategoryRequirements,
  EditableProduct,
  JoomCategory,
  JoomStatus,
  PresetsConfig,
  ProductRecord,
  GroupTemplateBinding,
  ValidateResponse,
  BatchOperation,
  BatchOperationItem,
  DashboardStats,
  AuditLogEntry,
  ImageCheckResult,
  JoomSyncItem,
  JoomShopSyncResult,
  JoomShopStatusSummary,
  AiConfigPublic,
  AiTitlePreviewItem,
  AiTitleMaterial,
  JoomRemoveReason,
  ShopsConfigPublic,
  PicuiConfigPublic,
  MercadoLibreConfigPublic,
  MercadoLibreListingDraft,
  MercadoLibreListingIndexItem,
  MercadoLibreTemplate,
  MercadoLibreValidationResponse,
  TemplateDecisionResult,
} from '@shared/types';
import type { PlannerData, PersonalProject, PersonalTask, ProjectInput, TaskInput } from '@shared/planner';
import type { AliExpressAutoFillConfig } from '@shared/aliexpress-auto-fill';
import type {
  ExportMaterial,
  OrderExportProfile,
  OrderExportRecord,
  OrderMaterialRule,
  OrderPreview,
  OrderQueryInput,
  OrderShopRef,
  OrderSourcesResponse,
  OrderSyncJob,
  PolyesterType,
} from '@shared/orders';

async function req<T>(url: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  const controller = timeoutMs ? new AbortController() : undefined;
  const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller?.signal ?? init?.signal,
      headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    });
    if (res.status === 204) return undefined as T;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data as ApiError;
      const detail = err.details?.map((d) => `${d.field ? d.field + ': ' : ''}${d.message}`).join('; ');
      throw new Error(detail ? `${err.error} — ${detail}` : err.error || `请求失败 (${res.status})`);
    }
    return data as T;
  } catch (error) {
    if (controller?.signal.aborted) throw new Error('看板加载超时，请稍后重试');
    throw error;
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取图片'));
    reader.onerror = () => reject(new Error('无法读取图片'));
    reader.readAsDataURL(file);
  });
}

let indexRequestNumber = 0;
let lastIndex: { version: string; items: ProductIndexItem[]; requestNumber: number } | undefined;

async function productIndex(): Promise<ProductIndexItem[]> {
  const requestNumber = ++indexRequestNumber;
  const previous = lastIndex;
  const query = previous ? `?version=${encodeURIComponent(previous.version)}` : '';
  const result = await req<CatalogIndexResponse>(`/api/products/catalog-index${query}`);
  // A slower verification from another view must not roll the shared cache back.
  if (lastIndex && requestNumber < lastIndex.requestNumber) return lastIndex.items;
  const items = result.items ?? (previous?.version === result.version ? previous.items : undefined);
  if (!items) throw new Error('商品索引版本不匹配，请刷新列表');
  lastIndex = { version: result.version, items, requestNumber };
  return items;
}

export const api = {
  planner: () => req<PlannerData>('/api/planner'),
  createPersonalProject: (input: Partial<ProjectInput> & { name: string }) => req<PersonalProject>('/api/planner/projects', { method: 'POST', body: JSON.stringify(input) }),
  updatePersonalProject: (id: string, patch: Partial<ProjectInput>) => req<PersonalProject>(`/api/planner/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  createPersonalTask: (input: Partial<TaskInput> & { title: string }) => req<PersonalTask>('/api/planner/tasks', { method: 'POST', body: JSON.stringify(input) }),
  updatePersonalTask: (id: string, patch: Partial<TaskInput>) => req<PersonalTask>(`/api/planner/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  completePersonalTask: (task: PersonalTask) => req<PersonalTask>(`/api/planner/tasks/${task.id}/complete`, { method: 'POST', body: JSON.stringify({ expectedDueDate: task.dueDate }) }),
  productIndex,
  productCards: (ids: string[]) => req<ProductListCard[]>('/api/products/catalog-cards', { method: 'POST', body: JSON.stringify({ ids }) }),
  sortCandidates: (ids: string[]) => req<ProductSortCandidate[]>('/api/products/sort-candidates', { method: 'POST', body: JSON.stringify({ ids }) }),
  collectBatchProducts: (id: string) => req<{ id: string; productIds: string[] }>(`/api/collect/batches/${encodeURIComponent(id)}/products`),
  listProducts: () => req<ProductRecord[]>('/api/products'),
  getProduct: (id: string) => req<{ record: ProductRecord; editable: EditableProduct }>(`/api/products/${id}`),
  saveProduct: (id: string, edited: EditableProduct, templateConfirmed = false) =>
    req<ProductRecord>(`/api/products/${id}`, { method: 'PUT', body: JSON.stringify({ ...edited, ...(templateConfirmed ? { templateConfirmed: true } : {}) }) }),
  deleteProduct: (id: string) => req<void>(`/api/products/${id}`, { method: 'DELETE' }),
  discardProduct: (id: string) =>
    req<ProductRecord>(`/api/products/${id}/discard`, { method: 'POST', body: JSON.stringify({}) }),
  restoreProduct: (id: string) => req<ProductRecord>(`/api/products/${id}/restore`, { method: 'POST', body: JSON.stringify({}) }),
  applyPreset: (id: string) =>
    req<{ editable: EditableProduct }>(`/api/products/${id}/apply-preset`, { method: 'POST', body: JSON.stringify({}) }),
  validateProduct: (id: string) =>
    req<ValidateResponse>(`/api/products/${id}/validate`, { method: 'POST', body: JSON.stringify({}) }),
  publishProduct: (id: string, shopId: string) =>
    req<ProductRecord>(`/api/products/${id}/publish`, { method: 'POST', body: JSON.stringify({ shopId }) }),
  batchValidate: (ids: string[]) =>
    req<BatchValidateItem[]>('/api/products/batch/validate', { method: 'POST', body: JSON.stringify({ ids }) }),
  batchPublish: (ids: string[], shopId: string) =>
    req<BatchPublishItem[]>('/api/products/batch/publish', { method: 'POST', body: JSON.stringify({ ids, shopId }) }),
  enqueuePublish: (ids: string[], shopId: string) =>
    req<PublishJob>('/api/products/publish-jobs', { method: 'POST', body: JSON.stringify({ ids, shopId }) }),
  listPublishJobs: () => req<PublishJob[]>('/api/products/publish-jobs'),
  getPublishJob: (id: string) => req<PublishJob>(`/api/products/publish-jobs/${id}`),
  pausePublishJob: (id: string) =>
    req<PublishJob>(`/api/products/publish-jobs/${id}/pause`, { method: 'POST', body: JSON.stringify({}) }),
  reconcilePublish: (job: string, id: string, shopId: string, action: PublishReviewAction) =>
    req<{ message: string; job: PublishJob }>(`/api/products/publish-jobs/${job}/items/${id}/reconcile`, { method: 'POST', body: JSON.stringify({ shopId, action }) }),
  batchRemoveRemote: (payload: {
    shopId: string;
    ids: string[];
    remoteIds?: string[];
    reason?: JoomRemoveReason;
    deleteLocal?: boolean;
  }) =>
    req<BatchRemoveRemoteItem[]>('/api/products/batch/remove-remote', { method: 'POST', body: JSON.stringify(payload) }),
  batchOperate: (ids: string[], operation: BatchOperation, syncRemote = false, shopId?: string) =>
    req<BatchOperationItem[]>('/api/products/batch/operate', { method: 'POST', body: JSON.stringify({ ids, operation, syncRemote, shopId }) }),
  batchSync: (ids: string[]) =>
    req<JoomSyncItem[]>('/api/products/batch/sync', { method: 'POST', body: JSON.stringify({ ids }) }),
  syncShop: () => req<JoomShopSyncResult>('/api/products/sync-shop', { method: 'POST', body: JSON.stringify({}) }),
  joomShopStatusSummary: () => req<JoomShopStatusSummary>('/api/products/joom-status'),
  batchAiTitles: (payload: { ids: string[]; material: AiTitleMaterial; extraPrompt?: string; includeTags?: boolean }) =>
    req<AiTitlePreviewItem[]>('/api/products/batch/ai-titles', { method: 'POST', body: JSON.stringify(payload) }),
  getAiConfig: () => req<AiConfigPublic>('/api/ai/config'),
  saveAiConfig: (payload: {
    apiKey?: string;
    model?: string;
    preview?: boolean;
    material?: AiTitleMaterial;
    prompts?: Partial<Record<AiTitleMaterial, string>>;
  }) => req<AiConfigPublic>('/api/ai/config', { method: 'PUT', body: JSON.stringify(payload) }),
  syncProduct: (id: string) => req<ProductRecord>(`/api/products/${id}/sync`, { method: 'POST', body: JSON.stringify({}) }),
  imageCheck: (id: string) => req<ImageCheckResult[]>(`/api/products/${id}/image-check`, { method: 'POST', body: JSON.stringify({}) }),
  uploadImage: async (file: File) =>
    req<{ url: string; provider: string; authenticated: boolean }>('/api/images/upload', {
      method: 'POST',
      body: JSON.stringify({ dataUrl: await readFileAsDataUrl(file), filename: file.name }),
    }),
  retryProductVideo: (id: string) => req<ProductRecord>(`/api/products/${id}/video/retry`, { method: 'POST', body: JSON.stringify({}) }),
  auditLogs: (id: string) => req<AuditLogEntry[]>(`/api/products/${id}/audit-logs`),
  rollback: (id: string, logId: string) => req<ProductRecord>(`/api/products/${id}/rollback/${logId}`, { method: 'POST', body: JSON.stringify({}) }),
  dashboard: () => req<DashboardStats>('/api/dashboard', undefined, 10_000),
  activity: () => req<AuditLogEntry[]>('/api/audit-logs'),
  joomStatus: () => req<JoomStatus>('/api/joom/status'),
  joomDisconnect: () => req<void>('/api/joom/disconnect', { method: 'POST' }),
  joomCategories: () => req<JoomCategory[]>('/api/joom/categories'),
  joomColors: () => req<unknown>('/api/joom/colors'),
  joomCategoryRequirements: (id: string) =>
    req<CategoryRequirements>(`/api/joom/categories/requirements?id=${encodeURIComponent(id)}&locale=zh-CN`),
  getSettings: () => req<PresetsConfig>('/api/settings'),
  getGroupTemplateBindings: () => req<GroupTemplateBinding[]>('/api/settings/group-templates'),
  aliexpressAutoFillConfig: () => req<AliExpressAutoFillConfig>('/api/aliexpress/auto-fill'),
  saveAliExpressAutoFillConfig: (config: AliExpressAutoFillConfig) => req<AliExpressAutoFillConfig>('/api/aliexpress/auto-fill', {
    method: 'PUT', body: JSON.stringify({ fields: config.fields.map(({ id, value, enabled }) => ({ id, value, enabled })) }),
  }),
  saveGroupTemplateBinding: (binding: Omit<GroupTemplateBinding, 'templateId'> & { templateId: string | null }) =>
    req<GroupTemplateBinding[]>('/api/settings/group-templates', { method: 'PUT', body: JSON.stringify(binding) }),
  saveSettings: (c: PresetsConfig, base?: PresetsConfig) =>
    req<PresetsConfig>('/api/settings', { method: 'PUT', body: JSON.stringify({ ...c, base }) }),
  getPicuiConfig: () => req<PicuiConfigPublic>('/api/settings/picui'),
  savePicuiConfig: (token: string) =>
    req<PicuiConfigPublic>('/api/settings/picui', { method: 'PUT', body: JSON.stringify({ token }) }),
  getShops: () => req<ShopsConfigPublic>('/api/shops'),
  saveShops: (c: {
    profiles: Array<{
      id: string;
      name: string;
      clientId?: string;
      clientSecret?: string;
      storeId?: string;
      inheritSecretFrom?: string;
    }>;
    activeId: string;
  }) => req<ShopsConfigPublic>('/api/shops', { method: 'PUT', body: JSON.stringify(c) }),
  setActiveShop: (id: string) =>
    req<ShopsConfigPublic>('/api/shops/active', { method: 'POST', body: JSON.stringify({ id }) }),
  setProductTemplate: (id: string, templateId: string) =>
    req<{ record: ProductRecord; editable: EditableProduct }>(`/api/products/${id}/template`, {
      method: 'POST',
      body: JSON.stringify({ templateId }),
    }),
  /** 分拣：确认当前模板，或换成另一个模板并确认。 */
  decideTemplate: (id: string, templateId: string) =>
    req<TemplateDecisionResult>(`/api/products/${id}/template-decision`, { method: 'POST', body: JSON.stringify({ templateId }) }),
  /** 撤销最近一次分拣。 */
  undoTemplateDecision: (id: string) =>
    req<{ record: ProductRecord }>(`/api/products/${id}/template-decision/undo`, { method: 'POST', body: JSON.stringify({}) }),
  /** 分拣时删除一张图片（只改可编辑草稿）。 */
  deleteProductImage: (id: string, imageUrl: string) =>
    req<ProductRecord>(`/api/products/${id}/images`, { method: 'DELETE', body: JSON.stringify({ imageUrl }) }),
  /** 分拣时调整图片顺序（只改可编辑草稿，第一张为主图）。imageUrls 必须是当前草稿的同一组图片。 */
  reorderProductImages: (id: string, imageUrls: string[]) =>
    req<ProductRecord>(`/api/products/${id}/images/order`, { method: 'PUT', body: JSON.stringify({ imageUrls }) }),
  mercadoLibreConfig: () => req<MercadoLibreConfigPublic>('/api/mercadolibre/config'),
  saveMercadoLibreConfig: (payload: { clientId?: string; clientSecret?: string; redirectUri?: string; notificationUrl?: string }) =>
    req<MercadoLibreConfigPublic>('/api/mercadolibre/config', { method: 'PUT', body: JSON.stringify(payload) }),
  refreshMercadoLibreAccount: (accountId: string) =>
    req<MercadoLibreConfigPublic['connectedAccounts'][number]>(`/api/mercadolibre/accounts/${encodeURIComponent(accountId)}/refresh`, { method: 'POST', body: JSON.stringify({}) }),
  disconnectMercadoLibreAccount: (accountId: string) =>
    req<void>(`/api/mercadolibre/accounts/${encodeURIComponent(accountId)}/disconnect`, { method: 'POST', body: JSON.stringify({}) }),
  mercadoLibreTemplates: () => req<MercadoLibreTemplate[]>('/api/mercadolibre/templates'),
  saveMercadoLibreTemplate: (id: string, template: Omit<MercadoLibreTemplate, 'id'>) =>
    req<MercadoLibreTemplate[]>(`/api/mercadolibre/templates/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ ...template, id }) }),
  deleteMercadoLibreTemplate: (id: string) =>
    req<MercadoLibreTemplate[]>(`/api/mercadolibre/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  mercadoLibreListings: (productId?: string) =>
    req<MercadoLibreListingDraft[]>(`/api/mercadolibre/listings${productId ? `?productId=${encodeURIComponent(productId)}` : ''}`),
  mercadoLibreListingIndex: () => req<MercadoLibreListingIndexItem[]>('/api/mercadolibre/listing-index'),
  createMercadoLibreListings: (productId: string, accountId: string, siteIds: string[], templateIds?: Record<string, string>) =>
    req<MercadoLibreListingDraft[]>('/api/mercadolibre/listings', { method: 'POST', body: JSON.stringify({ productId, accountId, siteIds, templateIds }) }),
  getMercadoLibreListing: (id: string) =>
    req<MercadoLibreListingDraft>(`/api/mercadolibre/listings/${encodeURIComponent(id)}`),
  saveMercadoLibreListing: (id: string, patch: Partial<MercadoLibreListingDraft> & { syncShared?: boolean }) =>
    req<MercadoLibreListingDraft>(`/api/mercadolibre/listings/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteMercadoLibreListingImage: (id: string, imageUrl: string) =>
    req<MercadoLibreListingDraft[]>(`/api/mercadolibre/listings/${encodeURIComponent(id)}/images`, { method: 'DELETE', body: JSON.stringify({ imageUrl }) }),
  validateMercadoLibreListing: (id: string) =>
    req<MercadoLibreValidationResponse>(`/api/mercadolibre/listings/${encodeURIComponent(id)}/validate`, { method: 'POST', body: JSON.stringify({}) }),
  publishMercadoLibreListing: (id: string) =>
    req<MercadoLibreListingDraft>(`/api/mercadolibre/listings/${encodeURIComponent(id)}/publish`, { method: 'POST', body: JSON.stringify({}) }),
  setMercadoLibreListingStatus: (id: string, status: 'active' | 'paused') =>
    req<MercadoLibreListingDraft>(`/api/mercadolibre/listings/${encodeURIComponent(id)}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
  syncMercadoLibreListing: (id: string) =>
    req<MercadoLibreListingDraft>(`/api/mercadolibre/listings/${encodeURIComponent(id)}/sync`, { method: 'POST', body: JSON.stringify({}) }),
  mercadoLibreCategoryAttributes: (accountId: string, categoryId: string) =>
    req<unknown>(`/api/mercadolibre/categories/attributes?accountId=${encodeURIComponent(accountId)}&categoryId=${encodeURIComponent(categoryId)}`),
  mercadoLibreCategories: (accountId: string, siteId: string) =>
    req<unknown>(`/api/mercadolibre/categories?accountId=${encodeURIComponent(accountId)}&siteId=${encodeURIComponent(siteId)}`),
  mercadoLibreCategoryPredict: (accountId: string, siteId: string, title: string) =>
    req<unknown>(`/api/mercadolibre/categories/predict?accountId=${encodeURIComponent(accountId)}&siteId=${encodeURIComponent(siteId)}&title=${encodeURIComponent(title)}`),

  // ---- 订单导出 ----
  orderSources: () => req<OrderSourcesResponse>('/api/orders/sources'),
  syncOrders: (shops: OrderShopRef[], from?: string) =>
    req<OrderSyncJob>('/api/orders/sync', { method: 'POST', body: JSON.stringify({ shops, ...(from ? { from } : {}) }) }),
  orderSyncJob: (id: string) => req<OrderSyncJob>(`/api/orders/sync/${encodeURIComponent(id)}`),
  previewOrders: (input: OrderQueryInput) =>
    req<OrderPreview>('/api/orders/preview', { method: 'POST', body: JSON.stringify(input) }),
  exportOrders: (input: OrderQueryInput) =>
    req<OrderExportRecord>('/api/orders/exports', { method: 'POST', body: JSON.stringify(input) }),
  orderExports: () => req<OrderExportRecord[]>('/api/orders/exports'),
  orderExportFileUrl: (exportId: string, fileId: string) =>
    `/api/orders/exports/${encodeURIComponent(exportId)}/files/${encodeURIComponent(fileId)}`,
  orderExportZipUrl: (exportId: string) => `/api/orders/exports/${encodeURIComponent(exportId)}/zip`,
  orderProfiles: () => req<OrderExportProfile[]>('/api/orders/profiles'),
  saveOrderProfile: (profile: OrderExportProfile) =>
    req<OrderExportProfile[]>(`/api/orders/profiles/${encodeURIComponent(profile.id)}`, { method: 'PUT', body: JSON.stringify(profile) }),
  deleteOrderProfile: (id: string) =>
    req<OrderExportProfile[]>(`/api/orders/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  orderMaterialRules: () => req<OrderMaterialRule[]>('/api/orders/material-rules'),
  saveOrderMaterialRule: (input: { platform: string; productId?: string; productSku?: string; title?: string; material: ExportMaterial; polyesterType?: PolyesterType | null }) =>
    req<OrderMaterialRule>('/api/orders/material-rules', { method: 'POST', body: JSON.stringify(input) }),
  updateOrderMaterialRule: (id: string, material: ExportMaterial, polyesterType?: PolyesterType | null) =>
    req<OrderMaterialRule>(`/api/orders/material-rules/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ material, polyesterType }) }),
  deleteOrderMaterialRule: (id: string) =>
    req<void>(`/api/orders/material-rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
