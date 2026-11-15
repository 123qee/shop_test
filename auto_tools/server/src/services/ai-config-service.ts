import type { AiConfigPublic, AiTitleMaterial, AiTitleMaterialPreset } from '@shared/types';
import { config } from '../config/index.js';
import { settingsRepository, type SettingsRepository } from '../repositories/settings-repository.js';
import { TITLE_MATERIAL_PRESETS, defaultPromptFor } from './ai-title-prompts.js';

const AI_KEY = 'aiConfig';

interface StoredAiConfig {
  apiKey?: string;
  model?: string;
  preview?: boolean;
  material?: AiTitleMaterial;
  prompts?: Partial<Record<AiTitleMaterial, string>>;
}

function maskKey(key: string): string {
  if (key.length <= 8) return '已配置';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function isMaterial(value: unknown): value is AiTitleMaterial {
  return value === 'cotton' || value === 'polyester';
}

export class AiConfigService {
  constructor(private readonly repo: SettingsRepository = settingsRepository) {}

  private stored(): StoredAiConfig {
    return this.repo.get<StoredAiConfig>(AI_KEY) ?? {};
  }

  /** 设置页优先，其次读 .env。 */
  getSecret(): { apiKey: string; model: string; baseUrl: string } {
    const stored = this.stored();
    const apiKey = stored.apiKey?.trim() || config.deepseek.apiKey;
    return {
      apiKey,
      model: stored.model?.trim() || config.deepseek.model,
      baseUrl: config.deepseek.baseUrl.replace(/\/$/, ''),
    };
  }

  resolveMaterials(): AiTitleMaterialPreset[] {
    const custom = this.stored().prompts ?? {};
    return TITLE_MATERIAL_PRESETS.map((preset) => ({
      ...preset,
      factoryPrompt: preset.prompt,
      prompt: custom[preset.id]?.trim() || preset.prompt,
    }));
  }

  resolvePrompt(material: AiTitleMaterial): string {
    return this.resolveMaterials().find((p) => p.id === material)?.prompt || defaultPromptFor(material);
  }

  getPublic(): AiConfigPublic {
    const secret = this.getSecret();
    const stored = this.stored();
    return {
      configured: Boolean(secret.apiKey),
      provider: 'deepseek',
      model: secret.model,
      apiKeyHint: secret.apiKey ? maskKey(secret.apiKey) : undefined,
      preview: stored.preview !== false,
      material: isMaterial(stored.material) ? stored.material : 'polyester',
      materials: this.resolveMaterials(),
    };
  }

  save(input: {
    apiKey?: string;
    model?: string;
    preview?: boolean;
    material?: AiTitleMaterial;
    prompts?: Partial<Record<AiTitleMaterial, string>>;
  }): AiConfigPublic {
    const current = this.stored();
    const next: StoredAiConfig = {
      apiKey: input.apiKey !== undefined ? input.apiKey.trim() : current.apiKey,
      model: input.model !== undefined ? input.model.trim() || current.model : current.model,
      preview: input.preview !== undefined ? input.preview : current.preview,
      material: input.material !== undefined ? input.material : current.material,
      prompts: input.prompts !== undefined ? { ...(current.prompts ?? {}), ...input.prompts } : current.prompts,
    };
    this.repo.set(AI_KEY, next);
    return this.getPublic();
  }
}

export const aiConfigService = new AiConfigService();
