import type { SourceExtractor } from './types.js';
import { aliexpressExtractor } from './aliexpress.js';
import { allegroExtractor } from './allegro.js';
import { amazonExtractor } from './amazon.js';
import { asosExtractor } from './asos.js';
import { georgeExtractor } from './george.js';
import { joomExtractor } from './joom.js';
import { mercadolibreExtractor } from './mercadolibre.js';
import { ozonExtractor } from './ozon.js';
import { wildberriesExtractor } from './wildberries.js';

/** 已注册的来源平台提取器。加平台时在此数组追加。 */
const extractors: SourceExtractor[] = [aliexpressExtractor, allegroExtractor, amazonExtractor, asosExtractor, georgeExtractor, joomExtractor, mercadolibreExtractor, ozonExtractor, wildberriesExtractor];

/** 返回匹配当前 URL 的提取器。 */
export function resolveExtractor(url: string): SourceExtractor | null {
  return extractors.find((e) => e.matches(url)) ?? null;
}
