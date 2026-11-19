/**
 * 三个子项目(extension / server / web)共用的类型定义。
 * 通过各自 tsconfig / vite 的 `@shared/*` 别名引用。
 */

/** 采集来源平台 */
export type SourcePlatform = 'aliexpress' | 'allegro' | 'amazon' | 'asos' | 'george' | 'joom' | 'mercadolibre' | 'ozon' | 'wildberries';

/** 商品变体(SKU 组合) */
export interface Variant {
  /** 来源平台的 SKU id(若能拿到) */
  sourceSkuId?: string;
  /** 变体规格,如 { 颜色: '黑色', 尺码: 'XL' } */
  options: Record<string, string>;
  /** 变体价格(采集币种) */
  price?: number;
  /** 变体图片 */
  image?: string;
  /** 库存 */
  stock?: number;
}

/** 价格信息 */
export interface Price {
  value: number;
  currency: string;
  /** 划线原价(若有) */
  original?: number;
}

/** 来源商品视频。采集端保存原始直链，服务端可额外缓存为本地素材。 */
export interface ProductVideo {
  /** 来源站可直接下载的视频 URL。 */
  url: string;
  /** 视频封面，可用于后台预览。 */
  poster?: string;
  /** 服务端缓存素材 id；存在时发布优先使用本地副本，避免来源 URL 过期。 */
  localAssetId?: string;
  /** 来源返回或缓存时探测到的 MIME 类型。 */
  mimeType?: string;
  /** 已缓存文件大小（字节）。 */
  size?: number;
}

/**
 * 采集并归一化后的商品结构。插件产出、服务端入库、后台编辑都以它为基础。
 */
export interface CollectedProduct {
  source: SourcePlatform;
  /** 商品在来源平台的页面 URL */
  sourceUrl: string;
  /** 来源平台商品 id(如 AliExpress /item/<id>.html) */
  sourceProductId: string;
  /** 入库时生成的商品 SKU；旧记录可能没有 */
  generatedSku?: string;
  title: string;
  description?: string;
  /** 图片 URL 列表,第 0 张默认为主图 */
  images: string[];
  /** 商品视频候选；Joom 当前每件商品最多关联一个，默认使用第 0 个。 */
  videos?: ProductVideo[];
  price?: Price;
  variants: Variant[];
  /** 商品属性/规格 */
  attributes: Record<string, string>;
  /** 店铺信息 */
  store?: { name?: string; url?: string };
  /** 原始解析数据,便于调试和后续补字段 */
  raw?: unknown;
}

/** 商品在本系统内的处理状态 */
export type ProductStatus =
  | 'collected' // 已采集入库
  | 'edited' // 已在后台编辑
  | 'publishing' // 发布中
  | 'published' // 已发布到 Joom
  | 'failed' // 发布失败
  | 'discarded'; // 已移入废弃箱，不参与未发布列表

export type ProductGroupId =
  | 'men-short' | 'women-short' | 'kids-short' | 'short'
  | 'men-sweat' | 'women-sweat' | 'kids-sweat' | 'sweat'
  | 'men-top' | 'women-top' | 'kids-top' | 'top'
  | 'pants' | 'dress' | 'shoes' | 'home' | 'other' | 'pending';
export type ProductMaterial = 'polyester' | 'cotton' | 'blend' | 'other' | 'unknown';
export interface ProductGrouping {
  groupId: ProductGroupId;
  material: ProductMaterial;
  source: 'auto' | 'manual';
  reason: string;
}

/** Joom 在单个店铺中的商品状态快照。一个本地商品可关联多个店铺刊登。 */
export interface JoomShopListingSnapshot {
  shopId: string;
  shopName: string;
  joomProductId: string;
  productId?: string;
  sku?: string;
  name?: string;
  state?: JoomProductState;
  updateTimestamp?: string;
  inventory: number;
  hasActiveVersion: boolean;
  issues?: string;
  issueDetails?: JoomIssueDetail[];
  /** false 表示此前在该店铺确认过，最近一次整店同步时已找不到。 */
  present: boolean;
  lastSyncedAt: string;
}

export interface JoomShopStatusCounts {
  active: number;
  oos: number;
  error: number;
  optimize: number;
  pending: number;
  offline: number;
  unknown: number;
}

export interface JoomShopStatusSummary {
  /** 按店铺刊登条目计数，同一商品在多个店铺刊登会分别计数。 */
  total: number;
  unmatchedRemote: number;
  byListing: JoomShopStatusCounts;
  lastSyncedAt?: string;
  shops: Array<{
    shopId: string;
    shopName: string;
    connected: boolean;
    total: number;
    unmatchedRemote: number;
    byListing: JoomShopStatusCounts;
    lastSyncedAt?: string;
    lastError?: string;
  }>;
}
export interface GroupTemplateBinding {
  groupId: ProductGroupId;
  /** all 表示用户主动选择的整组常用预设，unknown 不允许推荐。 */
  material: ProductMaterial | 'all';
  templateId: string;
}

/**
 * 库内商品记录:采集数据 + 编辑后数据 + 发布状态。
 * `edited` 为空时后台展示 `collected` 的原始值。
 */
export interface ProductRecord {
  id: string;
  /** 来源信息推导的分组；人工纠正后保留人工结果。 */
  grouping?: ProductGrouping;
  /**
   * 预设已确认：用户套用/分拣过，或采集栏主动选了模板且核对无矛盾。
   * 采集栏没选（系统推荐）或旧版插件带来的默认模板都不算确认。
   */
  templateConfirmed?: boolean;
  status: ProductStatus;
  /** 采集时的原始归一化数据(只读,保留溯源) */
  collected: CollectedProduct;
  /** 用户在后台编辑后的数据;未编辑则为 null */
  edited: EditableProduct | null;
  /** 发布成功后 Joom 返回的商品 id */
  joomProductId?: string;
  /** 最近一次发布错误信息 */
  lastError?: string;
  /** Joom 最近同步到的状态与时间 */
  joomState?: JoomProductState;
  /** 按店铺保存的 Joom 状态；旧字段保留用于兼容单店铺页面。 */
  joomListings?: JoomShopListingSnapshot[];
  joomUpdatedAt?: string;
  lastSyncedAt?: string;
  /** 店铺侧可售库存合计（同步时快照，不覆盖本地草稿库存） */
  joomInventory?: number;
  /** 是否仍有对客可见的已审核版本 */
  joomHasActiveVersion?: boolean;
  /** Joom 返回的审核/质量问题说明 */
  joomIssues?: string;
  /** Joom 返回的审核问题明细（来自 review.reasons / review.infractions） */
  joomIssueDetails?: JoomIssueDetail[];
  /** 商品视频上传、审核与关联状态（独立于商品发布状态）。 */
  joomVideo?: JoomVideoState;
  /** 最近一次质量评分，列表和看板直接使用 */
  qualityScore?: ProductQualityScore;
  /** 标题/颜色等仍含非英文字符，发布到 Joom 可能被拒 */
  languageRisk?: boolean;
  /** 套用的预设模板 id(采集时=默认模板;编辑页可切换) */
  templateId?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * 最近一次保存商品内容(标题/价格/图片等)的时间。
   * 未发布列表按它置顶，方便编完立刻批量发布；店铺同步不会改这个字段。
   */
  editedAt?: string;
}

export interface JoomIssueDetail {
  code?: string;
  title?: string;
  message: string;
  kind?: string;
  field?: string;
  variantSku?: string;
  regions?: string[];
  permanent?: boolean;
}

export type JoomProductState =
  | 'active'
  | 'archived'
  | 'disabledByJoom'
  | 'disabledByMerchant'
  | 'locked'
  | 'pending'
  | 'rejected'
  | 'warning'
  | string;

export interface ProductQualityScore {
  score: number;
  grade: 'excellent' | 'good' | 'attention' | 'risk';
  breakdown: Array<{ key: string; label: string; score: number; max: number; hint?: string }>;
}

/**
 * 后台可编辑的商品字段。发布时以此为准(为空则回退到 collected)。
 * 字段对齐 Joom API v3 `POST /products/create`(内部命名保持平台中立,
 * 由 marketplace adapter 的 mapper 翻译为各平台字段)。
 */
export interface EditableProduct {
  /** 商品名称 -> Joom `name`(必填) */
  title: string;
  /** 商品级 SKU(商家生成、全店唯一) -> Joom `sku`(必填) */
  sku: string;
  /** 纯文本描述(不接受 HTML) -> Joom `description` */
  description: string;
  /** 图片:images[0] -> mainImage(必填),其余 -> extraImages(最多 20) */
  images: string[];
  /** 待发布到 Joom 的主视频；视频通过独立上传/审核/关联接口处理。 */
  video?: ProductVideo;
  /** 币种(ISO 3 位大写),应用到所有变体 -> variant.currency */
  currency: string;
  /** 品牌 -> Joom `brand`(可选) */
  brand?: string;
  /** 搜索关键词,用户不可见 -> Joom `tags`(可选) */
  tags?: string[];
  /** Joom 店铺 id(商户身份授权必填,店铺身份省略) */
  storeId?: string;
  /** Joom 类目 id(可选) */
  categoryId?: string;
  /** 商品级属性(类目要求),key 用 attributeId -> Joom 顶层 `attributes[{key,value}]` */
  attributes?: Record<string, string>;
  /** 敏感货/危险品声明 -> Joom `dangerInfo`(创建必需;普通货为 {isDangerous:false}) */
  dangerInfo?: DangerInfo;
  variants: EditableVariant[];
}

export type JoomVideoStatus =
  | 'queued'
  | 'downloading'
  | 'uploading'
  | 'processing'
  | 'ready'
  | 'approved'
  | 'linked'
  | 'rejected'
  | 'failed';

export interface JoomVideoState {
  status: JoomVideoStatus;
  sourceUrl: string;
  shopId?: string;
  uploadId?: string;
  videoId?: string;
  error?: string;
  updatedAt: string;
}

/** Joom 敏感货声明。isDangerous=true 时 dangerKinds 不能为空。 */
export interface DangerInfo {
  isDangerous: boolean;
  /** 危险品类型;取值见 Joom 文档(battery/liquid/flammable/…) */
  dangerKinds?: string[];
}

export interface EditableVariant {
  /** 变体 SKU(商家生成,≤50) -> variant.sku(必填) */
  sku: string;
  /** 价格(不含 VAT;发布时转字符串) -> variant.price(必填) */
  price: number;
  /** 促销价(不含 VAT,可选) -> variant.salePrice */
  salePrice?: number;
  /** 库存(≥0) -> variant.inventory */
  inventory: number;
  /** 颜色(需为 Joom 允许的颜色名,可用 & , and 分隔) -> variant.colors */
  colors?: string;
  /** 尺码(≤25) -> variant.size */
  size?: string;
  /** 其他规格 -> variant.attributes[{key,value}] */
  attributes?: Record<string, string>;
  /** 变体主图 -> variant.mainImage */
  image?: string;

  // ---- 物流 / 标识(均可选,发布时按需转换)----
  /** 建议零售价(不含 VAT) -> variant.msrPrice(字符串) */
  msrPrice?: number;
  /** 申报价值 -> variant.declaredValue(字符串) */
  declaredValue?: number;
  /** 运费(不含 VAT) -> variant.shippingPrice(字符串) */
  shippingPrice?: number;
  /** 毛重 kg -> variant.shippingWeight(数字) */
  shippingWeight?: number;
  /** 发货长 cm -> variant.shippingLength */
  shippingLength?: number;
  /** 发货宽 cm -> variant.shippingWidth */
  shippingWidth?: number;
  /** 发货高 cm -> variant.shippingHeight */
  shippingHeight?: number;
  /** GTIN(仅数字,8/12/13/14 位) -> variant.gtin */
  gtin?: string;
  /** HS 编码 -> variant.hsCode */
  hsCode?: string;
  /** 履约天数(中国商户 1~7) -> variant.committedFulfillmentDays(整数) */
  committedFulfillmentDays?: number;
}

// ---- 接口 DTO ----

/** 插件 -> server: 采集上报 */
export interface CollectRequest {
  product: CollectedProduct;
  /** 采集栏选择的预设；不传表示「不指定」，由系统按商品特征推荐。 */
  templateId?: string;
  /** 'picked' 表示用户在采集栏主动选了 templateId；旧版插件不传，选的模板不会自动确认。 */
  templateSource?: 'picked';
}

/** 入库时模板的处理结果，插件据此提示「已确认 / 待分拣」。 */
export interface CollectTemplateOutcome {
  templateId: string;
  templateName?: string;
  /** picked=采集栏主动选择；suggested=系统推荐；fallback=旧版插件带来的模板或默认模板 */
  source: 'picked' | 'suggested' | 'fallback';
  confirmed: boolean;
  /** 与商品的矛盾，也就是没有自动确认的原因。 */
  issues: string[];
}

export interface CollectResponse {
  id: string;
  /** 同来源同商品已经采过，本次没有新建。 */
  duplicate?: boolean;
  template?: CollectTemplateOutcome;
}

/** 分拣：确认当前模板，或换成另一个模板并确认。 */
export interface TemplateDecisionResult {
  record: ProductRecord;
  action: 'confirmed' | 'changed';
}

/** server 通用错误响应 */
export interface ApiError {
  error: string;
  /** Joom 返回的字段级错误(发布失败时透传) */
  details?: Array<{ code?: string; field?: string; message: string }>;
}

/** Joom 连接状态 */
export interface JoomStatus {
  connected: boolean;
  /** 当前环境 */
  env: 'production' | 'sandbox';
  /** token 过期时间(ISO),已连接时有 */
  expiresAt?: string;
  /** 当前店铺是否已填写 Client ID + Secret */
  configured: boolean;
  /** 当前店铺档案 */
  shopId?: string;
  shopName?: string;
  storeId?: string;
  /** 顶栏换店用的精简列表 */
  shops?: ShopStatusItem[];
}

/** 顶栏/连接状态里的单个店铺 */
export interface ShopStatusItem {
  id: string;
  name: string;
  configured: boolean;
  connected: boolean;
}

/** 设置页展示的店铺档案(不回传完整 Secret) */
export interface ShopProfilePublic {
  id: string;
  name: string;
  clientId: string;
  hasSecret: boolean;
  clientSecretHint?: string;
  storeId?: string;
  connected: boolean;
  expiresAt?: string;
}

/** 多店铺配置 */
export interface ShopsConfigPublic {
  profiles: ShopProfilePublic[];
  /** 当前店铺 id：发布、同步、授权都走它 */
  activeId: string;
}

// ---- Mercado Libre workspace ----

export type MercadoLibreSiteId = 'MLC' | 'MLM' | 'MCO';
export type MercadoLibreListingStatus = 'draft' | 'validating' | 'publishing' | 'published' | 'paused' | 'failed';
export type MercadoLibreSellerModel = 'user_products' | 'global_items' | 'fully_managed' | 'unknown';

export interface MercadoLibreConfigPublic {
  configured: boolean;
  clientId?: string;
  clientSecretHint?: string;
  redirectUri?: string;
  notificationUrl?: string;
  connectedAccounts: MercadoLibreAccountPublic[];
}

export interface MercadoLibreAccountPublic {
  id: string;
  userId: string;
  nickname?: string;
  model: MercadoLibreSellerModel;
  tags: string[];
  sites: MercadoLibreSitePublic[];
  connected: boolean;
  expiresAt?: string;
}

export interface MercadoLibreSitePublic {
  siteId: MercadoLibreSiteId;
  userId?: string;
  logisticTypes: string[];
  enabled: boolean;
}

export interface MercadoLibreAttributeValue {
  id?: string;
  name: string;
}

export interface MercadoLibreAttribute {
  id: string;
  name?: string;
  valueName?: string;
  valueId?: string;
  unitName?: string;
  unitId?: string;
  values?: MercadoLibreAttributeValue[];
}

export interface MercadoLibreVariantDraft {
  sku: string;
  price: number;
  inventory: number;
  attributes: MercadoLibreAttribute[];
  images?: string[];
  remoteUserProductId?: string;
}

export interface MercadoLibreListingDraft {
  id: string;
  productId: string;
  accountId?: string;
  siteId: MercadoLibreSiteId;
  templateId?: string;
  status: MercadoLibreListingStatus;
  title: string;
  description: string;
  currency: string;
  categoryId?: string;
  attributes: MercadoLibreAttribute[];
  images: string[];
  variants: MercadoLibreVariantDraft[];
  logisticType: string;
  listingTypeId?: string;
  priceMode: 'set' | 'multiply' | 'net_proceeds';
  priceValue?: number;
  language: 'source' | 'english' | 'spanish' | 'portuguese';
  remote?: {
    model?: MercadoLibreSellerModel;
    sitelessUserProductId?: string;
    familyId?: string;
    itemIds?: string[];
  };
  lastError?: string;
  lastSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MercadoLibreTemplate {
  id: string;
  name: string;
  /** 一个模板可同时应用到多个站点。 */
  siteIds: MercadoLibreSiteId[];
  /** 可选标题模板；为空时沿用采集标题。 */
  titleTemplate?: string;
  /** 可选商品描述模板；为空时沿用采集描述。 */
  descriptionTemplate?: string;
  categoryId?: string;
  attributes: MercadoLibreAttribute[];
  currency: string;
  logisticType: string;
  listingTypeId?: string;
  priceMode: 'set' | 'multiply' | 'net_proceeds';
  priceValue: number;
  language: 'source' | 'english' | 'spanish' | 'portuguese';
}

export interface MercadoLibreValidationResponse {
  ok: boolean;
  issues: ValidationIssue[];
}

// ---- 发布前校验 ----

export interface ValidationIssue {
  /** 定位字段,如 'mainImage' / 'variants.0.price' / 'attributes.material' */
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidateResponse {
  issues: ValidationIssue[];
  /** 是否存在 error 级问题(存在则不可发布) */
  ok: boolean;
}

// ---- 采集默认设置(预设)----

/**
 * 采集后自动套用到草稿的预设。未被用户手动编辑保存前,草稿始终反映最新预设。
 * 币种固定为商户账户币种(Joom 要求变体币种 = 账户币种)。
 */
export interface CollectDefaults {
  /** 目标币种(= Joom 账户币种),如 USD。所有变体统一用它 */
  currency: string;
  /** 价格规则:multiply=采集价×倍率(含汇率+利润);fixed=统一固定价 */
  priceMode: 'multiply' | 'fixed';
  /** multiply 模式的倍率(如 0.06 把 MXN 数值换算并加价到 USD) */
  priceMultiplier: number;
  /** fixed 模式的统一价格 */
  fixedPrice: number;
  /** 默认库存(覆盖采集值) */
  inventory: number;
  /** 默认建议零售价(不含 VAT);设了则覆盖采集变体值 */
  msrPrice?: number;
  /** 默认运费(变体无运费时填充) */
  shippingPrice?: number;
  /** 默认毛重 kg */
  shippingWeight?: number;
  /** 默认发货长 cm */
  shippingLength?: number;
  /** 默认发货宽 cm */
  shippingWidth?: number;
  /** 默认发货高 cm */
  shippingHeight?: number;
  /** 默认履约天数(1~7) */
  committedFulfillmentDays?: number;
  /** 默认类目属性(key=attributeId),套用到商品级 attributes;编辑可覆盖 */
  attributes?: Record<string, string>;
  /** 默认店铺 id；留空则用当前店铺档案里的 storeId */
  storeId?: string;
  /** 默认类目 id */
  categoryId?: string;
  /** 尺码映射:采集到的尺码 -> Joom 尺码(如 "均码"->"One Size") */
  sizeMap?: Record<string, string>;
  /** 颜色映射:采集到的颜色 -> Joom 英文色名(如 "черный"->"Black") */
  colorMap?: Record<string, string>;
  /** 目标尺码模板:按此列表删除多余尺码、为每个颜色/规格组合补齐缺失尺码 */
  targetSizes?: string[];
  /** 默认商品描述(纯文本);设了则覆盖采集描述 */
  description?: string;
  /** 默认敏感货声明(卖衣服等普通货填 {isDangerous:false}) */
  dangerInfo?: DangerInfo;
}

/** 预设模板:不同产品类型用不同预设。 */
export interface PresetTemplate {
  id: string;
  name: string;
  defaults: CollectDefaults;
}

/** 可复用的尺码模板(如「男装棉质 2XS-3XL」)。 */
export interface SizeTemplate {
  id: string;
  name: string;
  sizes: string[];
}

/** 常用类目收藏(免去每次搜索)。 */
export interface CategoryFavorite {
  id: string;
  name: string;
  categoryId: string;
}

/** 预设配置:多模板 + 当前默认模板(新采集用它)+ 复用库。 */
export interface PresetsConfig {
  templates: PresetTemplate[];
  /** 默认模板 id(新采集商品套用) */
  activeId: string;
  /** 尺码模板库(供快速选择填入 targetSizes) */
  sizeTemplates?: SizeTemplate[];
  /** 常用类目收藏(供快速选择填入 categoryId) */
  categoryFavorites?: CategoryFavorite[];
  /** 可复用的类目属性填充模板 */
  categoryAttributeTemplates?: CategoryAttributeTemplate[];
}

/** PICUI 配置只返回状态和脱敏提示，不把完整 token 回传到浏览器。 */
export interface PicuiConfigPublic {
  configured: boolean;
  tokenHint?: string;
}

export interface CategoryAttributeTemplate {
  id: string;
  name: string;
  categoryId?: string;
  attributes: Record<string, string>;
}

// ---- 批量操作 ----

export interface BatchValidateItem {
  id: string;
  issues: ValidationIssue[];
  ok: boolean;
}

export interface BatchPublishItem {
  id: string;
  ok: boolean;
  /** 成功时的 Joom 商品 id */
  joomProductId?: string;
  /** 失败时的错误信息 */
  error?: string;
  /** 因校验未通过而失败时的问题清单 */
  issues?: ValidationIssue[];
}

export type PublishJobItemStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'needs_review';
export type PublishReviewAction = 'check' | 'release' | 'confirm-update';

export interface PublishJobItem {
  productId: string;
  status: PublishJobItemStatus;
  error?: string;
  joomProductId?: string;
}

export interface PublishJob {
  id: string;
  shopId: string;
  createdAt: string;
  items: PublishJobItem[];
  /** 当前任务前面仍在发布或等待的商品数。 */
  aheadCount: number;
}

/** Joom `POST /products/remove` 的删除原因。 */
export type JoomRemoveReason = 'stopSelling' | 'legalRequirement';

/** 从 Joom 批量删除线上商品的单条结果。 */
export interface BatchRemoveRemoteItem {
  id: string;
  ok: boolean;
  joomProductId?: string;
  /** 线上已不存在（404 / archived），视为删除成功 */
  alreadyGone?: boolean;
  /** 成功后是否同时删掉了本地采集箱记录 */
  deletedLocal?: boolean;
  /** 成功后是否把本地记录移入了废弃箱 */
  discarded?: boolean;
  error?: string;
}

export type BatchOperation =
  | { type: 'price'; mode: 'multiply' | 'set'; value: number }
  | { type: 'inventory'; value: number }
  | { type: 'dangerInfo'; value: DangerInfo }
  | { type: 'template'; templateId: string }
  | { type: 'grouping'; groupId: ProductGroupId; material?: ProductMaterial }
  | { type: 'title'; items: AiTitleApplyItem[] }
  | { type: 'normalizeColors'; officialColors?: string[] };

/** AI 改标题时写入的单条结果。tags 缺省则保留原标签。 */
export interface AiTitleApplyItem {
  id: string;
  title: string;
  tags?: string[];
}

export type AiTitleMaterial = 'cotton' | 'polyester';

export interface AiTitleMaterialPreset {
  id: AiTitleMaterial;
  name: string;
  hint: string;
  prompt: string;
  factoryPrompt: string;
}

export interface AiTitlePreviewItem {
  id: string;
  ok: boolean;
  original: string;
  title?: string;
  tags?: string[];
  image?: string;
  warning?: string;
  error?: string;
}

export interface AiConfigPublic {
  configured: boolean;
  provider: 'deepseek';
  model: string;
  apiKeyHint?: string;
  /** 生成后是否先预览再写入，默认 true */
  preview: boolean;
  /** 上次使用的面料提示词 */
  material: AiTitleMaterial;
  materials: AiTitleMaterialPreset[];
}

export interface BatchOperationItem {
  id: string;
  ok: boolean;
  error?: string;
  /** 规范化颜色时成功改写的变体数 */
  mappedCount?: number;
  /** 规范化颜色时自动补齐默认颜色的变体数 */
  defaultedCount?: number;
  /** 规范化后仍无法识别、需补 colorMap 的原文 */
  unresolved?: string[];
}

export interface JoomSyncItem {
  id: string;
  ok: boolean;
  shopId?: string;
  shopName?: string;
  state?: JoomProductState;
  error?: string;
}

/** 整店状态同步结果：只更新店铺状态快照，不改本地草稿。 */
export interface JoomShopSyncResult {
  ok: number;
  failed: number;
  unmatchedLocal: number;
  unmatchedRemote: number;
  lastSyncedAt: string;
  usedFallback: boolean;
  failedItems: JoomSyncItem[];
  overview: JoomShopStatusSummary;
}

export interface ImageCheckResult {
  url: string;
  ok: boolean;
  contentType?: string;
  width?: number;
  height?: number;
  duplicate?: boolean;
  issue?: string;
}

export interface AuditLogEntry {
  id: string;
  productId?: string;
  action: string;
  summary: string;
  before?: unknown;
  after?: unknown;
  createdAt: string;
}

export interface DashboardStats {
  total: number;
  byStatus: Record<string, number>;
  byJoomState: Record<string, number>;
  /** 与卖家后台对齐的运营分桶：活性 / 缺货 / 出错 / 待优化 */
  byListing: Record<string, number>;
  joomStatus: JoomShopStatusSummary;
  unsyncedPublished: number;
  lastShopSyncedAt?: string;
  recentActivity: AuditLogEntry[];
}

// ---- 类目 / 类目属性联动 ----

/** GET /productCategories 规范化后的类目项 */
export interface JoomCategory {
  id: string;
  name: string;
  path: string;
  parentId?: string;
  takeRate?: number;
}

/** requirements.attributesRequirements.attributeRequirements[] 单项 */
export interface CategoryAttributeRequirement {
  attributeId: string;
  attributeName: string;
  /** required | recommended | optional 等 */
  severity: string;
  supportedKeys?: string[];
  goodDescriptionSamples?: string[];
  badDescriptionSamples?: string[];
  /** 由 attributeValues 关联后附加的可选值(可能为空) */
  allowedValues?: string[];
}

/** 规范化后的类目要求 */
export interface CategoryRequirements {
  categoryId: string;
  attributes: CategoryAttributeRequirement[];
  /** 一般限制说明 */
  generalLimitations?: Array<{ description: string; severity: string }>;
}
