import type { CollectedProduct, GroupTemplateBinding, ProductGroupId, ProductGrouping, ProductMaterial } from './types';

export const PRODUCT_GROUPS: Array<{ id: ProductGroupId; label: string }> = [
  { id: 'men-short', label: '男装短袖' }, { id: 'women-short', label: '女装短袖' },
  { id: 'kids-short', label: '童装短袖' }, { id: 'short', label: '短袖 · 人群待判断' },
  { id: 'men-sweat', label: '男装卫衣' }, { id: 'women-sweat', label: '女装卫衣' },
  { id: 'kids-sweat', label: '童装卫衣' }, { id: 'sweat', label: '卫衣 · 人群待判断' },
  { id: 'men-top', label: '男装其他上衣' }, { id: 'women-top', label: '女装其他上衣' },
  { id: 'kids-top', label: '童装其他上衣' }, { id: 'top', label: '上衣 · 人群待判断' },
  { id: 'pants', label: '裤装' }, { id: 'dress', label: '裙装' },
  { id: 'shoes', label: '鞋类' }, { id: 'home', label: '家居' },
  { id: 'other', label: '其他商品' }, { id: 'pending', label: '待判断' },
];
export const PRODUCT_MATERIALS: Array<{ id: ProductMaterial; label: string }> = [
  { id: 'polyester', label: '聚酯纤维' }, { id: 'cotton', label: '棉' },
  { id: 'blend', label: '混纺' }, { id: 'other', label: '其他材质' },
  { id: 'unknown', label: '材质未知' },
];
export const groupLabel = (id: ProductGroupId) => PRODUCT_GROUPS.find((g) => g.id === id)?.label ?? '待判断';
export const materialLabel = (id: ProductMaterial) => PRODUCT_MATERIALS.find((m) => m.id === id)?.label ?? '材质未知';
export const isProductGroup = (value: unknown): value is ProductGroupId => PRODUCT_GROUPS.some((g) => g.id === value);
export const isProductMaterial = (value: unknown): value is ProductMaterial => PRODUCT_MATERIALS.some((m) => m.id === value);

function normalized(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function attributeText(product: CollectedProduct, keys: RegExp) {
  return Object.entries(product.attributes ?? {}).filter(([key]) => keys.test(normalized(key)))
    .map(([, value]) => value).join(' ');
}

type Audience = 'men' | 'women' | 'kids' | '';
function audienceFrom(text: string): Audience {
  if (/童装|儿童|婴儿|男童|女童|\b(kids?|children|child|boys?|girls?|baby|babies|junior|ninos?|ninas?|infantil)\b|детск|мальчик|девоч|ребен/iu.test(text)) return 'kids';
  if (/中性|男女通用|男女同款|\bunisex\b|унисекс/iu.test(text)) return '';
  const men = /男装|男士|男性|\b(men|mens|man|male|hombres?|masculino)\b|мужск/iu.test(text);
  const women = /女装|女士|女性|\b(women|womens|woman|female|ladies|mujeres?|femenino)\b|женск/iu.test(text);
  return men === women ? '' : men ? 'men' : 'women';
}

/** 卫衣关键词；模板核对在标题含多种商品类型（如卫衣套装）时也要用到。 */
export const SWEAT_PATTERN = /卫衣|连帽衫|\b(hoodies?|sweatshirts?|sudaderas?)\b|толстовк|худи|свитшот/iu;

type Kind = 'short' | 'sweat' | 'top' | 'pants' | 'dress' | 'shoes' | 'home' | 'other';
function kindFrom(text: string): { kind?: Kind; conflict: boolean } {
  const kinds: Kind[] = [];
  const sweat = SWEAT_PATTERN.test(text);
  const top = /短袖|长袖|t恤|衬衫|上衣|毛衣|针织衫|\b(t[\s-]?shirts?|tees?|shirts?|blouses?|sweaters?|camisetas?|camisas?|remeras?|playeras?|poleras?|tops?)\b|футболк|рубашк|блуз|свитер/iu.test(text);
  const short = /短袖|t恤|\b(short[\s-]?sleeve[ds]?|manga\s+corta|t[\s-]?shirts?|tees?|camisetas?|remeras?|playeras?|poleras?)\b|футболк|коротк.{0,12}рукав/iu.test(text);
  const long = /长袖|\blong[\s-]?sleeve[ds]?\b|manga\s+larga|длинн.{0,12}рукав/iu.test(text);
  if (sweat) kinds.push('sweat');
  else if (top || short || long) kinds.push(short && !long ? 'short' : 'top');
  if (/裤|\b(pants?|trousers?|jeans|leggings?|shorts|pantalones?|bermudas?)\b|брюк|штаны|джинс|шорты/iu.test(text)) kinds.push('pants');
  if (/连衣裙|半身裙|裙子|\b(dresses|dress|skirts?|vestidos?|faldas?)\b|плать|юбк/iu.test(text)) kinds.push('dress');
  if (/鞋|靴|\b(shoes?|sneakers?|boots?|sandals?|slippers?|zapatos?|zapatillas?|calzado)\b|обув|кроссов|ботин|сандал/iu.test(text)) kinds.push('shoes');
  if (/床单|床品|枕套|窗帘|地毯|毛巾|\b(bedding|pillowcases?|curtains?|rugs?|towels?|sabanas?|cortinas?)\b|постель|наволоч|штор|полотен/iu.test(text)) kinds.push('home');
  if (!kinds.length && /背包|手提包|项链|耳环|手机壳|\b(backpacks?|handbags?|necklaces?|earrings?|phone\s+cases?|mochilas?)\b/iu.test(text)) kinds.push('other');
  return { kind: kinds.length === 1 ? kinds[0] : undefined, conflict: kinds.length > 1 };
}

function materialFrom(text: string): ProductMaterial {
  // 营销用语、否定材质不作为材质证据。
  const clean = text.replace(/\b(?:not|no|non)[\s-]+(?:cotton|polyester)\b|仿棉|非纯棉|非棉|棉感|cotton[\s-]+(?:look|feel)/giu, '');
  const cotton = /纯棉|棉质|棉布|棉纤维|全棉|棉短袖|棉t恤|棉衫|\d\s*%\s*棉|棉(?=\s|[;:：,，、\d]|$)|\bcotton\b|\balgodon\b|хлопок|хлопк/iu.test(clean);
  const polyester = /聚酯|涤纶|\bpolyester\b|\bpoliester\b|полиэстер/iu.test(clean);
  const other = /尼龙|锦纶|氨纶|粘胶|羊毛|亚麻|真丝|皮革|\b(nylon|spandex|elastane|viscose|wool|linen|silk|leather|acrylic)\b|шерст|нейлон|эластан|вискоз/iu.test(clean);
  if (/混纺|\b(blend|blended|mezcla)\b|смесов/iu.test(clean) || [cotton, polyester, other].filter(Boolean).length > 1) return 'blend';
  if (cotton) return 'cotton';
  if (polyester) return 'polyester';
  if (other) return 'other';
  return 'unknown';
}

/** 从任意文本（材质属性、标题）判断材质，规则与采集分组一致。 */
export function inferMaterialFromText(text: string): ProductMaterial {
  return materialFrom(normalized(text ?? ''));
}

/** 仅使用来源信息，不读取 editable 或预设。 */
export function inferProductGrouping(product: CollectedProduct): ProductGrouping {
  const title = normalized(product.title ?? '');
  const category = normalized(attributeText(product, /品类|类目|类别|产品类型|商品类型|^类型$|category|product.?type|тип.*товар|категор/iu));
  const gender = normalized(attributeText(product, /性别|适用人群|适用对象|gender|sex|audience|genero|^пол$|возраст/iu));
  const fabric = normalized(attributeText(product, /材质|面料|材料|成分|material|fabric|composition|composicion|состав|материал/iu));
  const attrKind = kindFrom(category);
  const titleKind = kindFrom(title);
  let picked = category && (attrKind.kind || attrKind.conflict) ? attrKind : titleKind;
  let evidence = picked === attrKind ? '原商品类别属性' : '原商品标题';
  if (!picked.kind && !picked.conflict && product.description) {
    picked = kindFrom(normalized(product.description));
    evidence = '原商品描述';
  }
  // 人群冲突保留未知；属性明确时优先采用属性。
  const audience = gender ? audienceFrom(gender) : audienceFrom(`${category} ${title}`);
  let groupId: ProductGroupId = 'pending';
  if (picked.kind) {
    groupId = (['short', 'sweat', 'top'].includes(picked.kind) && audience
      ? `${audience}-${picked.kind}` : picked.kind) as ProductGroupId;
  }
  let material = materialFrom(fabric || title);
  // 材质属性存在但无法识别时，不能被标题中营销词覆盖。
  if (!fabric && material === 'unknown' && product.description) {
    const lines = normalized(product.description).split(/[\n;]/).filter((line) =>
      /材质|面料|成分|material|fabric|composition|composicion|состав|материал/iu.test(line));
    material = materialFrom(lines.join(' '));
  }
  return {
    groupId, material, source: 'auto',
    reason: picked.conflict ? `${evidence}包含多种商品类型，请确认` : picked.kind ? `根据${evidence}分组；材质依据原商品信息` : '原商品信息不足，请手动确认分组',
  };
}

export function findGroupTemplateBinding(bindings: GroupTemplateBinding[], groupId: ProductGroupId | 'all', material: ProductMaterial | 'all') {
  if (groupId === 'all' || groupId === 'pending' || material === 'unknown') return undefined;
  return bindings.find((b) => b.groupId === groupId && b.material === material)
    ?? bindings.find((b) => b.groupId === groupId && b.material === 'all');
}
