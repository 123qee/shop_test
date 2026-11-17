import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import sharp from 'sharp';
import { loadExportImages } from '../src/orders/export-images';
import { buildXlsx } from '../src/orders/writers/xlsx';
import { unzip } from './helpers/zip-reader';

test('实际下载 WebP / PNG，转 JPEG，去重并校验坏图', async (t) => {
  const webp = await sharp({ create: { width: 50, height: 100, channels: 3, background: '#abcdef' } }).webp().toBuffer();
  const png = await sharp({ create: { width: 2000, height: 1000, channels: 4, background: '#12345600' } }).png().toBuffer();
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url!);
    if (req.url === '/bad') { res.end('<html>not an image</html>'); return; }
    if (req.url === '/missing') { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'image/webp');
    res.end(req.url === '/png' ? png : webp);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const images = await loadExportImages([`${base}/webp`, `${base}/png`, `${base}/webp`]);
  assert.equal(images.size, 2);
  assert.deepEqual(hits.sort(), ['/png', '/webp']);
  assert.deepEqual([images.get(`${base}/png`)!.width, images.get(`${base}/png`)!.height], [720, 360]);
  assert.equal((await sharp(images.get(`${base}/webp`)!.data).metadata()).format, 'jpeg');
  await assert.rejects(loadExportImages([`${base}/bad`]), /下载或处理失败/);
  await assert.rejects(loadExportImages([`${base}/missing`]), /HTTP 404/);
  await assert.rejects(loadExportImages(Array.from({ length: 1001 }, (_, i) => `${base}/${i}`)), /超过 1000 张/);
});

test('多工作表嵌图：关系、媒体、行高、宽高比和选图顺序保持正确', async () => {
  const data = await sharp({ create: { width: 40, height: 80, channels: 3, background: '#789abc' } }).jpeg().toBuffer();
  const image = { kind: 'image' as const, data, width: 40, height: 80 };
  const files = unzip(buildXlsx([
    { name: '棉', columns: [{ header: '图片', width: 22 }, { header: '数量', numeric: true }], rows: [[image, 2]] },
    { name: '聚酯纤维', columns: [{ header: '尺码' }, { header: '图片', width: 22 }], rows: [['M', image], ['XL', image]] },
    { name: '统计', columns: [{ header: '数量', numeric: true }], rows: [[4]] },
  ]));
  assert.equal([...files.keys()].filter((name) => name.startsWith('xl/media/')).length, 1);
  assert.match(files.get('xl/worksheets/sheet1.xml')!.toString(), /<row r="2" ht="108" customHeight="1">/);
  assert.match(files.get('xl/worksheets/_rels/sheet2.xml.rels')!.toString(), /drawing2.xml/);
  assert.ok(!files.has('xl/worksheets/_rels/sheet3.xml.rels'));
  assert.match(files.get('[Content_Types].xml')!.toString(), /Extension="jpeg" ContentType="image\/jpeg"/);
  const drawing = files.get('xl/drawings/drawing2.xml')!.toString();
  assert.equal((drawing.match(/<xdr:oneCellAnchor>/g) ?? []).length, 2);
  assert.match(drawing, /<xdr:col>1<\/xdr:col>/);
  assert.match(drawing, /<xdr:row>2<\/xdr:row>/);
  const extent = drawing.match(/<xdr:ext cx="(\d+)" cy="(\d+)"/)!;
  assert.equal(Number(extent[1]) / Number(extent[2]), 0.5, '保持竖图宽高比');
  assert.ok(files.get('xl/media/image1.jpeg')!.equals(data));
});
