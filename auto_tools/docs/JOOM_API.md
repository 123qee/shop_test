# Joom API 文档入口

- API 文档入口：https://merchant.joom.com/docs/api
- API v3 文档：https://merchant.joom.com/docs/api/v3
- 获取单个商品：https://merchant.joom.com/docs/api/v3/operations/products
- 获取商品列表：https://merchant.joom.com/docs/api/v3/operations/products-multi

## 审核状态与原因

商品同步使用 `GET /products` 或 `GET /products/multi`。Joom 的 `state` 表示当前版本状态，`hasActiveVersion` 表示是否仍有审核通过、对客可见的版本。

审核问题优先读取响应中的 `review.reasons`（当前推荐结构），兼容读取 `review.infractions`。原因会写入本地商品记录，列表支持展开查看标题、说明、字段、变体 SKU 和错误代码。

## 工作台接口的目标店铺

通过脚本调用本地工作台时，可从 `GET /api/shops` 读取店铺档案。向 Joom 提交后台发布、直接发布、同步批量修改、修复重复变体或删除线上商品时，请在请求体传入操作者确认的档案 `shopId`。例如，向 `POST /api/products/publish-jobs` 提交 `{"ids":["本地商品ID"],"shopId":"店铺档案ID"}`。

缺少目标店铺时，接口返回 400。确认后如果其他标签已切换当前店铺，接口返回 409，请重新确认。已入队的任务会继续使用提交时的店铺。

提交过程中重启、收到商品已存在或未收到明确回执时，任务会进入 `needs_review`。进入原店铺的「发布清单」，点击「核对原店线上结果」。新刊登唯一匹配后会关联本地商品。对于已存在的刊登，核对提交的修改确实生效后可点击「已确认更新生效」。未找到匹配时可以手动重试。

脚本可向 `POST /api/products/publish-jobs/:jobId/items/:productId/reconcile` 传入 `{"shopId":"店铺档案ID","action":"check"}`。接口读取原店铺的刊登并返回更新的任务与核对说明。
