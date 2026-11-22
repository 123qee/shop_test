import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import type { ProductMaterial } from '@shared/types';
import { materialLabel } from '@shared/product-grouping';
import { addDays } from '@shared/planner';
import {
  chinaDate,
  chinaDayStartIso,
  compareOrderLines,
  formatChinaDateTime,
  isDateString,
  isOrderStatus,
  ORDER_COLUMNS,
  ORDER_STATUS_LABELS,
  orderExportColumns,
  POLYESTER_TYPE_LABELS,
  purchaseSizeFor,
  renderFileName,
  sanitizeFileName,
  type OrderColumnKey,
  type OrderExportFileInfo,
  type OrderExportProfile,
  type OrderExportRecord,
  type OrderPreview,
  type OrderPreviewLine,
  type OrderQueryInput,
  type OrderShopRef,
  type OrderStatus,
  type OrderSortOrder,
  type PolyesterType,
} from '@shared/orders';
import { config } from '../config/index.js';
import { orderRepository, shopKey, type StoredOrderLine } from '../repositories/order-repository.js';
import { orderExportRepository } from '../repositories/order-export-repository.js';
import { createZip } from '../util/zip.js';
import { logger } from '../util/logger.js';
import { OrderInputError } from './errors.js';
import { createOrderImageResolver } from './product-images.js';
import { loadExportImages } from './export-images.js';
import { createMaterialClassifier, type MaterialDecision } from './material-classifier.js';
import { orderProfileService } from './profile-service.js';
import { orderSourceRegistry } from './registry.js';
import { buildXlsx, XLSX_FONT_SIZE, XLSX_IMAGE_COLUMN_WIDTH, XLSX_IMAGE_SIZE, type XlsxCell } from './writers/xlsx.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface ClassifiedLine {
  line: StoredOrderLine;
  exportSelected: boolean;
  decision: MaterialDecision;
  imageUrls: string[];
  selectedImages: string[];
}

interface PlanBucket {
  key: string;
  label: string;
  kind: 'material' | 'unknown';
  excluded: boolean;
  fileTemplate: string;
  lines: ClassifiedLine[];
}

interface PlanFile {
  name: string;
  buckets: PlanBucket[];
  orderCount: number;
  quantity: number;
}

interface PlanShop extends OrderShopRef {
  shopName: string;
  platformLabel: string;
}

interface NormalizedQuery {
  shops: OrderShopRef[];
  statuses: OrderStatus[];
  from?: string;
  to?: string;
  onlyNew: boolean;
  overrides: Record<string, ProductMaterial>;
  polyesterTypes: Record<string, PolyesterType | null>;
  selectedImages: Record<string, string[]>;
  excludedLineUids: Set<string>;
  sortOrder: OrderSortOrder;
}

interface ExportPlan {
  profile: OrderExportProfile;
  query: NormalizedQuery;
  shops: PlanShop[];
  shopNames: Map<string, string>;
  buckets: PlanBucket[];
  files: PlanFile[];
  seq: number;
  warnings: string[];
}

interface CellContext {
  item: ClassifiedLine;
  bucket: PlanBucket;
  shopNames: Map<string, string>;
}

const COLUMN_BY_KEY = new Map(ORDER_COLUMNS.map((column) => [column.key as OrderColumnKey, column]));

/** 每一列怎么取值；Record 保证新增列时编译器提醒补齐。 */
const CELL_VALUES: Record<OrderColumnKey, (ctx: CellContext) => XlsxCell> = {
  platform: ({ item }) => orderSourceRegistry.label(item.line.platform),
  shop: ({ item, shopNames }) => shopNames.get(shopKey(item.line.platform, item.line.shopId)) ?? item.line.shopName,
  orderId: ({ item }) => item.line.orderId,
  orderedAt: ({ item }) => formatChinaDateTime(item.line.orderedAt),
  status: ({ item }) => ORDER_STATUS_LABELS[item.line.status] ?? item.line.status,
  rawStatus: ({ item }) => item.line.rawStatus,
  material: ({ item, bucket }) => (bucket.kind === 'material' ? bucket.label : materialLabel(item.decision.material)),
  productSku: ({ item }) => item.line.productSku,
  variantSku: ({ item }) => item.line.variantSku,
  title: ({ item }) => item.line.title,
  color: ({ item }) => item.line.color,
  size: ({ item }) => item.line.size,
  polyesterType: ({ item }) => item.decision.polyesterType ? POLYESTER_TYPE_LABELS[item.decision.polyesterType] : '',
  purchaseSize: ({ item }) => purchaseSizeFor(item.decision.material, item.line.size),
  quantity: ({ item }) => item.line.quantity,
  unitPrice: ({ item }) => item.line.unitPrice,
  amount: ({ item }) => item.line.amount,
  currency: ({ item }) => item.line.currency,
  imageUrl: ({ item }) => item.selectedImages[0],
  recipient: ({ item }) => item.line.address?.name,
  phone: ({ item }) => item.line.address?.phone,
  email: ({ item }) => item.line.address?.email,
  country: ({ item }) => item.line.address?.country,
  state: ({ item }) => item.line.address?.state,
  city: ({ item }) => item.line.address?.city,
  address: ({ item }) => [item.line.address?.line1, item.line.address?.line2].filter(Boolean).join(', '),
  zipCode: ({ item }) => item.line.address?.zipCode,
  taxNumber: ({ item }) => item.line.address?.taxNumber,
  carrier: ({ item }) => item.line.tracking?.carrier,
  trackingNumber: ({ item }) => item.line.tracking?.number,
  materialEvidence: ({ item }) => item.decision.evidence,
  note: ({ item }) => [
    item.line.isGift ? '赠品' : '',
    item.line.exportedAt ? `曾于 ${formatChinaDateTime(item.line.exportedAt)} 导出` : '',
  ].filter(Boolean).join('；'),
};

function statsOf(lines: ClassifiedLine[]): { orderCount: number; quantity: number } {
  return {
    orderCount: new Set(lines.map(({ line }) => line.orderUid)).size,
    quantity: lines.reduce((sum, { line }) => sum + line.quantity, 0),
  };
}

function toPreviewLine({ line, exportSelected, decision, imageUrls, selectedImages }: ClassifiedLine, shopNames: Map<string, string>): OrderPreviewLine {
  return {
    uid: line.uid,
    exportSelected,
    platform: line.platform,
    shopId: line.shopId,
    shopName: shopNames.get(shopKey(line.platform, line.shopId)) ?? line.shopName,
    orderId: line.orderId,
    orderedAt: line.orderedAt,
    status: line.status,
    rawStatus: line.rawStatus,
    productId: line.productId,
    productSku: line.productSku,
    variantSku: line.variantSku,
    title: line.title,
    color: line.color,
    size: line.size,
    purchaseSize: purchaseSizeFor(decision.material, line.size),
    polyesterType: decision.polyesterType,
    imageUrl: line.imageUrl,
    imageUrls,
    selectedImages,
    quantity: line.quantity,
    isGift: line.isGift,
    material: decision.material,
    materialSource: decision.source,
    materialEvidence: decision.evidence,
    exportedAt: line.exportedAt,
  };
}

export class OrderExportService {
  /** 导出串行执行，避免两个导出同时把同一批订单标记两次。 */
  private queue: Promise<unknown> = Promise.resolve();

  preview(input: OrderQueryInput): OrderPreview {
    const plan = this.buildPlan(input, new Date());
    const all = plan.buckets.flatMap((bucket) => bucket.lines);
    const totals = statsOf(all);
    return {
      buckets: plan.buckets.map((bucket) => ({
        key: bucket.key,
        label: bucket.label,
        kind: bucket.kind,
        excluded: bucket.excluded,
        ...statsOf(bucket.lines),
        lines: bucket.lines.map((item) => toPreviewLine(item, plan.shopNames)),
      })),
      files: plan.files.map((file) => ({
        name: `${file.name}.xlsx`,
        sheets: file.buckets.map((bucket) => bucket.label),
        orderCount: file.orderCount,
        quantity: file.quantity,
      })),
      totals: { orders: totals.orderCount, lines: all.length, quantity: totals.quantity },
      warnings: plan.warnings,
    };
  }

  export(input: OrderQueryInput): Promise<OrderExportRecord> {
    const run = this.queue.then(() => this.runExport(input));
    this.queue = run.catch(() => undefined);
    return run;
  }

  list(limit?: number): OrderExportRecord[] {
    return orderExportRepository.list(limit);
  }

  /** 单个导出文件在磁盘上的位置；记录不存在或文件已清理时抛错。 */
  filePath(exportId: string, fileId: string): { path: string; file: OrderExportFileInfo } {
    const record = this.requireLiveRecord(exportId);
    const file = record.files.find((item) => item.id === fileId);
    if (!file) throw new OrderInputError('文件不存在', 404);
    const filePath = path.join(config.orders.exportDir, record.id, `${file.id}.xlsx`);
    if (!fs.existsSync(filePath)) throw new OrderInputError('文件已被删除，请重新导出', 410);
    return { path: filePath, file };
  }

  buildZip(exportId: string): { name: string; buffer: Buffer } {
    const record = this.requireLiveRecord(exportId);
    const entries = record.files.map((file) => ({ name: file.name, data: fs.readFileSync(this.filePath(record.id, file.id).path) }));
    return { name: record.zipName, buffer: createZip(entries) };
  }

  /** 删除超过保留期的导出文件，记录保留。 */
  cleanupExpired(now = new Date()): number {
    const before = new Date(now.getTime() - config.orders.exportRetentionDays * DAY_MS).toISOString();
    let removed = 0;
    for (const id of orderExportRepository.listExpirable(before)) {
      try {
        fs.rmSync(path.join(config.orders.exportDir, id), { recursive: true, force: true });
        orderExportRepository.markFilesExpired(id);
        removed++;
      } catch (error) {
        logger.warn('清理过期订单导出文件失败', { exportId: id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return removed;
  }

  private requireLiveRecord(exportId: string): OrderExportRecord {
    const record = orderExportRepository.get(exportId);
    if (!record) throw new OrderInputError('导出记录不存在', 404);
    if (record.filesExpired) {
      throw new OrderInputError(`文件已超过 ${config.orders.exportRetentionDays} 天保留期并被清理，请重新导出`, 410);
    }
    return record;
  }

  private normalizeQuery(input: OrderQueryInput): NormalizedQuery {
    const shops = [...new Map(input.shops.map((shop) => [shopKey(shop.platform, shop.shopId), shop])).values()]
      .map(({ platform, shopId }) => ({ platform, shopId }));
    if (!shops.length) throw new OrderInputError('请至少选择一家店铺');
    for (const shop of shops) {
      if (!orderSourceRegistry.get(shop.platform)) throw new OrderInputError(`不支持的平台：${shop.platform}`);
    }
    const statuses = [...new Set(input.statuses)].filter(isOrderStatus);
    if (!statuses.length) throw new OrderInputError('请至少选择一个订单状态');
    if (input.from !== undefined && !isDateString(input.from)) throw new OrderInputError('开始日期格式不正确');
    if (input.to !== undefined && !isDateString(input.to)) throw new OrderInputError('结束日期格式不正确');
    if (input.from && input.to && input.from > input.to) throw new OrderInputError('开始日期不能晚于结束日期');
    if (input.sortOrder !== undefined && !['oldest', 'newest'].includes(input.sortOrder)) throw new OrderInputError('排序方式不正确');
    return {
      shops, statuses, from: input.from, to: input.to, onlyNew: input.onlyNew,
      overrides: input.overrides ?? {}, polyesterTypes: input.polyesterTypes ?? {}, selectedImages: input.selectedImages ?? {},
      excludedLineUids: new Set(input.excludedLineUids ?? []), sortOrder: input.sortOrder ?? 'oldest',
    };
  }

  private shopInfo(shops: OrderShopRef[]): { shops: PlanShop[]; names: Map<string, string> } {
    const names = new Map<string, string>();
    for (const source of orderSourceRegistry.list()) {
      for (const shop of source.listShops()) names.set(shopKey(source.platform, shop.shopId), shop.shopName);
    }
    return {
      names,
      shops: shops.map((shop) => ({
        ...shop,
        shopName: names.get(shopKey(shop.platform, shop.shopId)) ?? shop.shopId,
        platformLabel: orderSourceRegistry.label(shop.platform),
      })),
    };
  }

  private buildPlan(input: OrderQueryInput, now: Date): ExportPlan {
    const profile = orderProfileService.require(input.profileId);
    const query = this.normalizeQuery(input);
    const { shops, names: shopNames } = this.shopInfo(query.shops);
    const lines = orderRepository.queryLines({
      shops: query.shops,
      statuses: query.statuses,
      orderedFrom: query.from ? chinaDayStartIso(query.from) : undefined,
      orderedTo: query.to ? chinaDayStartIso(addDays(query.to, 1)) : undefined,
      profileId: profile.id,
      onlyNew: query.onlyNew,
    });

    const classify = createMaterialClassifier();
    const imagesFor = createOrderImageResolver();
    const materialBuckets: PlanBucket[] = profile.buckets.map((bucket) => ({
      key: bucket.material,
      label: bucket.label,
      kind: 'material',
      excluded: false,
      fileTemplate: bucket.fileName || profile.fileName,
      lines: [],
    }));
    const unknownBucket: PlanBucket = {
      key: 'unknown',
      label: profile.unknown.label,
      kind: 'unknown',
      excluded: true,
      fileTemplate: profile.unknown.fileName || profile.fileName,
      lines: [],
    };
    const byMaterial = new Map(materialBuckets.map((bucket) => [bucket.key, bucket]));
    for (const line of lines) {
      const decision = classify(line, query.overrides[line.uid]);
      if (decision.material === 'polyester' && Object.hasOwn(query.polyesterTypes, line.uid)) {
        decision.polyesterType = query.polyesterTypes[line.uid] ?? undefined;
      }
      const bucket = byMaterial.get(decision.material) ?? unknownBucket;
      const exportSelected = !bucket.excluded && !query.excludedLineUids.has(line.uid);
      const imageUrls = imagesFor(line);
      const requested = query.selectedImages[line.uid];
      if (exportSelected && requested && (!requested.length || requested.length > 21 || requested.some((url) => !imageUrls.includes(url)))) {
        throw new OrderInputError(`订单 ${line.orderId} 的选图已失效，请重新预览后选择商品图片`);
      }
      const selectedImages = requested ? [...new Set(requested)] : imageUrls.slice(0, 1);
      bucket.lines.push({ line, exportSelected, decision, imageUrls, selectedImages });
    }
    const buckets = unknownBucket.lines.length ? [...materialBuckets, unknownBucket] : materialBuckets;
    for (const bucket of buckets) bucket.lines.sort((a, b) => compareOrderLines(a.line, b.line, query.sortOrder));

    const seq = orderExportRepository.countSince(profile.id, chinaDayStartIso(chinaDate(now))) + 1;
    const { files, renamed } = this.planFiles(profile, buckets, shops, query, now, seq);
    const warnings = this.warnings(shops, unknownBucket, renamed);
    const missingTypes = buckets.flatMap((bucket) => bucket.lines)
      .filter((item) => item.exportSelected && item.decision.material === 'polyester' && !item.decision.polyesterType);
    if (missingTypes.length) warnings.push(`${missingTypes.length} 行聚酯纤维商品尚未选择平板或针眼，请选择后再导出，或取消勾选本次跳过。`);
    return {
      profile,
      query,
      shops,
      shopNames,
      buckets,
      files,
      seq,
      warnings,
    };
  }

  private planFiles(
    profile: OrderExportProfile,
    buckets: PlanBucket[],
    shops: PlanShop[],
    query: NormalizedQuery,
    now: Date,
    seq: number,
  ): { files: PlanFile[]; renamed: boolean } {
    const exportable = buckets.filter((bucket) => !bucket.excluded)
      .map((bucket) => ({ ...bucket, lines: bucket.lines.filter((item) => item.exportSelected) }))
      .filter((bucket) => bucket.lines.length);
    const context = {
      platforms: [...new Set(shops.map((shop) => shop.platformLabel))],
      shops: shops.map((shop) => shop.shopName),
      profile: profile.name,
      now,
      from: query.from,
      to: query.to,
      seq,
    };
    let files: PlanFile[];
    if (profile.layout === 'sheet-per-material') {
      const stats = statsOf(exportable.flatMap((bucket) => bucket.lines));
      files = exportable.length
        ? [{
          name: renderFileName(profile.fileName, {
            ...context,
            material: exportable.map((bucket) => bucket.label).join('+'),
            count: stats.orderCount,
            qty: stats.quantity,
          }),
          buckets: exportable,
          ...stats,
        }]
        : [];
    } else {
      files = exportable.map((bucket) => {
        const stats = statsOf(bucket.lines);
        return {
          name: renderFileName(bucket.fileTemplate, { ...context, material: bucket.label, count: stats.orderCount, qty: stats.quantity }),
          buckets: [bucket],
          ...stats,
        };
      });
    }
    // 重名时加 (2)(3) 区分，避免后一个文件覆盖前一个
    const taken = new Set<string>();
    let renamed = false;
    for (const file of files) {
      const base = sanitizeFileName(file.name);
      let name = base;
      for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} (${i})`;
      renamed ||= name !== base;
      taken.add(name.toLowerCase());
      file.name = name;
    }
    return { files, renamed };
  }

  private warnings(shops: PlanShop[], unknownBucket: PlanBucket, renamed: boolean): string[] {
    const warnings: string[] = [];
    for (const shop of shops) {
      const state = orderRepository.getSyncState(shop.platform, shop.shopId);
      if (!state?.lastSuccessAt) {
        warnings.push(`「${shop.shopName}」还没有成功同步过订单，请先点「同步并预览」。`);
      } else if (state.lastError) {
        warnings.push(`「${shop.shopName}」最近一次同步失败：${state.lastError}。当前用的是 ${formatChinaDateTime(state.lastSuccessAt)} 同步的数据。`);
      }
    }
    if (renamed) warnings.push('有文件名重复，已自动加 (2)、(3) 区分；可以在文件名模板里加上 {material}。');
    if (unknownBucket.excluded && unknownBucket.lines.length) {
      warnings.push(`${statsOf(unknownBucket.lines).orderCount} 单材质待确认或未启用，本次不导出；确认材质后可以再导出。`);
    }
    return warnings;
  }

  private async runExport(input: OrderQueryInput): Promise<OrderExportRecord> {
    const now = new Date();
    const plan = this.buildPlan(input, now);
    if (!plan.files.length) throw new OrderInputError('没有需要导出的订单');
    const missingType = plan.files.flatMap((file) => file.buckets.flatMap((bucket) => bucket.lines))
      .find((item) => item.decision.material === 'polyester' && !item.decision.polyesterType);
    if (missingType) throw new OrderInputError(`订单 ${missingType.line.orderId} 的聚酯纤维商品请选择平板或针眼后再导出`);
    const { profile, query } = plan;
    const exportId = uuid();
    const dir = path.join(config.orders.exportDir, exportId);
    const columnKeys = orderExportColumns(profile.columns);
    const columns = columnKeys.map((key) => COLUMN_BY_KEY.get(key)!).filter(Boolean);
    const exported = plan.files.flatMap((file) => file.buckets.flatMap((bucket) => bucket.lines));
    const missing = exported.find((item) => !item.selectedImages.length);
    if (missing) throw new OrderInputError(`订单 ${missing.line.orderId} 没有可导出的图片，请重新同步订单后再导出`);
    const images = await loadExportImages(exported.flatMap((item) => item.selectedImages));
    let record: OrderExportRecord;

    fs.mkdirSync(dir, { recursive: true });
    try {
      // 先写文件，全部成功后再在一个事务里记录并标记「已导出」
      const files: OrderExportFileInfo[] = plan.files.map((file, index) => {
        const id = String(index + 1);
        // 一件衣服始终一行，多选图扩展为图片 2、图片 3…，不重复数量和金额。
        const imageCount = file.buckets.reduce((max, bucket) => bucket.lines.reduce((n, item) => Math.max(n, item.selectedImages.length), max), 1);
        const buffer = buildXlsx(file.buckets.map((bucket) => ({
          name: bucket.label,
          columns: columns.flatMap<{ header: string; width: number; numeric: boolean }>((column) => column.key === 'imageUrl'
            ? Array.from({ length: imageCount }, (_, i) => ({ header: i ? `图片 ${i + 1}` : '图片', width: XLSX_IMAGE_COLUMN_WIDTH, numeric: false }))
            : [{ header: column.label, width: column.width * XLSX_FONT_SIZE / 11, numeric: 'numeric' in column ? column.numeric : false }]),
          rows: bucket.lines.map((item) => columns.flatMap((column) => column.key === 'imageUrl'
            ? Array.from({ length: imageCount }, (_, i) => images.get(item.selectedImages[i]) ?? '')
            : [CELL_VALUES[column.key]({ item, bucket, shopNames: plan.shopNames })])),
        })), now);
        fs.writeFileSync(path.join(dir, `${id}.xlsx`), buffer);
        return {
          id,
          name: `${file.name}.xlsx`,
          sheets: file.buckets.map((bucket) => bucket.label),
          orderCount: file.orderCount,
          quantity: file.quantity,
          size: buffer.length,
          lowResolutionImages: [...new Set(file.buckets.flatMap((bucket) => bucket.lines.flatMap((item) => item.selectedImages)))].filter((url) => {
            const image = images.get(url)!;
            return Math.max(image.width, image.height) < XLSX_IMAGE_SIZE;
          }).length,
        };
      });
      record = {
        id: exportId,
        profileId: profile.id,
        profileName: profile.name,
        createdAt: now.toISOString(),
        query: {
          shops: plan.shops.map(({ platform, shopId, shopName }) => ({ platform, shopId, shopName })),
          statuses: query.statuses,
          ...(query.from ? { from: query.from } : {}),
          ...(query.to ? { to: query.to } : {}),
          onlyNew: query.onlyNew,
          sortOrder: query.sortOrder,
        },
        summary: plan.buckets.map((bucket) => ({
          key: bucket.key,
          label: bucket.label,
          ...statsOf(bucket.lines.filter((item) => bucket.excluded || item.exportSelected)),
          exported: bucket.lines.some((item) => item.exportSelected),
        })),
        files,
        zipName: `${sanitizeFileName(`${chinaDate(now).replace(/-/g, '')}_${profile.name}_${String(plan.seq).padStart(2, '0')}`)}.zip`,
        filesExpired: false,
      };
      orderExportRepository.create(record, exported.map(({ line, decision }) => ({ lineUid: line.uid, material: decision.material })));
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }

    orderProfileService.rememberDefaults(profile.id, { shops: query.shops, statuses: query.statuses, onlyNew: query.onlyNew });
    logger.info('订单已导出', { exportId, profileId: profile.id, files: record.files.length, lines: exported.length });
    this.cleanupExpired(now);
    return record;
  }
}

export const orderExportService = new OrderExportService();
