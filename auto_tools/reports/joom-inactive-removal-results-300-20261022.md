# Joom 非活性商品删除结果（300 款）

- 筛选口径：远端快照仍存在（`present=true`）、Joom 状态为限售/拒绝（`state=rejected`）、无在售版本（`hasActiveVersion=false`）。
- 删除范围：蒋卫华一店 300 款；Joom 商品 ID 均唯一。
- 预删除同步时间：`2026-10-22T11:59:38.922Z`。
- 执行接口：`POST /api/products/batch/remove-remote`。
- 删除原因：`stopSelling`（停止销售）。
- 接口结果：300/300 成功；分两批执行，分别为 200/200、100/100。
- 本地关联记录：239 条移入可恢复废弃箱并清空 Joom ID；61 条远端商品没有本地记录。
- 删除后同步核验：300/300 均为 `present=false`、`state=notFound`、`hasActiveVersion=false`；同步时间 `2026-10-22T12:13:05.882Z`。
- Joom 后台计数：全部商品 `5,010 → 4,710`；限售 `2,117 → 1,817`；在售保持 `2,892` 不变。
- 候选清单：`reports/joom-inactive-removal-candidates-300-20261022.csv`（含 300 个商品链接、商品 ID、店铺、状态、问题详情）。
- 逐条结果：`reports/joom-inactive-removal-results-300-20261022.csv`。
- 后台截图：`reports/joom-inactive-removal-proof-300-20261022.png`。
- 删除前本地数据库备份：`server/data/app.db.before-joom-inactive-removal-300-20261022.sqlite`。

说明：Joom 的库存字段表示 SKU 库存，不等同于“正在售卖”。本次以 Joom 后台“在售版本=否”及 API 的 `hasActiveVersion=false` 作为无在售版本的硬性判定，未删除任何有在售版本的商品。
