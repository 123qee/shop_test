import { z } from 'zod';

export const productVideoSchema = z.object({
  url: z.string().url(),
  poster: z.string().url().optional(),
  localAssetId: z.string().regex(/^[a-zA-Z0-9._-]+$/).optional(),
  mimeType: z.string().max(200).optional(),
  size: z.number().int().nonnegative().optional(),
});

/** 采集上报的校验 schema(与 shared 的 CollectedProduct 对应)。 */
export const variantSchema = z.object({
  sourceSkuId: z.string().optional(),
  options: z.record(z.string()).default({}),
  price: z.number().optional(),
  image: z.string().optional(),
  stock: z.number().optional(),
});

export const collectedProductSchema = z.object({
  source: z.enum(['aliexpress', 'allegro', 'amazon', 'asos', 'george', 'joom', 'mercadolibre', 'ozon', 'wildberries']),
  sourceUrl: z.string(),
  sourceProductId: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  images: z.array(z.string()).default([]),
  videos: z.array(productVideoSchema).max(10).optional(),
  price: z
    .object({ value: z.number(), currency: z.string(), original: z.number().optional() })
    .optional(),
  variants: z.array(variantSchema).default([]),
  attributes: z.record(z.string()).default({}),
  store: z.object({ name: z.string().optional(), url: z.string().optional() }).optional(),
  raw: z.unknown().optional(),
});

export const collectRequestSchema = z.object({
  product: collectedProductSchema,
  /** 插件在采集栏中选择的模板;不传时由系统按商品特征推荐。 */
  templateId: z.string().min(1).optional(),
  /** picked=用户主动选择;旧版插件不传,模板照旧使用但不自动确认。 */
  templateSource: z.enum(['picked']).optional(),
});

/** 编辑保存的校验 schema(EditableProduct,对齐 Joom create schema)。 */
export const editableVariantSchema = z.object({
  sku: z.string().min(1).max(50),
  price: z.number().nonnegative(),
  salePrice: z.number().nonnegative().optional(),
  inventory: z.number().int().nonnegative().default(0),
  colors: z.string().optional(),
  size: z.string().max(25).optional(),
  attributes: z.record(z.string()).optional(),
  image: z.string().optional(),
  // 物流 / 标识(可选)
  msrPrice: z.number().nonnegative().optional(),
  declaredValue: z.number().nonnegative().optional(),
  shippingPrice: z.number().nonnegative().optional(),
  shippingWeight: z.number().nonnegative().optional(),
  shippingLength: z.number().nonnegative().optional(),
  shippingWidth: z.number().nonnegative().optional(),
  shippingHeight: z.number().nonnegative().optional(),
  gtin: z.string().regex(/^\d{8,14}$/,'GTIN 应为 8~14 位数字').optional(),
  hsCode: z.string().optional(),
  committedFulfillmentDays: z.number().int().min(1).max(7).optional(),
});

/** 敏感货声明 */
export const dangerInfoSchema = z.object({
  isDangerous: z.boolean(),
  dangerKinds: z.array(z.string()).optional(),
});

/** 采集默认预设(单个模板的字段) */
export const collectDefaultsSchema = z.object({
  currency: z.string().min(1).transform((s) => s.toUpperCase()),
  priceMode: z.enum(['multiply', 'fixed']),
  priceMultiplier: z.number().positive(),
  fixedPrice: z.number().nonnegative(),
  inventory: z.number().int().nonnegative(),
  msrPrice: z.number().nonnegative().optional(),
  shippingPrice: z.number().nonnegative().optional(),
  shippingWeight: z.number().nonnegative().optional(),
  shippingLength: z.number().nonnegative().optional(),
  shippingWidth: z.number().nonnegative().optional(),
  shippingHeight: z.number().nonnegative().optional(),
  committedFulfillmentDays: z.number().int().min(1).max(7).optional(),
  storeId: z.string().optional(),
  categoryId: z.string().optional(),
  sizeMap: z.record(z.string()).optional(),
  colorMap: z.record(z.string()).optional(),
  targetSizes: z.array(z.string().trim().min(1).max(25)).max(50).optional(),
  description: z.string().optional(),
  dangerInfo: dangerInfoSchema.optional(),
  attributes: z.record(z.string()).optional(),
});

/** 预设配置:多模板 + 默认模板 id */
export const presetsConfigSchema = z.object({
  templates: z
    .array(z.object({ id: z.string().min(1), name: z.string().min(1), defaults: collectDefaultsSchema }))
    .min(1),
  activeId: z.string().min(1),
  sizeTemplates: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    sizes: z.array(z.string().trim().min(1).max(25)).max(50),
  })).optional(),
  categoryFavorites: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    categoryId: z.string().min(1),
  })).optional(),
  categoryAttributeTemplates: z.array(z.object({
    id: z.string().min(1), name: z.string().min(1), categoryId: z.string().optional(), attributes: z.record(z.string()),
  })).optional(),
});

export const picuiConfigSchema = z.object({
  token: z.string().trim().min(1).max(500),
});

export const shopProfileSaveSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  storeId: z.string().optional(),
  inheritSecretFrom: z.string().optional(),
});

export const shopsConfigSchema = z.object({
  profiles: z.array(shopProfileSaveSchema).min(1),
  activeId: z.string().min(1),
});

export const shopActiveSchema = z.object({
  id: z.string().min(1),
});

export const aiConfigSchema = z.object({
  apiKey: z.string().optional(),
  model: z.string().min(1).optional(),
  preview: z.boolean().optional(),
  material: z.enum(['cotton', 'polyester']).optional(),
  prompts: z
    .object({
      cotton: z.string().max(4000).optional(),
      polyester: z.string().max(4000).optional(),
    })
    .optional(),
});

export const aiTitlePreviewSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(80),
  material: z.enum(['cotton', 'polyester']).default('polyester'),
  extraPrompt: z.string().max(800).optional(),
  includeTags: z.boolean().optional(),
});

export const batchRemoveRemoteSchema = z.object({
  shopId: z.string().optional(),
  ids: z.array(z.string().min(1)).max(200).default([]),
  remoteIds: z.array(z.string().min(1)).max(200).optional(),
  reason: z.enum(['stopSelling', 'legalRequirement']).default('stopSelling'),
  deleteLocal: z.boolean().optional(),
  marketplaceId: z.string().optional(),
}).refine((v) => v.ids.length + (v.remoteIds?.length ?? 0) > 0, { message: '缺少 ids 或 remoteIds' });

export const editableProductSchema = z.object({
  title: z.string().min(1),
  sku: z.string().min(1),
  description: z.string().default(''),
  images: z.array(z.string()).default([]),
  video: productVideoSchema.optional(),
  currency: z.string().default('USD'),
  brand: z.string().optional(),
  tags: z.array(z.string()).optional(),
  storeId: z.string().optional(),
  categoryId: z.string().optional(),
  attributes: z.record(z.string()).optional(),
  dangerInfo: dangerInfoSchema.optional(),
  variants: z.array(editableVariantSchema).default([]),
});
