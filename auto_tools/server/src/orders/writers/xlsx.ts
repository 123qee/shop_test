import { createZip } from '../../util/zip.js';

/**
 * 极简 xlsx 写入：内联字符串、冻结表头、自动筛选、列宽。
 * 文本列一律按字符串写入并设为「文本」格式，订单号、电话、邮编、运单号不会被 Excel 改成科学计数法或丢掉开头的 0。
 */

export interface XlsxColumn {
  header: string;
  width?: number;
  numeric?: boolean;
}

export type XlsxCell = string | number | null | undefined;

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

function sheetXml(sheet: XlsxSheet, selected: boolean): string {
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
      if (value === null || value === undefined || value === '') return '';
      const ref = `${columnLetter(c)}${rowNumber}`;
      if (column.numeric && typeof value === 'number' && Number.isFinite(value)) {
        return `<c r="${ref}" s="${STYLE_DEFAULT}"><v>${value}</v></c>`;
      }
      return textCell(ref, String(value), column.numeric ? STYLE_DEFAULT : STYLE_TEXT);
    }).join('');
    return `<row r="${rowNumber}">${cells}</row>`;
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
    + '</worksheet>';
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
  const names = sheetNames(sheets.map((sheet) => sheet.name));
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const sheetOverrides = sheets
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('');
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + sheetOverrides
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
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sheet, i === 0), date: now })),
  ]);
}
