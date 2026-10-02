# 闪卡间隔复习后端（TypeScript + Node.js + SQLite）

本地运行的闪卡（Flashcard）间隔复习服务，只做后端：HTTP API + 命令行（CLI）。
管理牌组、卡片正反面、复习记录、暂停状态与到期日；**不做**试卷评分、多人协作或在线内容推荐。

- 运行时：Node.js（推荐 v22.5+；本项目在 **Node v25** 上开发验证），使用内置 `node:sqlite`，
  **零运行时依赖、无需 Docker/WSL、无需 C++ 编译环境**。
- 语言：TypeScript（严格模式），构建产物在 `dist/`。
- 数据：项目内 `data/flashcards.db`（SQLite 单文件，自动创建）。

## 快速开始

```powershell
npm install        # 仅安装 typescript 和类型声明（开发依赖）
npm run build      # 类型检查 + 编译到 dist/
npm test           # 构建并运行全部测试（16 个，纯内存/临时库，不依赖真实等待）
npm run demo       # 在虚构日期上跑完整端到端演示（自动重建 data/flashcards.db）
npm start          # 启动 HTTP API；默认自动选择一个空闲端口
```

启动后控制台会打印实际地址，例如 `http://127.0.0.1:58081`。指定端口与数据库：

```powershell
node dist/server.js --port 8080 --db data/my.db
node dist/cli.js serve --port 8080
```

## 自评三档含义

提交复习时 `rating` 只能取以下三个值：

| rating | 含义 | 对间隔的影响 |
| --- | --- | --- |
| `forgot` | 忘记了 | 回退：间隔变为 **1 天**，连续熟练计数清零 |
| `hard` | 勉强记住 | 保守重来：间隔变为 **1 天**，连续熟练计数清零 |
| `easy` | 熟练 | 按连续熟练阶梯延长间隔（见下） |

## 间隔算法（简单、确定、可手算）

所有日期都是 **UTC 自然日**（`YYYY-MM-DD`），不涉及时区时分秒。

- **新卡**（从未复习）导入后立即视为当天到期；第一次复习无论哪一档，下一次间隔都是 **1 天**。
  若第一次就是 `easy`，连续熟练计数预置为 1；`forgot/hard` 则为 0。
- **老卡连续熟练阶梯**（第 k 次连续 `easy` 取第 k 档，首次熟练是 1 天的入门间隔）：
  `1, 3, 7, 14, 30, 60, 120, 240, 365` 天；
  实现中阶梯常量为 `EASE_LADDER = [3, 7, 14, 30, 60, 120, 240, 365]`，
  最大间隔 `MAX_INTERVAL_DAYS = 365`，之后连续熟练仍保持 365 天。
- `forgot` / `hard` 随时把间隔打回 1 天并清零计数，之后再连续熟练重新从 3 天开始爬升。
- **下一次到期日 = 实际复习日 + 新间隔**。逾期复习也只从复习日往后算，
  不会产生早于复习日的到期日，也不会因为逾期天数而额外调整间隔。
- **同一张卡每个 UTC 自然日只能提交一次**。重复提交（含网络重试、换连接重试）
  返回 `409 ALREADY_REVIEWED_TODAY`，数据库 `UNIQUE(card_id, review_date)` 约束兜底，
  因此间隔不会被重复放大。
- 也不能用早于该卡上次复习日的日期补提交（`422 DATE_BEFORE_LAST_REVIEW`）。

### 手算例子

一张卡 2024-01-31 导入，按下面的日期复习（连续熟练时按阶梯逐档延长）：

| 复习日 | 自评 | 复习前状态 | 新间隔 | 新到期日 |
| --- | --- | --- | --- | --- |
| 2024-01-31 | easy | 新卡 | 1（入门） | 2024-02-01 |
| 2024-02-01 | easy | streak 1 | 7（阶梯第 2 档） | 2024-02-08 |
| 2024-02-08 | easy | streak 2 | 14 | 2024-02-22 |
| 2024-02-22 | easy | streak 3 | 30 | 2024-03-23 |
| 2024-03-23 | forgot | streak 4 | 1（回退） | 2024-03-24 |
| 2024-03-24 | hard | streak 0 | 1 | 2024-03-25 |
| 2024-03-25 | easy | streak 0 | 3（重新爬升） | 2024-03-28 |

逾期例子：卡片到期日为 2024-02-08，直到 2024-02-20 才复习且评 `easy`（当时连续计数为 2），
新到期日 = 2024-02-20 + 14 = **2024-03-05**，与逾期 12 天无关。

闰日与跨月：2024-02-28 新卡评 `easy` → 到期 **2024-02-29**（2024 是闰年）；
2024-01-31 + 7 天按 UTC 日期加法得到 **2024-02-07**，由代码统一计算。

### 暂停与恢复

- 暂停的卡不进入到期/未到期队列，也不能提交复习（`409 CARD_SUSPENDED`）。
- 恢复只改状态：`due_date`、间隔、连续计数与全部复习事件原样保留；
  若恢复时已过到期日，它会作为逾期卡立即出现在到期队列。

### 内容快照

每次复习事件都保存当时的 `front_snapshot/back_snapshot`。之后修改卡片内容，
历史记录里仍能看到该次自评针对的是哪版文字。

## 演示日期（测试/演示不依赖系统时间）

- HTTP：查询参数 `?date=YYYY-MM-DD`，或请求头 `X-Demo-Date: YYYY-MM-DD`；省略则取当前 UTC 日。
- CLI：所有相关命令支持 `--date YYYY-MM-DD`。
- 日期必须是真实存在的日历日，`2023-02-29`、`2023-13-01` 等返回 `INVALID_DATE`。

## HTTP API

错误响应统一为 `{ "error": { "code": "...", "message": "..." } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/decks` | 建牌组，body `{"name":"日语"}` |
| GET | `/api/decks` | 牌组列表 |
| POST | `/api/decks/:id/cards?date=YYYY-MM-DD` | 导入卡片，body 为 `[{front,back}]` 或 `{"cards":[...]}` |
| GET | `/api/cards?deckId=&includeSuspended=1` | 卡片列表（默认不含暂停卡） |
| PATCH | `/api/cards/:id` | 修改正反面 `{front,back}` |
| GET | `/api/queue/due?date=&deckId=` | 今日（含逾期）到期队列 |
| GET | `/api/queue/upcoming?date=&deckId=` | 未到期列表 |
| POST | `/api/cards/:id/reviews?date=` | 提交复习 `{rating:"forgot|hard|easy"}` |
| POST | `/api/cards/:id/suspend` | 暂停 |
| POST | `/api/cards/:id/resume` | 恢复 |
| GET | `/api/reviews?cardId=` | 复习历史（省略 cardId 即导出全部历史） |
| GET | `/api/stats?date=` | 各牌组总数/暂停数/到期数/三档自评次数 |

队列稳定排序：`due_date` 升序，同一天按卡片 `id` 升序，分页/重试不会乱序。

### curl 示例（PowerShell 下用引号包住 URL）

```powershell
curl.exe -X POST http://127.0.0.1:8080/api/decks -H "content-type: application/json" -d '{\"name\":\"日语\"}'
curl.exe "http://127.0.0.1:8080/api/queue/due?date=2024-03-01"
curl.exe -X POST "http://127.0.0.1:8080/api/cards/1/reviews?date=2024-03-01" -H "content-type: application/json" -d '{\"rating\":\"easy\"}'
```

## CLI 示例

```powershell
node dist/cli.js deck new 日语
node dist/cli.js card import 1 examples/cards.json --date 2024-02-28
node dist/cli.js card import 1 examples/cards.csv          # CSV 表头需含 front,back
node dist/cli.js queue due --date 2024-03-01
node dist/cli.js queue upcoming --date 2024-03-01 --deck 1
node dist/cli.js review 1 easy --date 2024-03-01
node dist/cli.js card suspend 3
node dist/cli.js card resume 3
node dist/cli.js history 1
node dist/cli.js stats --date 2024-03-01
```

所有 CLI 命令可用 `--db data/其它.db` 指定数据库。

## 端到端演示说明

`npm run demo`（即 `node dist/cli.js demo`）会重建数据库并在 2024-02-28 起的虚构日期上演示：

1. 导入 3 张卡，当天即到期；
2. 同日重复提交被 409 拒绝（间隔不放大）；
3. 熟练卡跨月、闰日推进；忘记/勉强回退为 1 天；
4. 一张卡暂停后从队列消失，恢复后保留记录并作为逾期卡回归；
5. 逾期卡复习后到期日只从复习日往后算；
6. 打印单卡历史（含内容快照）与牌组统计。

演示结束后可用以下命令验证“服务重启后到期结果一致”：

```powershell
node dist/cli.js queue due --date 2024-03-05
node dist/cli.js stats --date 2024-03-05
```

## 错误码

| HTTP | code | 触发场景 |
| --- | --- | --- |
| 400 | `INVALID_DATE` | 日期缺失、格式错或日期不存在 |
| 400 | `INVALID_RATING` | rating 不是 forgot/hard/easy |
| 400 | `INVALID_NAME` / `INVALID_CARD` / `INVALID_CSV` / `INVALID_JSON` | 参数校验失败 |
| 400 | `INVALID_ID` | id 不是整数 |
| 404 | `DECK_NOT_FOUND` / `CARD_NOT_FOUND` / `NOT_FOUND` | 资源或路由不存在 |
| 409 | `DECK_EXISTS` | 牌组重名 |
| 409 | `ALREADY_REVIEWED_TODAY` | 同卡同 UTC 日重复提交 |
| 409 | `CARD_SUSPENDED` / `CARD_ACTIVE` | 对暂停卡复习 / 重复暂停或恢复 |
| 422 | `DATE_BEFORE_LAST_REVIEW` | 复习日早于上次复习日 |
| 500 | `INTERNAL` | 未预期错误 |

## 数据一致性

提交复习在单个 SQLite 事务（SAVEPOINT）内同时写入 `reviews` 事件并更新 `cards`
的 `last_review_date / interval_days / ease_streak / due_date`，两者要么同时生效要么都不生效。

## 测试覆盖

- 手算间隔序列与 365 天封顶；闰日、跨月日期加法；
- 逾期复习不回溯；同卡同日重复提交（含重开连接模拟网络重试）；
- 非法/不存在日期、非法自评、早于上次复习日；
- 队列稳定排序；暂停/恢复保留记录；内容修改不影响历史快照；
- 关闭服务后用新连接重新打开数据库，到期结果与统计一致；
- HTTP 全流程与错误码。

## 已知限制

- 仅监听 `127.0.0.1`，面向单机本地使用，没有鉴权/多用户。
- 没有卡片富文本、标签、媒体与试卷评分；统计只提供到期数、暂停数和三档自评次数。
- `node:sqlite` 在当前 Node 版本会打印一条 ExperimentalWarning，不影响功能。
