# auto_tools — Joom / Mercado Libre 跨境商品工作台

Joom API v3 官方文档：<https://merchant.joom.com/docs/api/v3>（入口页：<https://merchant.joom.com/docs/api>）。
图片上传使用 PICUI API：<https://picui.cn/page/api-docs.html>。
审核状态以 `GET /products` 返回的 `state`、`hasActiveVersion` 和 `review.reasons` / `review.infractions` 为准；同步时会保留审核原因明细，方便在商品列表回看。

把在 AliExpress、Allegro、ASOS、George at ASDA、Joom、Mercado Libre 等平台看到的商品一键采集到母库，再分别进入 Joom 或 Mercado Libre 工作区编辑和发布。采集母库只保存来源、公共素材和原始数据；两个平台的商品字段、模板、状态、OAuth 和发布接口相互独立。

商品详情页存在视频时，插件会一并采集视频直链，后端立即尝试缓存主视频，避免来源链接过期。发布到 Joom 时，商品先正常创建/更新，视频随后通过 Joom 的分片上传接口独立处理；审核通过后自动关联商品。每件 Joom 商品最多关联一个视频，且店铺必须先向 Joom 申请开通商品视频权限。

## 子项目

| 目录 | 说明 | 技术栈 |
| --- | --- | --- |
| `extension/` | 采集插件:在来源平台页面注入采集按钮,提取商品数据并上报后端 | Chrome MV3 · Vite · TS |
| `server/` | 后端服务:存储、Joom 与 Mercado Libre 独立模块、发布接口 | Express · SQLite · TS |
| `web/` | 网页后台:采集母库、Joom 工作区、Mercado Libre 工作区 | Vite · React · TS |
| `shared/` | 三方共用的数据类型、分组与校验规则 | TS |

## 个人项目与任务

- 菜单「个人管理 → 项目」（`/projects`）：默认紧凑表格，顶部一行搜索、分类/状态筛选、排序、视图和新建。表格内可直接切换状态、星标、编辑或归档；也可切换卡片视图。进度只计算一次性任务，重复日常单独显示；项目详情集中管理所属任务。
- 菜单「个人管理 → 任务」（`/tasks`）：默认直接进入待办、进行中、等待中、已完成四列看板。顶部一行提供搜索、今日/未来 7 天、筛选、列表切换与新建；重复日常、完成和归档范围收在筛选中。卡片可点击编辑、拖动换列，列标题旁可直接新建；列表模式支持快速添加。
- 新建和编辑任务使用居中弹窗，标题与描述直接填写，底部设置状态、优先级、项目、日期和重复频率，子步骤按需展开；支持放大和 `⌘/Ctrl + Enter` 保存。
- 重复任务支持每天、工作日和每周。打卡后安排下一次日期，跳过漏做的日期，重置子步骤；累计打卡次数可在任务详情查看。同一执行日期不会重复记账。
- 项目完成率只计算一次性任务；重复日常单独统计。归档项目会从全局任务中隐藏，恢复后继续使用，任务内容会保留。
- 数据通过 `/api/planner` 存入 SQLite 的 `personal_projects`、`personal_tasks`、`personal_task_completions` 表，独立于商品和发布队列。日期按中国时区的自然日处理；未设置消息或系统通知。

## 可扩展设计(三个插拔点)

1. **采集端 Extractor 注册表**(`extension/src/extractors`):加来源平台 = 新增一个 extractor 并注册。
2. **发布端 Marketplace Adapter**(`server/src/marketplaces`):加目标平台 = 新增一个 adapter。
3. **Transform 处理管线**(`server/src/transforms`):加功能(翻译/加价/类目映射…)= 往管线加一个 step。

## 快速开始

```bash
# 推荐：一键启动后台、固定 ngrok 隧道和本地浏览器
./start.sh

# 修改 web 代码后，强制重新构建再启动
./start.sh --build-web

# 1) 后端
cd server && npm install && npm run dev      # http://localhost:8787

# 2) 网页后台
cd web && npm install && npm run dev         # http://localhost:5173

# 3) 采集插件
cd extension && npm install && npm run build # 然后在 chrome://extensions 加载 extension/dist
```

批量采集支持在不同浏览器标签页或窗口同时运行，最多 6 个任务。每个页面一次运行一个任务；页面里的「停止」只会停止该页面发起的采集。关闭来源页面也会停止对应任务。

George 童装短袖的采集断点、重复/新增统计和续采规则记录在 [采集进度文档](docs/george-kids-short-sleeve-collection-progress.md)，每轮采集后更新，方便下次接着处理。

正常采集商品时会自动提取详情页视频并保存到本地商品记录；视频补采底层能力仍保留用于数据维护，但不再在扩展页面展示临时补采入口。

`start.sh` 默认会执行 `ngrok http 8787 --url https://java-suburb-kettle.ngrok-free.dev`。
如果你的固定域名不同，可以这样启动：

```bash
NGROK_URL=https://你的固定域名.ngrok-free.dev ./start.sh
```

如需暂时只启动本地后台：

```bash
NGROK_ENABLED=0 ./start.sh
```

首次使用前需要确认 `ngrok` 已安装、已配置 authtoken，并且固定域名属于当前 ngrok 账号。

详细流程见各子目录 README 与根目录计划文档。

## Mercado Libre 工作区

- 入口：`/mercadolibre`；设置：`/mercadolibre/settings`；回调：`/api/mercadolibre/callback`。
- 首批站点：MLC、MLM、MCO。每个站点是独立草稿，可独立校验、发布、暂停、恢复和同步。
- 服务端会在授权后读取卖家标签，识别 User Products / Global Items / Fully Managed 模型；App Secret 只保存在服务端，网页只显示脱敏状态。
- 类目属性通过美客多 API 动态读取；图片会上传到美客多并缓存本地图片到远端图片 ID 的映射。
- 本地使用时，Redirect URI 与通知回调都应填写固定的 HTTPS 隧道地址，例如 `https://你的固定域名.ngrok-free.dev/api/mercadolibre/callback` 和 `https://你的固定域名.ngrok-free.dev/api/mercadolibre/notifications`。

建议先完成：设置 App ID / Secret → 授权卖家 → 从采集母库创建站点草稿 → 填写类目并加载属性 → 逐站校验和发布。

## 本地图片上传

商品编辑器的「按颜色批量添加」支持选择本地图片，后端会将图片上传到 PICUI，并把返回的公网 URL 写入新变体，供 Joom 拉取。PICUI 未配置 token 时会按游客上传；建议登录 PICUI 个人中心创建 token，再到后台「设置 → 图片图床（PICUI）」填写。服务端环境变量也支持作为备用配置：

```dotenv
PICUI_BASE_URL=https://picui.cn/api/v1
PICUI_TOKEN=替换为你的PICUI_TOKEN
```

token 只在服务端使用，不会下发到浏览器。PICUI 单张图片上限为 20 MB，图片需设置为公开权限，才能被 Joom 访问。

## 已发布商品更新

编辑器对已有 `joomProductId` 的商品会调用 Joom API v3 的
`POST /products/update`，而不是再次创建商品；通过商品 id 定位，提交名称、图片、描述、类目属性、`dangerInfo`、价格、库存和变体等修改。
Joom 的更新接口是 PATCH-like：未提交字段不会改变。商品 SKU 是定位键，已发布商品编辑器会锁定商品 SKU。
删除变体需要单独调用 Joom 的 `POST /products/removeVariations`，这是不可恢复操作，当前编辑器不会自动删除远端变体。

从 Joom 删除整件商品走 `POST /products/remove`（query 用 `id` 或 `sku`，body 带 `reason`: `stopSelling` / `legalRequirement`）。列表可批量删除已发布商品，也可对 ID 检索未命中的 Joom ID 直接删除；成功后默认把本地记录移入废弃箱。此操作不可恢复，不要用于临时下架。

## 运营工作台能力

- 采集自动分组：按原商品属性、标题和描述判断人群、款式与材质；缺失或冲突信息保留待判断。旧商品自动兼容，人工纠正结果会保存。
- Joom 商品列表：选择分组和材质 → 全选当前组（支持跨页）→ 点击快捷预设批量套用；采集默认模板与“已确认预设”分开记录。类型或材质改变后重新待确认。
- 每个明确分组可按材质绑定常用预设，后续一键套用本组待确认商品；材质未知时由用户确认。待确认视图处理完当前组后会转到下一组，失败商品留在当前组。
- 采集母库支持分组/材质筛选，并可直接进入对应组的 Joom 预设处理列表。
- 采集时定模板：插件采集栏的「预设」默认「不指定」。整页同一类时选好模板，入库时按尺码、标题核对，没有矛盾直接算已确认；有矛盾或没选的进入待确认，并由系统推荐模板。核对和推荐规则集中在 `shared/template-fit.ts`，入库与分拣共用。
- 分拣模式：商品列表顶部「开始分拣」，一次一件看大图，Enter 按建议确认模板并加入发布清单（已选过模板的直接进发布清单）、X 加入删除清单（不改模板，在删除清单里统一处理）、1–9 选模板、S 跳过、Z 撤销（服务端按审计快照还原，分拣后又被改过的商品不能撤销；撤销时会同时移出清单）。按钮「移入废弃箱」仍可用，不绑快捷键，废弃的商品可在废弃箱恢复，不能用 Z 撤销。清单按店铺分开，保存在浏览器本地。换模板与快捷模板规则一致：标题、SKU、图片保持不变。
- `/dashboard` 经营看板：商品状态、Joom 审核状态、质量分布、关注清单和操作活动。
- 商品列表批量工具：同步 Joom、批量改价、批量库存、批量设置普通货、批量发布/校验、从 Joom 批量删除线上商品。
- 列表卡片和表格可直接发布；单件及批量发布进入服务端顺序队列，页面可继续使用。任务进度、失败原因及重试入口会显示在列表，刷新后仍可查看。服务重启时，正在提交的商品会标记为结果待核对，避免自动重复发布。
- 商品编辑器：图片 URL/重复检查、颜色×尺码变体矩阵、Joom 审核诊断、历史操作记录与恢复。
- 设置页：类目属性模板；属性模板通过共享配置保存，编辑页按类目一键套用。

新增能力都通过 `services` 和 `marketplaces` 接口隔离：Joom 状态同步走 `MarketplaceAdapter.getProduct`，批量操作走独立 `BatchService`，质量评分集中在 `quality.ts`，后续新增平台或改评分规则不需要改 React 页面。
