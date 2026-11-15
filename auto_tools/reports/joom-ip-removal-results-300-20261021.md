# Joom 侵权商品删除结果

- 清单：`/Users/didi/Desktop/auto_tools/reports/joom-ip-removal-candidates-300-20261021.csv`
- 结果清单：`/Users/didi/Desktop/auto_tools/reports/joom-ip-removal-results-300-20261021.csv`
- 执行接口：`POST /api/products/batch/remove-remote`
- 删除原因：`legalRequirement`（法规要求）
- API 结果：300/300 成功；分批结果为 6/6、94/94、72/72、128/128。
- 本地关联记录：222 条移入可恢复废弃箱并清空 Joom ID；78 个远程 ID 没有本地记录。
- 最新只读同步核验：300/300 均为 `present=false`、`state=notFound`、`hasActiveVersion=false`；同步时间 `2026-10-21T14:52:36.667Z`。
- 店铺分布：蒋卫华一店 21 件；蒋卫华二店 190 件；蒋红一店 89 件。
- 原始理由代码：J1451 294 件；J1321 3 件；J1326 1 件；J1173 2 件。
