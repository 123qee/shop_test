# Amazon.de 童装无拉链连帽卫衣采集进度

## 筛选规则

- 目标：新增 100 款不同商品，来源为 Amazon.de。
- 标准沿用项目中的“童装无拉链连帽卫衣”规则：童装、有连帽、前襟无拉链、无口袋；详情或商品图能确认特征后才采集。
- 按 Amazon ASIN 去重。每轮记录已核查、已入库和排除商品。
- 采集模板：优先使用“童装连帽卫衣无拉链”；需依据商品实际材质选棉或聚酯纤维模板。材质不符或不明时保持“不指定”。

## 当前进度

- 已入库：2/100。
- 已核查：10 款；明确排除 7 款，另有 1 款因口袋情况未确认而暂缓。
- 2026-11-12：核查 XCXC Children's Hoodie Boys Long Sleeve Hoodie Girls Sweatshirt（ASIN `B0H8Q6BXJF`）。详情明确标注“without zip”，有连帽并提供 1–15 岁尺码；详情同时写明有袋鼠口袋，按项目无口袋标准排除。
- 2026-11-12：核查 Haloumoning Boys' Hoodie, Long-Sleeved Plain Hoodie, Children's Regular Fit Basic Hooded Sweatshirt（Amazon.de 商品页 ASIN `B0FDB1KSVS`）。页面标注 `Pull On`、80% Polyester/20% Cotton；标题、详情和商品图均未显示口袋。通过 auto_tools Chrome 插件按 ASIN `B0FDB1KSVS` 入库，模板选“童装连帽卫衣无拉链polyster”。
- 2026-11-12：核查 Amazon Essentials Boys Breathable Relaxed Fit Hooded Pullover（ASIN `B0FL62RTK2`）和 Spring&Gege Boys' Hooded Pullover（ASIN `B0CG61YX4F`）。两款均为套头但详情明确写有 kangaroo/pouch pocket，排除，未采集。
- 2026-11-12：核查 JACK & JONES Junior Plain Hoodie Boys（搜索结果 ASIN `B0C36TV25Y`）和 Printed Hoodie Boys（搜索结果 ASIN `B0F43TN7NG`）。详情均标注 `Pull On`，但也明确写有 kangaroo pocket，排除，未采集。
- 2026-11-12：核查 JACK & JONES Logo Hoodie Boys（搜索结果 ASIN `B0FWL4J4NK`）。详情标注 `Pull On` 和 Junior/Boys 尺码，但明确写有 kangaroo pocket，排除，未采集。
- 2026-11-12：核查 TupTam Unisex Hoodie Boys Girls Hoodie Sweatshirt Organic Cotton（搜索结果 ASIN `B0FPMGBGK7`）。详情标注 `Pull-on`、95% 棉/5% 氨纶，但明确写有前袋，排除，未采集。
- 2026-11-12：核查 adidas Unisex Kids Entrada26 Kids Hoodie（页面 ASIN `B0F3JHM7XH`）。详情标注 `Pull On`、童装尺码和 70% 棉/30% 聚酯纤维；本轮没有完成口袋图片确认，暂缓，不计入。
- 2026-11-12：核查 Jako One Cotton Hooded Sweatshirt for Children（商品页路径 ASIN `B0G259RFLD`，详情变体 ASIN `B0GDMD3NYL`）。详情明确写有 patch pocket，排除，未采集。
- 2026-11-12：核查 Ragwear Madlenka Girls' Sweatshirt Sweater Pullover with Hood（商品页路径 ASIN `B09ZQ7CZG5`，详情变体 ASIN `B0CVHZBJ6D`）。商品图正面无口袋/拉链，尺码 122–152、`Pull On`；通过 auto_tools Chrome 插件采集，模板选“童装连帽卫衣无拉链棉”。材质信息存在 65/35 与 60/40 棉涤两种表述，但均为棉占多数。
- 当前状态：Amazon.de 搜索结果混有成人、拉链款、非连帽款、重复变体；必须逐条开详情核查，不可直接整页采集。最近搜索词为 `Kinder Kapuzenpullover ohne Tasche`。

## 续采方式

优先从 Amazon.de 童装连帽卫衣搜索结果逐条检查详情和图片。当前 Chrome 已确认注入 auto_tools 自有采集插件，后端 `localhost:8787` 已启动。确认符合全部特征后，用项目插件采集当前商品；入库后按 ASIN 去重并更新本记录。不符合的只记录排除原因。
