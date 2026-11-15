# Joom API 文档入口

- API 文档入口：https://merchant.joom.com/docs/api
- API v3 文档：https://merchant.joom.com/docs/api/v3
- 获取单个商品：https://merchant.joom.com/docs/api/v3/operations/products
- 获取商品列表：https://merchant.joom.com/docs/api/v3/operations/products-multi

## 审核状态与原因

商品同步使用 `GET /products` 或 `GET /products/multi`。Joom 的 `state` 表示当前版本状态，`hasActiveVersion` 表示是否仍有审核通过、对客可见的版本。

审核问题优先读取响应中的 `review.reasons`（当前推荐结构），兼容读取 `review.infractions`。原因会写入本地商品记录，列表支持展开查看标题、说明、字段、变体 SKU 和错误代码。
