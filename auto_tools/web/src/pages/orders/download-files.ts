export interface DownloadFile { id: string; name: string; url: string }

/** 逐个下载独立 Excel；一份失败仍继续其余文件，不重新导出或重复标记订单。 */
export async function downloadFiles(files: DownloadFile[]): Promise<string[]> {
  const failed: string[] = [];
  for (const [index, file] of files.entries()) {
    // 避免连续点击被浏览器合并；逐份交给下载管理器。
    if (index > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(file.url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.name;
      document.body.appendChild(anchor);
      try { anchor.click(); }
      finally {
        anchor.remove();
        // 留出浏览器接管文件的时间，再释放内存。
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
    } catch {
      failed.push(file.id);
    } finally { window.clearTimeout(timeout); }
  }
  return failed;
}
