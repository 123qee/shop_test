import type { CollectedProduct, CollectTemplateOutcome } from '@shared/types';
import type { AliExpressAutoFillConfig } from '@shared/aliexpress-auto-fill';

/** 批量采集的模板处理结果统计。 */
export interface CollectTally {
  /** 采集栏选了模板且核对无矛盾，入库即确认。 */
  confirmed: number;
  /** 没选模板或核对有矛盾，需要到采集箱分拣。 */
  review: number;
  /** 之前已经采过，没有新建。 */
  duplicates: number;
}

/** content <-> background 的消息协议。 */
export type Message =
  | { type: 'COLLECT_PRODUCT'; product: CollectedProduct; templateId?: string }
  | { type: 'PING_BACKEND' }
  | { type: 'GET_STATS' }
  | { type: 'VIDEO_BACKFILL_START'; since: string }
  | { type: 'VIDEO_BACKFILL_STATUS' }
  | { type: 'VIDEO_BACKFILL_STOP' }
  /** 读取采集模板列表,供来源页面的采集栏选择。 */
  | { type: 'GET_PRESETS' }
  | { type: 'GET_ALIEXPRESS_AUTOFILL_CONFIG' }
  /** 列表页批量采集:传各商品详情页 URL,后台逐个开标签页提取全量数据 */
  | { type: 'BATCH_COLLECT'; urls: string[]; templateId?: string }
  /** 中止正在进行的批量采集 */
  | { type: 'BATCH_STOP' }
  /** background -> 目标详情标签页:提取详情(不入库,返回数据由后台统一入库) */
  | { type: 'EXTRACT_DETAIL' }
  /** 按商品 URL 提取(Wildberries 走公开 JSON,不打开详情页) */
  | { type: 'EXTRACT_BY_URL'; url: string }
  /** background -> 发起列表页:批量进度通知 */
  | { type: 'BATCH_PROGRESS'; done: number; total: number; ok: number; fail: number; stopped?: boolean; note?: string; tally?: CollectTally };

export type MessageResponse =
  | { ok: true; type: 'COLLECT_PRODUCT'; id: string; duplicate?: boolean; template?: CollectTemplateOutcome }
  | { ok: true; type: 'PING_BACKEND'; joomEnv: string }
  | { ok: true; type: 'GET_STATS'; total: number }
  | { ok: true; type: 'VIDEO_BACKFILL'; status: VideoBackfillStatus }
  | { ok: true; type: 'GET_PRESETS'; templates: Array<{ id: string; name: string }>; activeId: string }
  | { ok: true; type: 'GET_ALIEXPRESS_AUTOFILL_CONFIG'; config: AliExpressAutoFillConfig }
  | { ok: true; type: 'BATCH_COLLECT'; total: number; okCount: number; fail: number; stopped: boolean; tally?: CollectTally }
  | { ok: true; type: 'BATCH_STOP'; active: boolean }
  | { ok: true; type: 'EXTRACT_DETAIL'; product: CollectedProduct | null }
  | { ok: true; type: 'EXTRACT_BY_URL'; product: CollectedProduct | null }
  | { ok: false; error: string };

export interface VideoBackfillStatus {
  state: 'idle' | 'running' | 'stopped' | 'completed';
  total: number;
  done: number;
  found: number;
  missing: number;
  failed: number;
  currentTitle?: string;
  error?: string;
}

/** content 端发送消息的类型化封装。 */
export function sendMessage(msg: Message): Promise<MessageResponse> {
  return chrome.runtime.sendMessage(msg);
}
