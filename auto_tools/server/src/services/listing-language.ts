import { marketplaceRegistry } from '../marketplaces/registry.js';
import { JoomAdapter } from '../marketplaces/joom/adapter.js';
import { normalizeJoomColorList } from '@shared/listing-language';

export {
  DEFAULT_JOOM_COLOR,
  colorStillUnresolved,
  foldColorKey,
  hasNonLatinListingText,
  isOfficialColor,
  languageRiskHints,
  listingHasLanguageRisk,
  mapColorValue,
  normalizeJoomColorList,
  normalizeProductColors,
  suggestMappedColor,
} from '@shared/listing-language';

let cache: { at: number; colors: string[] } | null = null;
const CACHE_MS = 10 * 60 * 1000;

/** 拉取 Joom 官方色名；未连接或失败时返回 undefined，调用方跳过官方名单校验。 */
export async function loadOfficialJoomColors(force = false, shopId?: string): Promise<string[] | undefined> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.colors;
  try {
    const joom = marketplaceRegistry.require('joom') as JoomAdapter;
    const adapter = shopId ? joom.forShop(shopId) : joom;
    if (!(await adapter.isConnected())) return undefined;
    const colors = normalizeJoomColorList(await adapter.getColors());
    if (!colors.length) return undefined;
    cache = { at: Date.now(), colors };
    return colors;
  } catch {
    return undefined;
  }
}
