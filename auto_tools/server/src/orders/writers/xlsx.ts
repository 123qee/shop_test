import { createZip, type ZipEntry } from '../../util/zip.js';

/**
 * 极简 xlsx 写入：内联字符串、冻结表头、自动筛选、列宽。
 * 文本列一律按字符串写入并设为「文本」格式，订单号、电话、邮编、运单号不会被 Excel 改成科学计数法或丢掉开头的 0。
 */

export interface XlsxColumn {
  header: string;
  width?: number;
  numeric?: boolean;
}

export interface XlsxImageCell {
  kind: 'image';
  /** 已解码和规范化的 JPEG 内容。 */
  data: Buffer;
  width: number;
  height: number;
}

export type XlsxCell = string | number | null | undefined | XlsxImageCell;

function isImage(value: XlsxCell): value is XlsxImageCell {
  return typeof value === 'object' && value !== null && value.kind === 'image';
}

export interface XlsxSheet {
  name: string;
  columns: XlsxColumn[];
  rows: XlsxCell[][];
}

const MAX_CELL_LENGTH = 32767;
const STYLE_DEFAULT = 0;
const STYLE_HEADER = 1;
const STYLE_TEXT = 2;

function escapeXml(value: string): string {
  return value
    // XML 1.0 不允许的控制字符与孤立代理项
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function columnLetter(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** Excel 工作表名：≤31 字符，不含 : \ / ? * [ ]，不以 ' 开头或结尾，大小写不敏感地唯一。 */
export function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    let base = raw.replace(/[:\\/?*[\]]/g, '_').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Sheet';
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) {
      const suffix = ` (${i})`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

function textCell(ref: string, value: string, style: number): string {
  const text = escapeXml(value.length > MAX_CELL_LENGTH ? value.slice(0, MAX_CELL_LENGTH) : value);
  const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}" t="inlineStr" s="${style}"><is><t${space}>${text}</t></is></c>`;
}

function sheetXml(sheet: XlsxSheet, selected: boolean, hasDrawing: boolean): string {
  const columnCount = Math.max(1, sheet.columns.length);
  const lastColumn = columnLetter(columnCount - 1);
  const lastRow = sheet.rows.length + 1;
  const cols = sheet.columns
    .map((column, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(4, Math.min(80, column.width ?? 12))}" customWidth="1"/>`)
    .join('');
  const header = sheet.columns.map((column, i) => textCell(`${columnLetter(i)}1`, column.header, STYLE_HEADER)).join('');
  const body = sheet.rows.map((row, r) => {
    const rowNumber = r + 2;
    const cells = sheet.columns.map((column, c) => {
      const value = row[c];
      if (isImage(value)) return '';
      if (value === null || value === undefined || value === '') return '';
      const ref = `${columnLetter(c)}${rowNumber}`;
      if (column.numeric && typeof value === 'number' && Number.isFinite(value)) {
        return `<c r="${ref}" s="${STYLE_DEFAULT}"><v>${value}</v></c>`;
      }
      return textCell(ref, String(value), column.numeric ? STYLE_DEFAULT : STYLE_TEXT);
    }).join('');
    return `<row r="${rowNumber}"${row.some(isImage) ? ' ht="108" customHeight="1"' : ''}>${cells}</row>`;
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<dimension ref="A1:${lastColumn}${lastRow}"/>`
    + `<sheetViews><sheetView workbookViewId="0"${selected ? ' tabSelected="1"' : ''}>`
    + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
    + '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
    + '</sheetView></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + (cols ? `<cols>${cols}</cols>` : '')
    + `<sheetData><row r="1">${header}</row>${body}</sheetData>`
    + (sheet.columns.length ? `<autoFilter ref="A1:${lastColumn}${lastRow}"/>` : '')
    + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
    + (hasDrawing ? '<drawing r:id="rIdDrawing"/>' : '')
    + '</worksheet>';
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const EMU_PER_PIXEL = 9525;

/** 标准 DrawingML 嵌图：随所属单元格移动，按原比例放进图片列，媒体直接存在 xlsx 包内。 */
function drawingParts(sheets: XlsxSheet[]) {
  const parts: ZipEntry[] = [];
  const media = new Map<XlsxImageCell, number>();
  const drawn = new Set<number>();
  sheets.forEach((sheet, sheetIndex) => {
    const anchors: string[] = [];
    const relationships: string[] = [];
    sheet.rows.forEach((row, rowIndex) => row.forEach((cell, colIndex) => {
      if (!isImage(cell) || colIndex >= sheet.columns.length) return;
      if (!cell.width || !cell.height || !cell.data.length) throw new Error('无效的 Excel 图片');
      if (!media.has(cell)) {
        const id = media.size + 1;
        media.set(cell, id);
        parts.push({ name: `xl/media/image${id}.jpeg`, data: cell.data });
      }
      const id = anchors.length + 1;
      const colWidth = Math.max(4, Math.min(80, sheet.columns[colIndex].width ?? 12)) * 7 + 5;
      const scale = Math.min((colWidth - 12) / cell.width, 132 / cell.height);
      const width = Math.round(cell.width * scale * EMU_PER_PIXEL);
      const height = Math.round(cell.height * scale * EMU_PER_PIXEL);
      const offsetX = Math.round((colWidth * EMU_PER_PIXEL - width) / 2);
      const offsetY = Math.round((144 * EMU_PER_PIXEL - height) / 2);
      anchors.push('<xdr:oneCellAnchor>'
        + `<xdr:from><xdr:col>${colIndex}</xdr:col><xdr:colOff>${offsetX}</xdr:colOff><xdr:row>${rowIndex + 1}</xdr:row><xdr:rowOff>${offsetY}</xdr:rowOff></xdr:from>`
        + `<xdr:ext cx="${width}" cy="${height}"/>`
        + `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="图片 ${id}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`
        + `<xdr:blipFill><a:blip r:embed="rId${id}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
        + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`
        + '<xdr:clientData/></xdr:oneCellAnchor>');
      relationships.push(`<Relationship Id="rId${id}" Type="${OFFICE_REL_NS}/image" Target="../media/image${media.get(cell)}.jpeg"/>`);
    }));
    if (!anchors.length) return;
    const number = sheetIndex + 1;
    drawn.add(sheetIndex);
    parts.push(
      { name: `xl/worksheets/_rels/sheet${number}.xml.rels`, data: `${XML_HEADER}<Relationships xmlns="${REL_NS}"><Relationship Id="rIdDrawing" Type="${OFFICE_REL_NS}/drawing" Target="../drawings/drawing${number}.xml"/></Relationships>` },
      { name: `xl/drawings/drawing${number}.xml`, data: `${XML_HEADER}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL_NS}">${anchors.join('')}</xdr:wsDr>` },
      { name: `xl/drawings/_rels/drawing${number}.xml.rels`, data: `${XML_HEADER}<Relationships xmlns="${REL_NS}">${relationships.join('')}</Relationships>` },
    );
  });
  return { parts, drawn };
}

const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="2">'
  + '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
  + '</fonts>'
  + '<fills count="3">'
  + '<fill><patternFill patternType="none"/></fill>'
  + '<fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>'
  + '</fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="3">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="49" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>'
  + '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '</cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

/** 生成 xlsx 文件内容。 */
export function buildXlsx(sheets: XlsxSheet[], now = new Date()): Buffer {
  if (!sheets.length) throw new Error('xlsx 至少需要一个工作表');
  const { parts: imageParts, drawn } = drawingParts(sheets);
  const names = sheetNames(sheets.map((sheet) => sheet.name));
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const sheetOverrides = sheets
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('');
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + (drawn.size ? '<Default Extension="jpeg" ContentType="image/jpeg"/>' : '')
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + sheetOverrides
    + [...drawn].map((i) => `<Override PartName="/xl/drawings/drawing${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`).join('')
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    + '</Types>';
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
    + '</Relationships>';
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<bookViews><workbookView activeTab="0"/></bookViews>'
    + `<sheets>${names.map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>`
    + '</workbook>';
  const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + '</Relationships>';
  const core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + '<dc:creator>auto_tools</dc:creator>'
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created>`
    + `<dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified>`
    + '</cp:coreProperties>';
  const app = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
    + '<Application>auto_tools</Application>'
    + '</Properties>';

  return createZip([
    { name: '[Content_Types].xml', data: contentTypes, date: now },
    { name: '_rels/.rels', data: rootRels, date: now },
    { name: 'docProps/core.xml', data: core, date: now },
    { name: 'docProps/app.xml', data: app, date: now },
    { name: 'xl/workbook.xml', data: workbook, date: now },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels, date: now },
    { name: 'xl/styles.xml', data: STYLES_XML, date: now },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sheet, i === 0, drawn.has(i)), date: now })),
    ...imageParts.map((part) => ({ ...part, date: now })),
  ]);
}
