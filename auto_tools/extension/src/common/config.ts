/** 插件配置的读写(存 chrome.storage.local)。 */

export interface ExtensionConfig {
  /** 后端地址 */
  backendUrl: string;
}

const DEFAULTS: ExtensionConfig = {
  backendUrl: 'http://localhost:8787',
};

export async function getConfig(): Promise<ExtensionConfig> {
  const stored = await chrome.storage.local.get('config');
  return { ...DEFAULTS, ...(stored.config as Partial<ExtensionConfig> | undefined) };
}

export async function setConfig(patch: Partial<ExtensionConfig>): Promise<ExtensionConfig> {
  const next = { ...(await getConfig()), ...patch };
  await chrome.storage.local.set({ config: next });
  return next;
}
