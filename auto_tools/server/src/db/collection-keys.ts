// SQLite expression indexes and their queries must use the same expressions.
// Match String.trim() on older records too, including tabs, nonbreaking spaces and BOM.
const whitespace = 'char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)';
const url = `trim(json_extract(collected, '$.sourceUrl'), ${whitespace})`;

export const collectionKeys = {
  source: "json_extract(collected, '$.source')",
  sourceId: `trim(json_extract(collected, '$.sourceProductId'), ${whitespace})`,
  // Remove the query/fragment, then trailing slashes, just as on the incoming URL.
  url: `rtrim(substr(${url}, 1, min(instr(${url} || '?', '?'), instr(${url} || '#', '#')) - 1), '/')`,
  generatedSku: "json_extract(collected, '$.generatedSku')",
  editedSku: "json_extract(edited, '$.sku')",
};
