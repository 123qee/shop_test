import { getConfig } from '../common/config.js';
import { sendMessage } from '../common/messages.js';

const statusDot = document.getElementById('statusDot')!;
const statusText = document.getElementById('statusText')!;
const totalEl = document.getElementById('total')!;
const joomEnvEl = document.getElementById('joomEnv')!;

async function refresh(): Promise<void> {
  // 后端连接 + Joom 环境
  const ping = await sendMessage({ type: 'PING_BACKEND' });
  if (ping.ok && ping.type === 'PING_BACKEND') {
    statusDot.className = 'dot ok';
    statusText.textContent = '已连接';
    joomEnvEl.textContent = ping.joomEnv;
  } else {
    statusDot.className = 'dot err';
    statusText.textContent = ping.ok ? '未知' : '未连接';
  }
  // 采集数量
  const stats = await sendMessage({ type: 'GET_STATS' });
  totalEl.textContent = stats.ok && stats.type === 'GET_STATS' ? String(stats.total) : '—';
}

document.getElementById('openWeb')!.addEventListener('click', async () => {
  const { backendUrl } = await getConfig();
  chrome.tabs.create({ url: backendUrl });
});
document.getElementById('openOptions')!.addEventListener('click', () => chrome.runtime.openOptionsPage());

refresh().catch(() => {
  statusDot.className = 'dot err';
  statusText.textContent = '未连接';
});
