import type { CategoryFavorite, CollectDefaults, GroupTemplateBinding, PresetsConfig, PresetTemplate } from '@shared/types';
import { isProductGroup, isProductMaterial } from '@shared/product-grouping';
import { settingsRepository, type SettingsRepository } from '../repositories/settings-repository.js';
import { shopService } from './shop-service.js';
import { config } from '../config/index.js';

const PRESETS_KEY = 'presets';
const LEGACY_KEY = 'collectDefaults';
type StoredPresetsConfig = PresetsConfig & { picuiToken?: string };

export { FACTORY_DEFAULTS, FACTORY_SIZE_TEMPLATES } from './preset-defaults.js';
import { FACTORY_DEFAULTS, FACTORY_SIZE_TEMPLATES } from './preset-defaults.js';

function defaultTemplate(defaults: CollectDefaults = FACTORY_DEFAULTS): PresetTemplate {
  return { id: 'default', name: '默认模板', defaults };
}

export class SettingsService {
  constructor(private readonly repo: SettingsRepository = settingsRepository) {}

  getGroupTemplateBindings(): GroupTemplateBinding[] {
    const templateIds = new Set(this.getConfig().templates.map((t) => t.id));
    return (this.repo.get<GroupTemplateBinding[]>('groupTemplateBindings') ?? []).filter((b) =>
      isProductGroup(b.groupId) && b.groupId !== 'pending'
      && (b.material === 'all' || (isProductMaterial(b.material) && b.material !== 'unknown'))
      && templateIds.has(b.templateId));
  }

  saveGroupTemplateBinding(binding: Omit<GroupTemplateBinding, 'templateId'> & { templateId: string | null }): GroupTemplateBinding[] {
    if (!isProductGroup(binding.groupId) || binding.groupId === 'pending'
      || !(binding.material === 'all' || (isProductMaterial(binding.material) && binding.material !== 'unknown'))) throw new Error('请先选择明确的分组和材质');
    if (binding.templateId && !this.getConfig().templates.some((t) => t.id === binding.templateId)) throw new Error('预设模板不存在');
    const next = this.getGroupTemplateBindings().filter((b) => b.groupId !== binding.groupId || b.material !== binding.material);
    if (binding.templateId) next.push({ ...binding, templateId: binding.templateId });
    this.repo.set('groupTemplateBindings', next);
    return next;
  }

  private publicConfig(value: StoredPresetsConfig): PresetsConfig {
    const { picuiToken: _picuiToken, ...publicValue } = value;
    return publicValue;
  }

  /** 读取预设配置;首次/旧版自动迁移出一个默认模板。 */
  getConfig(): PresetsConfig {
    const stored = this.repo.get<StoredPresetsConfig>(PRESETS_KEY);
    if (stored && Array.isArray(stored.templates) && stored.templates.length) {
      // 新增预设字段时为旧模板补齐出厂值；显式保存的空数组仍保留，表示关闭该功能。
      return this.publicConfig({
        ...stored,
        templates: stored.templates.map((t) => ({
          ...t,
          defaults: { ...FACTORY_DEFAULTS, ...t.defaults },
        })),
        // 尺码模板库缺失(旧数据)时补种子;已存在则原样保留(含用户增删)。
        sizeTemplates: stored.sizeTemplates ?? FACTORY_SIZE_TEMPLATES,
        categoryFavorites: stored.categoryFavorites ?? [],
        categoryAttributeTemplates: stored.categoryAttributeTemplates ?? [],
      });
    }
    // 迁移:旧版单一 collectDefaults -> 包成默认模板
    const legacy = this.repo.get<Partial<CollectDefaults>>(LEGACY_KEY);
    const tpl = defaultTemplate(legacy ? { ...FACTORY_DEFAULTS, ...legacy } : FACTORY_DEFAULTS);
    const config: StoredPresetsConfig = {
      templates: [tpl],
      activeId: tpl.id,
      sizeTemplates: FACTORY_SIZE_TEMPLATES,
      categoryFavorites: [],
      categoryAttributeTemplates: [],
    };
    this.repo.set(PRESETS_KEY, config);
    return this.publicConfig(config);
  }

  saveConfig(config: PresetsConfig): PresetsConfig {
    const templates = config.templates?.length ? config.templates : [defaultTemplate()];
    const activeId = templates.some((t) => t.id === config.activeId) ? config.activeId : templates[0].id;
    const stored = this.repo.get<StoredPresetsConfig>(PRESETS_KEY);
    const next: StoredPresetsConfig = {
      templates,
      activeId,
      sizeTemplates: config.sizeTemplates ?? FACTORY_SIZE_TEMPLATES,
      categoryFavorites: config.categoryFavorites ?? [],
      categoryAttributeTemplates: config.categoryAttributeTemplates ?? [],
      picuiToken: stored?.picuiToken,
    };
    this.repo.set(PRESETS_KEY, next);
    return this.publicConfig(next);
  }

  getPicuiPublic() {
    const stored = this.repo.get<StoredPresetsConfig>(PRESETS_KEY)?.picuiToken?.trim() || config.picui.token;
    return { configured: Boolean(stored), tokenHint: stored ? `******${stored.slice(-4)}` : undefined };
  }

  savePicuiToken(token: string) {
    const value = token.trim();
    if (!value) throw new Error('PICUI Token 不能为空');
    const current = this.repo.get<StoredPresetsConfig>(PRESETS_KEY) ?? {
      templates: [defaultTemplate()],
      activeId: 'default',
    };
    this.repo.set(PRESETS_KEY, { ...current, picuiToken: value });
    return this.getPicuiPublic();
  }

  getPicuiToken(): string {
    return this.repo.get<StoredPresetsConfig>(PRESETS_KEY)?.picuiToken?.trim() || config.picui.token;
  }

  /** 当前默认模板 id(新采集商品用)。 */
  getActiveTemplateId(): string {
    return this.getConfig().activeId;
  }

  /** 取某模板的 defaults(缺省回退默认模板 -> 出厂值),模板字段与出厂值合并补全。 */
  getDefaultsFor(templateId?: string): CollectDefaults {
    const cfg = this.getConfig();
    const tpl =
      (templateId && cfg.templates.find((t) => t.id === templateId)) ||
      cfg.templates.find((t) => t.id === cfg.activeId) ||
      cfg.templates[0];
    const defaults = { ...FACTORY_DEFAULTS, ...(tpl?.defaults ?? {}) };
    return {
      ...defaults,
      storeId: defaults.storeId || shopService.getActiveStoreId(),
    };
  }
}

export const settingsService = new SettingsService();
