# George 童装短袖采集进度

这份文档是 George 童装短袖采集的续采记录。每次采集后更新“当前断点”和“采集日志”，下次从断点后的商品继续；重复商品不计作新增款。

## 当前断点

- 最近采集时间：2026-11-12 08:47（中国时间）
- 来源：George at ASDA
- 当前列表：Boys Tops & T-Shirts
- 筛选：Sleeve Length = Short Sleeve；排序 New In。列表仍可能混入袖长不符商品，须按入库详情复核。
- 页面状态：男童短袖筛选仍会混入标题带 `Long Sleeve` 的商品，不能只凭筛选结果认定商品是短袖。女童 T 恤列表也应逐条按标题或商品描述复核袖长。
- 已检查到的位置：本批处理到 `NW2 Dinosaur Let's Rock Black Printed T-Shirt`（SKU `GEM1355001`）。童装短袖 100 款目标已完成；若继续采集其他短袖，接着检查当前 Boys Tops & T-Shirts 的下一张未处理卡片，或切换其他童装上衣分类。
- 扩展预设：不指定（当前列表存在不同袖长/款式，避免整页套用错误模板）。

## 达成 100 款（2026-11-12）

- 本批开始时：George 来源 228 条；任务基线仍为 `2026-11-11T14:28:21.786Z`。
- 本批新增 47 条；当前 George 来源共 275 条。按商品详情描述确认，本批累计新增 47 条明确短袖；加上此前已确认的 53 条，目标达到 100/100。
- 本批新增记录的 `collected.images` 均非空（空数组 0 条）；后台详情中的袖长描述均确认短袖。图片字段非空表示有图片 URL，不等同于逐个远端地址都已验证可访问。
- 采集过程先按页面卡片图片和商品编号筛候选，再用数据库 `sourceProductId` 去重；扩展按钮的“可采集”状态会包含旧记录，不能据此计为新增。对本批中按钮未完成的商品没有计数；图片未加载的卡片也跳过。
- 本批新增中包含男童基础短袖、多件装、图案 T 恤和短袖 Polo/球衣；例如 `Ape Skateboard Zip Neck Polo Tops 2 Pack`、`Minecraft T-Shirt 2 Pack`、`Short Sleeve T-shirts` 多件装、Peppa Pig / Spider-Man / Moana / ACDC 等图案款。具体款数以数据库新增记录为准。
- 本批结束时按任务基线统计：新增 103 条，其中 100 条描述明确为短袖，另外 3 条未通过短袖描述判定；图片数组为空 0 条。George 来源总数 275 条。

## 本轮结果（2026-11-11）

- 处理了 100 个商品卡片；另对 3 个可见卡片做了重复状态确认。
- 后台 George 商品总数：172。
- 本轮新增记录：13 条；其中 3 条描述明确为短袖，10 条标题为长袖。
- 本轮新增的短袖记录均有图片 URL：Minecraft Christmas Green Print T-Shirt（2 张）、K-Pop Demon Hunters Mira Charcoal Graphic T-Shirt（2 张）、Pokémon T-Shirt 2 Pack（3 张）。
- 其余大部分选择被扩展标记为“之前采过”，没有覆盖旧记录。
- 数据库中 George 来源的 172 条记录均有非空图片数组；这只检查了图片字段数量，没有逐条验证远端图片 URL 是否可访问或后台预览是否能渲染。

## 续采批次（2026-11-11）

- 本批基线：George 来源 172 条；起始时间 `2026-11-11T14:28:21.786Z`。
- 后台新增 55 条，当前 George 来源共 227 条；其中 52 条描述明确包含 `Short sleeve` / `Short-Sleeved`，3 条未通过该描述判定为短袖（含明确长袖），所以本轮 100 款目标目前按描述确认数记为 52/100。
- 本批新增记录图片数组为空：0 条；均有至少 1 张图片 URL。仍未逐张验证远程 URL 可访问性。
- 对更多卡片的尝试大多命中已有记录；按标题复核，这页并非所有短袖候选都未采集。也发现排序为 Recommended 时长袖仍混入 Short Sleeve 筛选列表；New In 排序已选中，待下次继续加载并核验。
- 本批已核对新增中有 3 张图片的商品包括 NW2 Transformers Optimus Prime、NW2 Transformers Autobot Leader、NW2 Nerf Always Ready、NW2 Hoppers Apex Predator；Umbro Club Jersey 有 4 张。数据库以 `collected.images` 实际数组长度为准。
- 本批尝试的多款男童热门图案款和女童 New In 款（包括 NW2 Disney Hexed、Tiny Tomato、Cross Stitch、Birthday Girl、Daddy’s Bestie 等）经后台去重后未新增；其中有些页面按钮仍显示可采集，不能把按钮状态当作新入库确认。
- 当前全库 George 记录中有 153 条描述明确为短袖；本轮新增且明确短袖为 22 条。若目标要求再新增 100 条，需要继续扩大到其他童装短袖分类并逐条按后台新增/袖长/图片核算。
- 后续婴童分类新增：Baby Boys' Tops 的 Ribbed T-shirts 组合（Striped Ribbed、Blue Ribbed、Pastel Ribbed）均为短袖且各有 2 张图；Baby Girls' Tops 新增 Pastel Fruit Print（2 张图）、Rainbow Flower Lettuce Edge（3 张图）、Lettuce Edge Ribbed（2 张图），描述均确认短袖。
- 后续女童分类新增授权/图案款及校服短袖，例如 Disney Stitch Halloween Pumpkin（2 张）、NW2 David Bowie / K-Pop birthday / My Little Pony / Lilo & Stitch 款（各 3 张），以及 White Crew Neck School T-Shirts 5 Pack（4 张）。具体统计以后台 description 和 images 字段为准。
- 当前新增 55 条里有 52 条明确短袖、3 条未通过袖长描述判定；空图片数组 0 条。
- 最近一次浏览时浏览器扩展连接中断。恢复连接后从上方当前断点继续；以数据库新增记录为进度，不以页面按钮状态计数。

## 续采注意事项

1. 先检查页面 Length 筛选确实为 Short Sleeve，再看实际商品卡片；当前页面曾在短袖筛选下仍显示长袖商品。
2. 每次先看扩展的单品状态。显示“已采集/之前采过”的 SKU 跳过，不把它算作新增。
3. 记录批次尝试数、扩展报告的重复数、数据库新增数，并分别统计短袖、长袖和图片数量；目标“100 款”按 100 个新增且确认短袖的 SKU 计算。
4. 对新增记录检查 `collected.images` 数组至少有一张图。图片数组非空不等同于远端 URL 可访问；若后台仍显示“无图”，需检查该商品的图片 URL 加载/渲染情况，不能仅重复采集同一 SKU。
5. 更新本页“当前断点”和“本轮结果”，保留历史日志，方便跨会话续采。
