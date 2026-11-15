export type AliExpressFillField = {
  id: string;
  group: string;
  label: string;
  value: string;
  enabled: boolean;
  kind: 'text' | 'number' | 'toggle';
  help: string;
};

export type AliExpressAutoFillConfig = {
  fields: AliExpressFillField[];
  updatedAt: string | null;
};

export const ALIEXPRESS_AUTO_FILL_DEFAULTS: AliExpressAutoFillConfig = {
  updatedAt: null,
  fields: [
    { id: 'titleMaxChars', group: '标题与基础', label: '标题上限', value: '128', enabled: true, kind: 'number', help: '超过此字符数时自动截短。' },
    { id: 'sizeList', group: '标题与基础', label: '目标尺码', value: 'XXS|XS|S|M|L|XL|XXL|XXXL', enabled: true, kind: 'text', help: '用 | 分隔尺码，顺序即 ERP 显示顺序。' },
    { id: 'categoryPath', group: '分类与基础', label: '产品分类路径', value: '男装|上衣，T恤|T恤', enabled: true, kind: 'text', help: '从一级到末级分类用 | 分隔；当前页面分类不一致时自动选择。' },
    { id: 'brand', group: '商品属性', label: '品牌', value: 'NONE', enabled: true, kind: 'text', help: '目标选项。' },
    { id: 'origin', group: '商品属性', label: '产地', value: '中国大陆|Mainland China', enabled: true, kind: 'text', help: '多个可匹配选项用 | 分隔。' },
    { id: 'province', group: '商品属性', label: '中国省份', value: '江西|Jiangxi', enabled: true, kind: 'text', help: '多个可匹配选项用 | 分隔。' },
    { id: 'sleeveLength', group: '商品属性', label: '袖长(cm)', value: '短款（4-16inch）|Short (4 - 16 Inch)', enabled: true, kind: 'text', help: '目标选项。' },
    { id: 'style', group: '商品属性', label: '风格', value: '休闲|Casual', enabled: true, kind: 'text', help: '多个可匹配选项用 | 分隔。' },
    { id: 'material', group: '商品属性', label: '材质', value: 'COTTON', enabled: true, kind: 'text', help: '自动流程仅对棉质 T 恤应用当前比例。' },
    { id: 'scene', group: '商品属性', label: '适用场景', value: 'Daily', enabled: true, kind: 'text', help: '目标选项。' },
    { id: 'season', group: '商品属性', label: '适用季节', value: '夏季|summer', enabled: true, kind: 'text', help: '目标选项。' },
    { id: 'knit', group: '商品属性', label: '编织工艺', value: '针织|Knit', enabled: true, kind: 'text', help: '目标选项。' },
    { id: 'features', group: '商品属性', label: '特殊功能', value: '可拉伸|可持续|防皱', enabled: true, kind: 'text', help: '多选项会全部勾选。' },
    { id: 'chemicals', group: '商品属性', label: '高关注化学品', value: '无', enabled: true, kind: 'text', help: '目标选项。' },
    { id: 'care', group: '商品属性', label: '产品保养说明', value: '机洗|Machine Wash', enabled: true, kind: 'text', help: '目标选项。' },
    { id: 'gender', group: '商品属性', label: '性别', value: '男性|Men', enabled: true, kind: 'text', help: '目标选项。' },
    { id: 'topType', group: '商品属性', label: '上衣类型', value: 'T恤|TEES', enabled: true, kind: 'text', help: '目标选项。' },
    { id: 'productType', group: '商品属性', label: '产品类型', value: 'tops', enabled: true, kind: 'text', help: '目标选项。' },
    { id: 'collar', group: '商品属性', label: '领型', value: '圆领|O-Neck', enabled: true, kind: 'text', help: '目标选项。' },
    { id: 'pattern', group: '商品属性', label: '图案类型', value: '印花', enabled: true, kind: 'text', help: '目标选项。' },
    { id: 'hood', group: '商品属性', label: '是否带帽', value: '无帽|No', enabled: true, kind: 'text', help: '目标选项。' },
    { id: 'fabricType', group: '商品属性', label: '面料类型', value: '细平布|Broadcloth', enabled: true, kind: 'text', help: '目标选项。' },
    { id: 'shippingTemplate', group: '模板与资质', label: '运费模板', value: 'copy copy copy copy copy 人民币20.9预算模板', enabled: true, kind: 'text', help: '匹配人民币20.9预算模板；ERP显示的copy前缀数量可能变化。' },
    { id: 'serviceTemplate', group: '模板与资质', label: '服务模板', value: 'Service Template for New Sellers', enabled: true, kind: 'text', help: '必须与当前账号中的模板名称一致。' },
    { id: 'euResponsible', group: '模板与资质', label: '欧盟责任人', value: 'Jiang Weijia', enabled: true, kind: 'text', help: '目标账号中已维护的责任人。' },
    { id: 'manufacturer', group: '模板与资质', label: '关联制造商', value: 'Lead shan county qixie century trading co., ltd', enabled: true, kind: 'text', help: '目标账号中已维护的制造商。' },
    { id: 'physicalLabel', group: '模板与资质', label: '纺织品实物标签', value: 'assets/physical-label.png', enabled: true, kind: 'text', help: '扩展内图片资源路径；替换图片文件后重载扩展即可。' },
    { id: 'materialRatio', group: '成分信息', label: '棉质成分比例(%)', value: '100', enabled: true, kind: 'number', help: '检测到 COTTON 后，自动移除其他已选材质并设置此比例。' },
    { id: 'euFiberComposition', group: '成分信息', label: '欧盟纺织纤维成分', value: '100% cotton', enabled: true, kind: 'text', help: '将填写到欧盟纺织纤维成分字段。' },
    { id: 'price', group: '价格与库存', label: '零售价(CNY)', value: '85', enabled: true, kind: 'number', help: '批量填写到所有 SKU。' },
    { id: 'cargoValue', group: '价格与库存', label: '货值(CNY)', value: '45', enabled: true, kind: 'number', help: '批量填写到所有 SKU。' },
    { id: 'inventory', group: '价格与库存', label: '库存', value: '999', enabled: true, kind: 'number', help: '批量填写到所有 SKU。' },
    { id: 'skuWeight', group: '包裹与物流', label: 'SKU重量(kg)', value: '0.22', enabled: true, kind: 'number', help: '每个 SKU 的重量。' },
    { id: 'skuDimensions', group: '包裹与物流', label: 'SKU尺寸(cm)', value: '20|20|2', enabled: true, kind: 'text', help: '长|宽|高。' },
    { id: 'packageWeight', group: '包裹与物流', label: '包装后重量(kg)', value: '0.22', enabled: true, kind: 'number', help: '包装与物流区域的重量。' },
    { id: 'packageDimensions', group: '包裹与物流', label: '包装后尺寸(cm)', value: '15|15|2', enabled: true, kind: 'text', help: '长|宽|高。' },
  ],
};

export function cloneAliExpressAutoFillDefaults(): AliExpressAutoFillConfig {
  return structuredClone(ALIEXPRESS_AUTO_FILL_DEFAULTS);
}
