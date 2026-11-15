# 亚马逊德国站童装连帽卫衣（无拉链）采集进度

这份文档是亚马逊德国站（amazon.de）童装套头连帽卫衣采集的续采记录。每次采集后更新"当前断点"和"采集日志"，重复商品不计作新增款。

## 采集条件

- 站点：amazon.de
- 品类：童装连帽卫衣，只要套头款（pullover）。
- 排除：拉链、半拉链（1/4 Zip、Half-Zip）、开衫（Cardigan）、Jacket/Vest、圆领款（Crew Neck，无帽）、成人款（Men's / Women's）、婴儿款（Baby）。
- 年龄段：童装常规范围（暂按约 3–14 岁处理，待用户确认具体范围）。
- 性别：不限。
- 目标：100 款新增，按后端 `sourceProductId`（ASIN）去重。

## 采集环境（经验，必读）

1. **采集插件只在用户自己打开的 Chrome 中注入。** WebBridge 用 `navigate` 自动开的标签页不会注入插件：页面没有采集栏（`.joom-batchbar`）、卡片没有复选框、`evaluate` 中查不到 `#joom-collector-style`。遇到这种情况，先确认是否在用户的 Chrome 标签页里操作，不要直接判断插件失效。
2. **接管用户 Chrome 标签页的步骤：** 在有插件的 Chrome 中打开亚马逊搜索页 → 用 `list_browser_tabs` 找到该标签页的 `tabId` → 用 `attach_tab` 接管。`attach_tab` 不会切换用户正在看的前台标签页，接管后的标签页关闭 `close_session` 时不会被关掉。
3. **2026-11-12 检查结果：** `list_browser_tabs` 只返回 WebBridge 自己创建的 1 个标签页，用户 Chrome 的标签页未出现。需要先确认 WebBridge 连接的是同一个 Chrome 窗口。
4. **亚马逊地区跳转：** 自动化打开时，搜索页曾跳到语言/货币设置页（`customer-preferences`），显示 "Deliver to China"，还弹出 "International Shopping Transition Alert"；首次曾出现拦截页 "Tut uns Leid!"。重新打开搜索页后可正常显示商品卡片。
5. **搜索词：** `Kinder Hoodie ohne Reißverschluss`，URL 中的 ß 编码为 `%C3%9F`（`https://www.amazon.de/s?k=Kinder+Hoodie+ohne+Rei%C3%9Fverschluss`）。注意不要拼错（曾误写为 `Rrei`）。

## 当前断点

- 最近检查：2026-11-12。
- 后端亚马逊记录：本次插件提示成功采集 Ragwear Madlenka；本批采集进度文档累计 2 款（`B0FDB1KSVS`、`B09ZQ7CZG5`，详情变体 ASIN `B0CVHZBJ6D`），另有 `B0FQV9PRFR` 既有记录。终端当前无法连到 `localhost:8787`，未用 API 复核总数。
- 当前搜索页（首页 48 个卡片）标题筛选出的候选 26 款，待插件可用后用"采集选中"采集：

  B0FDB1KSVS、B0C36TV25Y、B0F43TN7NG、B0FWL4J4NK、B0H8Q6BXJF、B0GZHDCFHS、B01E0GZ8VU、B001Q9AM7A、B0FD9ZZ6YL、B0FD9YK42W、B0H6JBXWMD、B0HCZV9RDF、B0H34LKXFR、B0FL67XDDS、B0FFBCCFND、B0H6FF8VVR、B0FBL1WCQQ、B0D91ZHN25、B0HH8J67HL、B0BN6LS8XN、B07X8PHB6T、B089PTKT9Q、B085RLDCFM、B07YCPGQ6M、B0FWKM6XGQ、B07PWY99YL

- 标题不明确、暂时跳过的 7 款（采集后再看详情页判断）：B07K9VCGKW、B0DLGY4FNG、B0DGX8SHDY、B0H4D39Y2X、B0H9XBJ38C、B0CSD7F234、B07PZ8LMRD。

## 采集日志

- 2026-11-12：确认 Chrome 中已注入 auto_tools 自有插件，采集栏和商品页按钮可用。本地后端启动成功。
- 2026-11-12：通过项目插件采集 `B0FDB1KSVS`（Haloumoning Boys' Hoodie，EUR 12.60，80% Polyester/20% Cotton，Pull On，无口袋），选择聚酯纤维童装无拉链模板。
- 2026-11-12：复核 Amazon Essentials `B0FL62RTK2` 和 Spring&Gege `B0CG61YX4F`，详情均显示袋鼠口袋，未采集。
- 2026-11-12：通过项目 Chrome 插件新增采集 Ragwear Madlenka Girls' Hoodie（页面路径 ASIN `B09ZQ7CZG5`）；商品图正面无口袋/拉链，闭合类型 Pull On，童装尺码 122–152，选择“童装连帽卫衣无拉链棉”模板。产品详情还有一处泛化描述提到 zip，但闭合类型和商品图均为套头无前拉链。
- 2026-11-12：Jako One Cotton Hooded Sweatshirt `B0G259RFLD` 详情明确有贴袋，排除；adidas Entrada26 `B0F3JHM7XH` 因本轮未完成口袋确认，暂缓。

## 续采注意事项

1. 先确认插件采集栏和卡片复选框已经出现，再勾选卡片。
2. 每次记录：候选数、插件报告的重复数、后端新增数（按 ASIN 核对）、拉链/年龄段不符的数量。
3. 目标 100 款按新增且符合条件的 ASIN 计算；不符合条件的不计入，并在本文档中列出。
4. 换关键词时可尝试：`Kinder Kapuzenpullover ohne Reißverschluss`、`Jungen Hoodie`、`Mädchen Hoodie`，并翻页。
5. 更新本文档的"当前断点"和"采集日志"，保留历史记录。
