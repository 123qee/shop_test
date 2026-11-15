import { getConfig, setConfig } from '../common/config.js';

const input = document.getElementById('backendUrl') as HTMLInputElement;
const saved = document.getElementById('saved')!;

getConfig().then((c) => {
  input.value = c.backendUrl;
});

document.getElementById('save')!.addEventListener('click', async () => {
  const backendUrl = input.value.trim().replace(/\/$/, '');
  await setConfig({ backendUrl });
  saved.style.display = 'inline';
  setTimeout(() => (saved.style.display = 'none'), 1500);
});
