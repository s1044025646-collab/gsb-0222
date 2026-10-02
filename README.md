# 本地闪卡复习服务（TypeScript + Node.js + SQLite）

只管理**复习安排**的本地后端：牌组、卡片正反面、复习记录、暂停状态与到期日期。
提供 HTTP API 与命令行（CLI），不含前端、试卷评分、多人协作或在线推荐。

- 运行环境：Node.js `>= 22.5`（使用 Node **内置** `node:sqlite`，无需编译原生模块）
- 零运行时依赖，Windows / macOS / Linux 均可直接运行，不依赖 Docker、WSL 或任何在线服务
- 数据保存在项目内 `data/flashcards.db`（SQLite）

## 一、快速开始

```powershell
npm install        # 仅安装开发依赖 typescript / @types/node
npm run build      # 编译到 dist/
npm test           # 编译并运行全部测试（不依赖真实等待或系统时间）
npm run demo       # 虚构日期的端到端演示（内存数据库，看完即弃）
npm start          # 启动 HTTP 服务，默认让操作系统分配一个空闲端口
```

启动后终端会打印实际地址，例如 `http://127.0.0.1:65307`。

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `0` | 监听端口；`0` 表示自动选择空闲端口 |
| `HOST` | `127.0.0.1` | 监听地址，仅本机访问 |
| `FLASHCARD_DB` | `data/flashcards.db` | SQLite 文件路径；`:memory:` 为内存库 |

## 二、间隔算法（确定性、可手算）

### 日期口径

- 所有日期都是 **UTC 自然日**，格式 `YYYY-MM-DD`，不使用时分秒和本地时区。
- 下一次到期日 = 实际复习日 + 间隔天数（`addUtcDays` 自动正确处理跨月、跨年、闰日）。
- 逾期卡只表示“到期日早于今天”，复习后**从实际复习日重新起算**，不会产生早于复习日的到期日。

### 间隔档位表

卡片维护一个整数“档位” `step`，档位对应间隔天数（斐波那契式增长，最大 365 天封顶）：

| step | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | ≥12 |
| --- | - | - | - | - | - | - | - | - | - | - | - | - | - |
| 间隔(天) | 1 | 2 | 3 | 5 | 8 | 13 | 21 | 34 | 55 | 89 | 144 | 233 | 365 |

### 三档自评含义

| 自评 | 含义 | 档位变化 |
| --- | --- | --- |
| `again` | 忘记了，需要很快再见 | 老卡 `step - 2`（最低回到 0）；新卡仍为 0；熟练连击清零 |
| `hard` | 勉强记住 | 老卡 `step + 1`；新卡保持 0；熟练连击清零 |
| `easy` | 熟练 | `step + 2`（**新卡第一次**为 `+1`，避免新卡一下推太远）；熟练连击 +1 |

> 新卡（`step=0` 且从未评分）首次评 `again` 或 `hard` 都是 1 天后再见；首次 `easy` 为 2 天。

### 手算例子

以一张新卡为例，从 `2024-02-28` 开始：

1. `2024-02-28` 新卡评 **easy** → step 1，间隔 2 天 → 到期 `2024-03-01`
2. `2024-03-01` 再 **easy** → step 3，间隔 5 天 → 到期 `2024-03-06`
3. `2024-03-06` 再 **easy** → step 5，间隔 13 天 → 到期 `2024-03-19`
4. `2024-03-19` 忘了评 **again** → step 5−2 = 3，间隔退回 5 天 → 到期 `2024-03-24`
5. 若一路 **easy**，间隔沿 34→89→144→233→**365 封顶**，之后恒定 365 天

闰日例子：新卡 `2024-02-28` 评 **hard**（间隔 1 天）→ 到期 `2024-02-29`（2024 是闰年）；
同样操作在平年 `2023-02-28` → 到期 `2023-03-01`。

### 同卡同日重复提交限制

同一张卡在**同一个 UTC 自然日只能评分一次**：

- 服务层检查 + 数据库 `reviews(card_id, reviewed_on)` 唯一约束双重保障；
- 重复提交返回 `409 ALREADY_REVIEWED`，**不会**因网络重试连续放大间隔；
- 想在另一天复习，传入另一日期的 `date` 即可。

### 暂停与恢复

- 暂停卡不进入到期队列，也不能被评分；`step / interval / ease_streak / due` 与全部历史保留。
- 恢复时：若原到期日仍在未来则沿用；若暂停期间已逾期，则到期日重置为**恢复当天**，立即回到队列。

### 内容更改

每次复习事件都保存当时的 `{front, back}` 快照（`content_snapshot`）。之后修改卡片内容，
历史自评仍指向复习时看到的内容，不受影响。

## 三、CLI

```powershell
npm run build

# 建牌组 / 列表 / 统计
node dist/src/cli.js deck-create --name "日语N5"
node dist/src/cli.js deck-list
node dist/src/cli.js deck-stats --deck 1

# 导入卡片（文件为 JSON 数组，或 {"cards":[...]}）
node dist/src/cli.js import --deck 1 --file data/cards.sample.json --date 2024-02-28

# 到期 / 未到期 / 全部卡片（可用 --status new|learning|paused 过滤）
node dist/src/cli.js queue    --deck 1 --date 2024-02-29
node dist/src/cli.js upcoming --deck 1 --date 2024-02-29
node dist/src/cli.js cards    --deck 1

# 提交复习：again=忘记 hard=勉强 easy=熟练
node dist/src/cli.js review --card 1 --rating easy --date 2024-02-28

# 暂停 / 恢复 / 单卡历史 / 导出整组历史
node dist/src/cli.js pause  --card 2
node dist/src/cli.js resume --card 2 --date 2024-03-20
node dist/src/cli.js history --card 1
node dist/src/cli.js export-history --deck 1
```

所有输出为 JSON。CLI 数据文件同样由 `FLASHCARD_DB` 控制（可用独立文件做实验）。

## 四、HTTP API

统一返回 `{ "data": ... }`；错误返回 `{ "error": { "code", "message" } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/api/decks` | 建牌组 `{name}` |
| GET | `/api/decks` | 牌组列表 |
| GET | `/api/decks/:id` | 牌组详情 |
| GET | `/api/decks/:id/stats` | 牌组统计 |
| GET | `/api/decks/:id/history` | 导出整组复习历史 |
| POST | `/api/decks/:id/cards/import` | 导入 `{date?, cards:[{front,back}]}` |
| GET | `/api/decks/:id/cards?status=` | 卡片列表（可按状态过滤） |
| GET | `/api/decks/:id/queue?date=` | 到期队列（date 默认今天 UTC） |
| GET | `/api/decks/:id/upcoming?date=` | 未到期列表 |
| GET | `/api/cards/:id` | 卡片详情 |
| PATCH | `/api/cards/:id` | 修改内容 `{front?, back?}` |
| GET | `/api/cards/:id/history` | 单卡复习历史 |
| POST | `/api/cards/:id/reviews` | 提交评分 `{rating, date?}` |
| POST | `/api/cards/:id/pause` | 暂停 |
| POST | `/api/cards/:id/resume?date=` | 恢复 |

端到端示例（PowerShell，端口换成实际打印值）：

```powershell
$u = "http://127.0.0.1:65307"
Invoke-RestMethod -Method Post "$u/api/decks" -ContentType "application/json" -Body '{"name":"日语N5"}'
Invoke-RestMethod -Method Post "$u/api/decks/1/cards/import" -ContentType "application/json" `
  -Body '{"date":"2024-02-28","cards":[{"front":"犬","back":"狗"}]}'
Invoke-RestMethod "$u/api/decks/1/queue?date=2024-02-28"
Invoke-RestMethod -Method Post "$u/api/cards/1/reviews" -ContentType "application/json" `
  -Body '{"rating":"easy","date":"2024-02-28"}'
```

### 错误码

| HTTP | code | 触发场景 |
| --- | --- | --- |
| 400 | `INVALID_FIELD` / `INVALID_CARDS` / `INVALID_STATUS` / `INVALID_RATING` / `INVALID_DATE` / `INVALID_ID` / `INVALID_JSON` | 参数校验失败 |
| 404 | `DECK_NOT_FOUND` / `CARD_NOT_FOUND` / `NOT_FOUND` | 资源或路由不存在 |
| 409 | `DECK_EXISTS` / `ALREADY_REVIEWED` / `CARD_PAUSED` / `CARD_NOT_PAUSED` | 冲突状态 |
| 413 | `BODY_TOO_LARGE` | 请求体超过 1MB |
| 500 | `INTERNAL` | 服务内部错误 |

## 五、端到端虚构日期演示

`npm run demo` 使用内存库，按虚构日期演示并打印每一步：

- 间隔档位表与手算序列；
- 2024 闰日（`02-28 → 02-29`）与跨月、跨年；
- 逾期卡补评（到期不早于复习日）；
- 忘记后档位回退、连续熟练延长到 365 天封顶；
- 暂停后移出队列、恢复时逾期重置到恢复当天；
- 同日重复提交被拒且间隔不被放大；
- 修改内容后历史保留旧快照；牌组统计与历史导出。

## 六、测试

`npm test` 覆盖：手算间隔序列、新卡三档、忘记回退、连续熟练、跨月与闰日、
稳定队列顺序（`due, id`）、同日重复提交、非法日期/评分、暂停恢复、
内容快照保留，以及**关闭并重新打开数据库后的到期结果一致性**。
全部通过虚构日期驱动，不修改系统时间、不依赖真实等待。

## 七、目录结构

```
src/
  scheduler.ts  间隔/日期纯函数（可独立测试、可手算复核）
  db.ts         SQLite 建表与事务
  sql.ts        轻量查询辅助
  service.ts    业务规则与错误码（API 与 CLI 共用）
  server.ts     HTTP 路由
  main.ts       服务启动入口
  cli.ts        命令行入口
  demo.ts       虚构日期端到端演示
test/           scheduler / service / HTTP API 三组测试
data/           SQLite 数据目录（含导入示例 cards.sample.json）
```
