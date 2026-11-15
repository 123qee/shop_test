import type { AiTitleMaterial } from '@shared/types';

/**
 * Joom 标题系统提示：固定护栏，不让用户改掉合规底线。
 * 面料差异走 TITLE_MATERIAL_PRESETS（可在设置页改）。
 */
export const TITLE_SYSTEM_PROMPT = `You are a listing copywriter for the Joom marketplace (European / CIS / LATAM shoppers).
Rewrite the source title so it ranks in Joom search and can pass merchant review.

Hard rules:
- English only. Translate Chinese or mixed titles.
- 60–120 characters. Never exceed 150.
- Pattern: [Audience/Gender] + [Material] + [Product Type] + [Style/Fit] + [1–2 real features]
- Use only facts in the source title, brand, attributes, or variant hints, plus the material the merchant selected.
- Do NOT list colors, sizes, SKUs, package counts, or year numbers. Those belong to variants.
- No promo / spam: free shipping, hot sale, best seller, dropshipping, wholesale, cheap, factory, OEM, AliExpress, new 2024/2025, limited time.
- No emoji, ALL CAPS, HTML, trademarked brands you did not receive, or supplier jargon.
- Prefer shoppable nouns buyers actually type: t-shirt, tee, polo, hoodie, sweatshirt, tank top.

Also generate 6–10 hidden Joom search tags:
- lowercase English, complementary to the title (do not repeat the full title)
- include common synonyms and category words
- no promo words, no duplicates

Return STRICT JSON only:
{"title":"...","tags":["..."]}`;

export const TITLE_MATERIAL_PRESETS: Array<{
  id: AiTitleMaterial;
  name: string;
  hint: string;
  prompt: string;
}> = [
  {
    id: 'cotton',
    name: '棉',
    hint: '棉质 T 恤 / 卫衣，强调柔软透气',
    prompt: `This listing is COTTON (棉). The material word in the title MUST be cotton.
Lead with gender/audience + cotton + product type, then add fit, neckline, sleeve or season only if they appear in the source.
Use high-intent Joom search terms: cotton t-shirt, cotton tee, soft cotton, breathable cotton, casual cotton top.
Do NOT write polyester, moisture-wicking, quick-dry, athletic performance, or "100%" unless the source already says 100% cotton.
Do not invent organic / combed / ring-spun unless the source says so.
Example: "Men's Cotton T-Shirt Casual Short Sleeve Crew Neck Summer Tee"`,
  },
  {
    id: 'polyester',
    name: '聚酯纤维',
    hint: '聚酯 T 恤 / 运动款，强调速干亲肤',
    prompt: `This listing is POLYESTER (聚酯纤维). The material word in the title MUST be polyester.
Lead with gender/audience + polyester + product type, then add fit, neckline, sleeve or season only if they appear in the source.
Use high-intent Joom search terms: polyester t-shirt, polyester tee, moisture wicking tee, quick dry t-shirt, athletic casual top.
Do NOT write cotton, 100% cotton, or natural fiber.
Do not invent UV protection, anti-odor or compression unless the source says so.
Example: "Men's Polyester T-Shirt Moisture Wicking Short Sleeve Athletic Tee"`,
  },
];

export function defaultPromptFor(id: AiTitleMaterial): string {
  return TITLE_MATERIAL_PRESETS.find((p) => p.id === id)?.prompt ?? TITLE_MATERIAL_PRESETS[0].prompt;
}
