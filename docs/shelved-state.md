# 把 `pending` 从优先级提升为一个搁置态（shelved state）

> 状态：**设计讨论中**，未实现。开放问题见文末，需要拍板后才能开工。
>
> 目标：长期闲置、短期内不会启动的事项，应该有一个**顶级、可见、不参与"接下来做什么"**的归宿，而不是继续躲在 `todo` 列里当一个排序垫底的优先级。

## 1. 问题：`pending` 是一个类别错误

当前模型把两件不同的事压进了一条轴：

- `CARD_STATES = todo | doing | review | done` —— 卡片在**流程里的位置**。
- `CARD_PRIORITIES = high | normal | low | pending` —— 卡片**有多紧急**，声明顺序即排序顺序。

`high / normal / low` 回答"多急"，是一条连续的紧急度轴；`pending` 回答的是"在不在盘上"。两者是不同维度。`types.ts` 的注释其实已经承认了这点：

> "`pending` means **deliberately shelved** until something outside the card changes."

后果（都能在代码里指出来）：

- `Projection.board()` 按 state 分列，`pending` 卡仍然占 `todo` 列。
- `Projection.openFor()` 用 `state !== "done"` 判定 open，`pending` 卡仍算 "open"。
- `Kanban.claim()` 只对 `done` / `doing` / `review` 设限，没有 blocker 的 `pending` 卡**可以被直接 claim**。
- 排序里 `pending` 垫底（`compareByPriority`），所以它只是"排在后面"，不是"被移出候选"。

这正是闲置事项不该有的行为：它们不该出现在"接下来做什么"的候选人里。同时，`pending` 占着优先级的一个槽位，让本来干净的 高/中/低 三档变得暖昧。

## 2. 业界调研：长期的"闲置事项"放在哪里

四种主流形态：

### 2.1 独立列 / 桶（state）—— 最贴近本需求

| 工具                           | 术语                                                                           | 说明                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Linear**                     | state **type**: `Backlog` / `Unstarted` / `Started` / `Completed` / `Canceled` | `Backlog` 与 `Todo` 是**两个不同的列**：Backlog 是"还没打算做"，Todo 是"这一轮要做"。默认状态集：Triage / Backlog / Todo / In Progress / Done / Canceled |
| **Pivotal Tracker / Shortcut** | **Icebox**                                                                     | 未排期的 story 进"冰柜"；取出即进入 Current，被排期。这是"闲置=一个可见容器"最经典的先例                                                                 |
| **Azure DevOps**               | `Removed`                                                                      | New / Active / Resolved / Closed 之外的正式 state：出了范围但不删除                                                                                      |
| **Jira**                       | 自定义 status（常见 `Parked` / `Deferred`）+ resolution                        | Jira 明确把 _status_（在流程哪里）和 _resolution_（Won't Do / Deferred）分开，二者正交                                                                   |
| **GitHub Issues / Projects**   | close as **"not planned"** + Archive                                           | 离开 open 集合，但不是"done"                                                                                                                             |
| **Trello / Basecamp**          | 自由列，常见一列 `Maybe` / `Not now`                                           | 以自由列为模型；Basecamp Card Table 的列可自定义                                                                                                         |

### 2.2 Someday/Maybe 清单（GTD）—— 概念源头

David Allen 的 GTD 里，someday/maybe 项**不在任何"下一步行动"清单中**，靠**每周回顾**重新评估；配套的 Tickler（日期文件）用于"某天再提醒我"。要点：闲置项必须有一套**回顾仪式**，否则会永久沉底。

### 2.3 旗标 + 延后日期（与流程正交）

- **OmniFocus**：`Someday` 旗标 + `Defer Until` 日期 + `On Hold` 项目状态。被 defer 的事项在 Forecast 里消失，到日才出现。
- **Things 3**：`Someday` / `Anytime` / `Scheduled`。
- **Todoist**：优先级严格是 P1–P4；"someday" 是通过 section/filter 表达，**绝不进优先级**——这正是"pending 不该是优先级"的现成印证。

### 2.4 归档 / 取消

离开工作集但保留记录。语义偏"结束"（archive / canceled / won't-do / removed），与"以后还做"不同。

### 2.5 三条结论

1. **成熟工具里几乎没人在优先级里表达"闲置"。** 优先级是紧急度序；闲置是"在不在盘上"。→ 提升为顶级类型的直觉是对的。
2. **主流只有两种形态：独立列/桶，或正交旗标(+日期)。** 列 = 可见、可计数、一键搁置/取回，但需要定义规则；旗标 = 不加列，但默认不可见、容易遗忘、依赖回顾仪式。
3. 成熟工具把三种"终结/收场"意图分开：`done`（已交付）、`canceled/won't-do`（决定放弃）、`someday/icebox`（暂不做但**仍然想做**）。本板只有 `done`，"第三态"目前由 `pending` 兼任。

## 3. 命名评估

| 候选         | 来源                                         | 语义                         | 优                                                             | 劣                                                                                                                                                                                                                         |
| ------------ | -------------------------------------------- | ---------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **someday**  | GTD                                          | "某天/也许"，非完成、非放弃  | 覆盖度最高、语义精确、不会与 todo/blocked 混；`[someday]` 顺眼 | 略软、未交代"何时回来"                                                                                                                                                                                                     |
| **icebox**   | Pivotal / Shortcut                           | 未排期、可随时取出的冰柜     | kanban 原生、画面准确                                          | 对非 Pivotal 用户是行话                                                                                                                                                                                                    |
| **parked**   | 通用                                         | 停一边、有原因、有人做了决定 | 与 `blocked` 并列通顺                                          | 易与 `blocked` 混；暗示"很快回来"                                                                                                                                                                                          |
| **shelved**  | 本 repo 自己的注释（"deliberately shelved"） | 搁置                         | 与现有文档用词一致、中性                                       | 词形偏重，作列名略生硬                                                                                                                                                                                                     |
| **idle**     | —                                            | 空闲                         | 短                                                             | ❌ 机器资源语义（idle process / idle timeout）；读起来像"暂时空闲、很快会忙"；描述的是卡自身的"能量"，而其它 state（todo/doing/review/done）描述的都是**人对它做了什么**，气质不一致；不是既有 kanban 词汇，需要板自己造词 |
| **deferred** | Jira resolution                              | 延后                         | 直觉清晰                                                       | 暗示有日期/tickler，本板没有日期字段，名不副实                                                                                                                                                                             |
| **backlog**  | Agile                                        | 待办池                       | 通用                                                           | ❌ 本板的 `todo` 已经是可执行的 backlog，再加一个 backlog 会有两个 backlog                                                                                                                                                 |
| **on-hold**  | OmniFocus                                    | 暂停                         | —                                                              | 连字符不便；OmniFocus 里 on-hold 更接近 blocked/suspended，与 `blocked` 冲突                                                                                                                                               |

**推荐：`someday`**（次选 `icebox`，再次 `parked`）。**不推荐 `idle`。**

## 4. 建议方案：新增一个 shelved 类 state，并引入 state 分类

### 4.1 模型改动

1. `CARD_PRIORITIES` 去掉 `pending` → `high | normal | low`。
2. `CARD_STATES` 增加搁置态（建议 `someday`）。
3. **把"语义"从 `state` 推导出来**，而不是在代码里到处 `if state === "someday"` 或 `state !== "done"`。

   `state` 仍然**每卡只有一个**，是用户唯一要选的东西。下面是**纯函数映射**，不是新字段、不进事件日志、不进 `Card`：

   ```ts
   // 决策只看这三行，别的地方不许再写 state === "..."
   const ON_RADAR = (s: CardState) =>
     s === "todo" || s === "doing" || s === "review";
   const IS_SHELVED = (s: CardState) => s === "someday";
   const IS_TERMINAL = (s: CardState) => s === "done";
   ```

   **轻量做法（建议起步）**：在 core 导出 `onRadar(state)` / `isOpen(state)` / `isTerminal(state)` 三个谓词，实现里查表即可。对外零新增概念。

   **何时升级为公开的 `StateCategory = active | shelved | terminal` 枚举**：当某个桶里真的出现第二个成员时（例如 `canceled` 也归 `terminal`）再提升，那时它可以省掉"每个谓词都要记得加新 state"的坑。

   它解决的问题是**决策收敛**，不是"多一层组织维度"：现有代码里 `openFor` 用 `state !== "done"`、`openBlockers` 用 `blocker.state !== "done"`、`claim` 里逐条判断、`mine` 用 `state === "todo"`——加了 `someday` 后，这些 `!== "done"` 全部变成必须现场拍板的点，且散在六七个文件里，漏一个就是 bug（例如 `mine` 忘了排除，闲置卡又冒出来）。这是 Linear 的 state _type_ 思路。

### 4.2 必须拍板的规则（决定成败的是这些，不是名字）

| 问题                                 | 建议                                                                                                        | 理由                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `mine` / `openFor` 是否包含 shelved  | **排除**                                                                                                    | 闲置卡不能出现在"接下来做什么"的候选里，这是本次改动的核心收益                   |
| 能否直接 `claim` shelved 卡          | **允许直接 claim**（已拍板）；claim 同时把它拉回 `doing` 并指派                                             | 用户选择：`someday` 是一个位置，不该成为取活的门槛                               |
| 搁置时是否清空 `assignee`/`reviewer` | **清空两者**（已拍板）                                                                                      | 强调"不在盘上、无主"；也让"直接 claim 必先无主"自洽                              |
| 如何*进入* `someday`                 | 只有 `move <id> someday`（**不新增 `shelve`/`unshelve` 动词**）；清空是进入 someday 的副作用                | 用户选择：不为一个转换再加一层动词表                                             |
| `board` 如何呈现                     | **最左**（someday 在 todo 之前，Pivotal Icebox 惯例）；像 `done` 一样默认折叠/预览                          | 折叠避免它抢四列主视图，符合面板"有界"的既有设计                                 |
| 被 shelved 卡阻断的下游              | 仍算 blocked；并可在输出里点明 blocker 处于 shelved                                                         | `openBlockers` 只看 `!= done`，天然成立，保持即可                                |
| shelved 内部排序                     | 仍按 high/normal/low 排                                                                                     | 复用 `compareByPriority`                                                         |
| `list` 项目计数                      | 增加一列                                                                                                    | 与 board 对账                                                                    |
| 迁移存量 `priority: "pending"`       | **已完成（§4.3）**：并发 agent 应急把 7 条事件改为 `low`，随后 8 张卡 `move` 到 `someday`；不做 replay 兼容 | `pending` 一旦从枚举移除，老事件就会被 schema 拒绘；没有兼容层，必须先把数据改完 |

#### 4.2.1 "someday 无主"是引擎不变量，不是 CLI 的副作用

实现上**不要**把"清空 assignee/reviewer"写在 CLI 的 `move` 分支里。板有四个前门（CLI / MCP / Web 拖拽 / Pi overlay），写在 CLI 就只对 CLI 生效，MCP 的 `kanban_move` 与 Web 拖拽会漏掉，于是 someday 列里混进带 owner 的卡。应让引擎（`kanban.ts` / `projection.ts`）保证一条不变量：

```
state === "someday"  ⇒  assignee === null && reviewer === null
```

由它统一兑现，则四个前门自动一致。同时 `edit --assignee` / `--reviewer` 想给 someday 卡设 owner 应当被拒（`invalid_state`）——"搁置卡无主"是模型规则，不是某个动词的礼貌。

**留痕：这是 `move` 唯一不再单纯的地方。** `move` 原本是盲的协调者动词（`move <id> doing` 故意不指派，见 `docs/rpiv-todo-learnings.md` 第 4 项）。进 someday 会清空，看似破坏了那个原则，实际不然：清空是**删信息（无主）**而非**造信息（擅自派活）**，且它是模型不变量。但这一句要写进代码注释，供后人对照。

### 4.3 迁移：一次性处理，不做兼容层

**硬后果先说清。** `pending` 一旦从 `CARD_PRIORITIES` 移除，`CardCreatedPayloadSchema` 就会拒绝带 `priority: "pending"` 的老事件，**投影 replay 直接 ZodError**。没有"先跑起来再慢慢迁"的余地——迁移必须在切新代码**之前**，直接对原始存储做，读 payload 时把 JSON 当 opaque，绕开 schema。

**实际影响面（本机实测）：**

- 存储：单库 `/Users/jyxc-dz-0101035/.ukb/board.db`（SQLite，174 张卡）
- 需迁移的**当前**卡：**8 张**——`#38`(gala)、`#230–235`、`#493`(civil-forest)
- 历史事件里带 `priority: "pending"` 的：7 条（`card.created` #493 + `card.updated` #230–235）
- ⚠ **绝不能字符串匹配**：`events.payload` 里出现 "pending" 的有 19 条，其中包含**正文里恰好写了 pending 的卡**（如 #38 的 body、event #679）。必须先 `JSON.parse` 再判断字段。

**实际怎么处理（已完成，2026-10-15）：**

设计中途 core 先落地、CLI 尚未跟上，造成了一次短暂的版本错配：另一个并发的 agent 在 15:08 之后发现所有读操作都因回放校验失败而报错，看板上 7 张卡正在用 `pending`。它做了应急处理——把这 7 条事件的 `priority` 就地改写成 `low`，备份在 `/tmp/board.db.bak2-151027`（备份里仍保有 7 条 pending 原值），并在卡 #660 的 note #686 里留了记录与找回清单。

随后本次迁移把语义补齐（**已执行**）：

```bash
for id in 38 493 230 231 232 233 234 235; do
  ukb move "$id" someday --agent pi --agent-type agent
done
```

结果：`someday (8)`，8 张卡 `assignee`/`reviewer` 均被清空，`ukb mine` 不再列出它们；看板计数 8+46+3+9+108 = 174，与总卡数对账。

**两点如实记录：**

- 优先级留在 `low`（应急改写值），没有改回 `normal`。原计划的 `normal` 是给 replay coercion 用的；现在 `someday` 已承载"搁置"语义，`low` 只是一条次要的紧急度信号，无害。若想还原原计划，`ukb edit <id> --priority normal` 即可。
- 没有提交 `scripts/migrate-pending.mjs`：它是"用完即弃"的一次性操作，本机这次是**先应急改值、再显式 move** 两步完成的，不需要常驻表面。将来若真有另一台机器拿着含 `pending` 的旧库，再临时写一个即可（核心是：先 `JSON.parse` 判字段改历史，再 append `card.moved` 搬 state）。

**两种后端都要处理**：默认 SQLite（`board.db`），但有的项目把 `.ukb/events.jsonl` 提交进 git，那边也要迁。

**若将来有多台机器/多份板**：每份都要跑一次；那时才值得把它提升为 `ukb migrate` 并把"已迁移"标记写进存储。

### 4.4 非目标

- `canceled / won't-do` 本次**不做**，但 4.1 收敛后的谓词让它日后好加。
- 不加日期/tickler 字段（`deferred` 之所以不选，就是因为它暗示日期）。

## 5. 备选方案：正交旗标（不加第五列）

与其加 state，不如加一个与 state 正交的字段：`shelved: boolean`，或更一般的 `horizon: now | next | later`，板面用 filter 渲染成"第五列"。

- 优点：四列规则（"四列，一条规则：先认领再开工"）不变；卡片能保留它原来的列（todo/review），激活即回到原位；`category` 的迁移代价也省了。
- 缺点：默认不可见、容易遗忘、需要回顾仪式（GTD 的每周回顾正是为此存在）；`mine` 仍要显式排除。

**倾向 state 方案**：用户的诉求正是"从 todo 里拿出来、变成顶级可见的东西"，state 直接满足；旗标反而把它藏起来。

## 6. 实现影响面（动手时的清单）

| 文件                                        | 需要改什么                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/types.ts`                | `CARD_STATES`、`CARD_PRIORITIES`、新增 state category、`Board` 接口                                                                              |
| `packages/core/src/schemas.ts`              | `CardStateSchema`（跟随 `CARD_STATES`）、`CardPrioritySchema` 去掉 `pending`（不再容忍老值——见 §4.3）                                            |
| `packages/core/src/projection.ts`           | `board()`、`openFor()`、`reviewQueueFor()`、`compareByPriority`、`openBlockers` 的语义确认                                                       |
| `packages/core/src/kanban.ts`               | `claim`/`review`/`done`/`reopen`/`move` 的转换规则；`transition()` 的 `to === "doing"` 门禁                                                      |
| `packages/server/src/routes/cards.ts`       | `state` 过滤、`"open"` 的含义                                                                                                                    |
| `packages/cli/src/render.ts`、`commands.ts` | `priorityMarker`、`mine`/`board` 渲染、help 文本、`flagPriority`；**`commands.ts:410` 的列名硬编码 `["todo","doing","review","done"]` 必须同步** |
| `packages/mcp/src/server.ts`                | `priority` schema 描述、是否暴露 state 参数                                                                                                      |
| `packages/web/src/app.js`                   | `COLUMNS`、`COLUMN_ACTIONS`（someday 不是意图动词，需特判为 `move`）、`previewCards`、`column.*` i18n                                            |
| `README.md`、`SKILL.md`、tests              | 文档与逐字节 formatter 断言                                                                                                                      |

## 7. 决定与剩余问题

已定（全部拍板）：

1. 名字 → **`someday`**
2. claim → **允许直接 claim**（同时拉回 doing 并指派）
3. 进 someday 时 `assignee`/`reviewer` → **两者都清空**，且作为**引擎不变量**（§4.2.1）
4. 迁移 → **已完成**：应急改值 + 8 张卡 `move` 到 `someday`（§4.3）。教训：core 先落地而 CLI/其它消费者未跟，会造成版本错配。
5. canceled → **本次只做 someday**；谓词收敛好后 canceled 可随时补。`canceled` 与 `delete` 的关系、能否 reopen、UI 是否多一列，留作独立设计
6. 进入 someday 的动词 → **只有 `move <id> someday`**，不新增 `shelve`/`unshelve`
7. `someday` 位置 → **最左**（todo 之前）；Web UI 为第五列但默认折叠，与 `done` 的预览策略一致

仍待定（不阻塞开工，实现中再定）：

8. `someday` 卡能否被 `done` / `review`（即从搁置直接收场或送审）→ **可以**：两者都是"离开搁置"的合法去向。
9. Pi overlay 是否渲染 someday 行 → **渲染**。并且把"显示哪些 state"做成可配置项：`overlay.states`（会话内 `states=doing,todo,someday` 覆盖），默认 `doing, todo, review, someday`（**含 someday、不含 done**）。计数与行的顺序固定为 `doing → todo → review → someday → done`，所以 someday 在 done 之前。`done` 默认不显示（既无行也无计数）。
