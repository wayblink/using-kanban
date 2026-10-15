# 父子卡（伞卡 / 子卡）——一种层次关系，独立于阻塞

> 状态：**设计讨论中**，未实现。开放问题见文末，拍板后开工。
>
> 目标：把"一张伞卡（大目标）由多张子卡（小目标）支撑"这层关系做成一等公民，并在卡片显示里表现出来，而不是像 #38 现在这样手工维护一份对照表。

## 1. 现状：这个缺口已经被人写下来了

`#38 Complete Gala Selection 2.0` 的正文里有一段：

> 本卡的状态由子卡推导，不单独推进。
>
> ### 为什么不把这些子卡 relate 到本卡
>
> 本看板的 relation 表达的是**阻塞**（upstream 未完成则下游不可认领）。把子卡挂成本卡的下游会让整个 epic 反过来阻塞它自己的孩子——正好相反。所以对照表放在 body 里，不建 relation。

这是准确的分析。现有的两种关系都不是这个意思：

- `blockedBy` / `blocks`：**依赖**——"上游没完，下游不能开工"。方向是时间上的先后。
- `project`：**分区**——"属于哪个项目的卡片集合"。是扁平的，不表达谁支撑谁。

缺的是第三种：**构成**——"这张大卡由这几张小卡拼成"。方向是整体与部分，不是先后。

它带来的实际损失，在 #38 上都能看到：

- 子卡列表靠正文手工维护，会漂移（#38 正文里的子卡有一批已经 done，列表还在）。
- 子卡自己不知道自己属于哪张伞卡。
- 看板上看不出"这 20 张卡其实在支撑同一个目标"，也看不出整体进度。
- 伞卡的状态（#38 现在是 `someday` + "待定"）和子卡的真实进展没有任何自动联系，只能人读。

## 2. 业界调研：主流工具怎么建模

| 工具             | 术语                               | 形态                | 关键点                                                                                                 |
| ---------------- | ---------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| **Jira**         | Epic → Story → Sub-task            | 树，单亲            | 父关系是一个正式字段（Epic Link / Parent Link）；层级被强制；`blocks` 是**另一套**链接类型，与父子正交 |
| **Linear**       | Project → Issue；Issue → Sub-issue | 树，单亲            | 子卡是普通 issue，父卡显示进度                                                                         |
| **GitHub**       | Issue → Sub-issue                  | 树，单亲            | 子卡是普通 issue；父卡上直接显示 `x of y` 进度                                                         |
| **Azure DevOps** | Epic → Feature → User Story → Task | 树，单亲            | 四层固定层级；Parent 链接                                                                              |
| **Asana**        | Task → Subtask                     | 树，单亲，最多 5 层 | 子任务不是一个独立的一等对象                                                                           |
| **Monday**       | Item → Subitem                     | 树，单亲            | —                                                                                                      |
| **Trello**       | Checklist                          | **不是卡**          | 子项不是卡片，不参与看板流转——一种"退回清单"的做法                                                     |
| **GTD**          | Project / Next Action              | 概念模型            | 一个"项目"是需要多个"下一步行动"才能收尾的成果——伞卡的原始定义                                         |

### 四条结论

1. **它是树，不是网**：所有工具都只允许**一个父**。多父（DAG）不在任何主流产品里，因为它会让"进度"和"归属"都失去唯一答案。
2. **它和依赖是两回事**：Jira 的 `blocks` 与 `parent` 是两套链，Linear 的 relations 与 sub-issue 也是。它们正交——一张子卡可以既属于某伞卡，又被另一张卡阻塞。这一点 #38 的分析已经说对了。
3. **进度是派生的，收尾通常不自动**：父卡主要显示 `n/m done`（Linear / GitHub / ADO 都这么做）。鲜有工具在最后一个子卡完成时**自动**把父卡改成 done——父卡往往还有"整体验收"的含义。
4. **父卡通常不是一种新类型**：只有 Jira / ADO 把 epic 做成独立的 issue type；GitHub / Linear / Asana 里"父卡"就是一张普通卡，有子卡就自然成了父卡。后者更像本看板"卡片就是卡片"的气质。

## 3. 建议模型

### 3.1 关系与字段

```ts
interface Card {
  // …现有字段…
  /** 本卡的父卡 id；null 表示这是一张顶层卡。单亲。 */
  readonly parent: number | null;
  /** 本卡的直接子卡 id，按创建顺序。镜像自子卡的 parent，像 blocks。 */
  readonly children: readonly number[];
}
```

- **单亲树**：一张卡最多一个父。`parent` 是真相，`children` 是镜像（和 `blockedBy`/`blocks` 同一套做法）。
- **深度固定为一层（拍板）**：父卡是伞、子卡是叶——子卡不能再有子卡，父卡不能再有父。`parent` 校验两侧（子卡 `children` 为空、父卡 `parent` 为 null），所以循环在构造上不可能，不需要祖先链检查。
- **不是新类型**：任何卡只要被挂上子卡就是"伞卡"。不引入 epic 概念，避免第二套类型系统。

### 3.2 事件

新增两个事件类型（现有 `card.dependency_added/removed` 的兄弟）：

- `card.parent_set { parent: <id> }` —— 挂父。若已有父，等价于先清后设（投影里直接覆盖，并更新旧父的 children）。
- `card.parent_cleared {}` —— 摘父。

投影维护：子卡的 `parent`，以及父卡的 `children`（两端都动，和 `blocks` 的 `link`/`unlink` 一致）。

### 3.3 动词

- `ukb parent <id> --of <parentId>` —— 让 `<id>` 成为 `<parentId>` 的子卡。
- `ukb unparent <id>` —— 摘掉父。
- 备选：扩展已有的 `relate <id> --with <other> --as parent|child`。**我倾向专用动词**：`relate` 目前整个文档/语义都是"阻塞方向"，往里塞层次会让一个动词有两个含义；而 `parent`/`unparent` 是自解释的。`ukb show` 的备注里可以给出反向提示。

### 3.4 语义：只派生展示，不自动收尾

这是最需要拍板的一条。三个选项：

- **A（已拍板）纯派生 + 软提示 + 硬门禁（doing/review）**：父卡显示 `n/m children done`（派生进度）；子卡完成**不**自动改父卡；父卡在还有未完成子卡时**不能**进 `doing` 或 `review`（这是 q6 的"强制禁止"，与"纯派生"不矛盾——派生的是进度，门禁的是容器不当工作项）。`done` 仍不设门禁（一个卡必须总能关）。
- **B 子卡全 done 时自动把父卡 done**：省事，但会产生"我没点过它却完成了"的意外，且和"每个状态变更都是一个事件、一次明确意图"的现有模型冲突。
- **C 硬门禁**：父卡在还有未完成子卡时**不能** `done`。与现有原则冲突——本板连 blocker 都**不** gate `done`（`kanban.ts`：`done` 故意不设门禁，否则一个无关的 blocker 会变成没有出口的死路）。子卡同理，只会制造死路。

**建议 A**，另外给一个**软提示**：对还有未完成子卡的父卡执行 `done` 时，回复里附一句 `· 3/6 children still open`，让人知道自己收的是什么，但不阻止。

### 3.5 与现有规则的关系

| 规则                     | 与父子的关系                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `blockedBy` gate `doing` | **不变**，父子不产生阻塞。被阻塞的子卡可以属于某伞卡，二者独立                                                                                         |
| "exactly one doing"      | 不变。父卡和子卡都可以各自处于 doing，但伞卡有未完成子卡时**进不了** doing/review（q6）                                                                |
| `mine` / `openFor`       | 不变。子卡照常出现在 `mine` 里；伞卡是否出现取决于它的 assignee 和 state                                                                               |
| `done` 不设门禁          | 不变（见 3.4）                                                                                                                                         |
| 删除                     | 删父 → 所有子卡变顶层卡（`parent=null`），不级联删除；删子 → 从父的 `children` 移除，和删除卡时清理 `blockedBy`/`blocks` 同一套                        |
| 权限                     | 沿用 `assertCanModify`：挂父改的是**子卡**，所以要求子卡的 creator-or-assignee。是否同时要求父卡权限，见开放问题                                       |
| 项目                     | 子卡与父卡可以不同 project？建议**允许但不强制**，因为 project 过滤是分区，跨项目的子卡在父卡所在项目视图里看不见。是否要在挂父时提示/拒绝，见开放问题 |
| 优先级                   | 不变。伞卡自己的 priority 仍只影响它自己在列内的排序                                                                                                   |

## 4. 显示：需求的核心

"在卡片显示式表现出这层关系"——四个前门各有一种形式，但共享同一份派生数据。

### 4.1 CLI `ukb show`

```
#38 Complete Gala Selection 2.0 [someday]
assignee: —
...
children: 6 (4 done · 1 review · 1 todo)
  #601 [review] 1b 运行与工作流命令表面 + 内置最小预设
  #603 [review] 1a selection_apply
  #662 [todo]   1b-2 捞回：从剪枝断点补算
  #604 [review] 1c 复核台 Review Desk
  #602 [done]   2 暂别闭环
  #609 [done]   3 运行监视器 Run Monitor
```

（只列一层；`ukb show` 若要展示多层，再决定是否递归。）

子卡一侧：

```
#601 1b 运行与工作流命令表面 + 内置最小预设 [review]
...
parent: #38 Complete Gala Selection 2.0
```

### 4.2 CLI `ukb board --json --brief` 与 `ukb board`

- 每张卡多两个 brief 字段：`parent`、`children`（id 数组或计数 + done 计数）。
- 文本 `board`：子卡行尾加 `⤷#38`；父卡行尾加 `▸4/6`。**不**做缩进嵌套——子卡分散在不同列里，跨列缩进没有意义。

### 4.3 Web UI 抽屉

- 一张 `Sub-cards` 区域：进度条 `4/6` + 每个子卡一行（状态点 + 标题 + 点击打开）。
- 卡片上一个小 chip：`▸ 4/6`（父卡）或 `⤷ #38`（子卡）。
- 父卡抽屉里也可以直接"添加子卡"（输入 id）。

### 4.4 Pi overlay

- 伞卡行尾：`▸4/6`；其后紧跟它的子卡，**缩进一层**（每个子卡保留自己的 `[state][priority]` 和负责人）。
- 子卡不再在各自的状态组里重复出现（一张卡一行）；没有被显示的伞卡（state 被藏、或被 scope 过滤掉）的子卡仍作为顶层行，带 `⤷#38`。
- `▸` 的进度用**全部**子卡算（包括未显示的那些，比如默认隐藏的 `done`）。
- 面板有预算；子卡紧跟父卡，所以截断只会从尾部切，不会出现“有子卡没父卡”。

### 4.5 MCP

- `kanban_show` 返回里带 `parent` 和 `children`（含每张子卡的状态）。
- 新增 `kanban_parent` 工具（`{ id, parent }`），与 `kanban_block` 并列。

## 5. 实现影响面（动手时的清单）

| 文件                                                 | 需要改什么                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/types.ts`                         | `Card.parent`、`Card.children`、新增事件类型；`CardBrief` 相关                                                      |
| `packages/core/src/schemas.ts`                       | `ParentSetPayloadSchema` / `ParentClearedPayloadSchema`；`card.created` 加 `parent` 默认 null（旧日志兼容，纯加法） |
| `packages/core/src/projection.ts`                    | `card.parent_set/cleared` 处理；`link`/`unlink` 的父子版；删除时的清理；`childrenOf`、`progressOf` 派生             |
| `packages/core/src/kanban.ts`                        | `parent()` / `unparent()`、循环检测、权限、`assertTreeAcyclic`                                                      |
| CLI `render.ts` / `commands.ts`                      | `ukb show` 的 parent/children 段、board 行尾标记、`parent`/`unparent` 命令与 help                                   |
| MCP `server.ts` / `format.ts`                        | `kanban_parent`、`show` 字段、行尾标记                                                                              |
| `packages/server/src/routes/cards.ts` + `openapi.ts` | `POST /api/cards/:id/parent`、`DELETE …/parent`                                                                     |
| `packages/web/src/app.js`                            | 抽屉 Sub-cards 区、卡片 chip、i18n                                                                                  |
| `packages/pi/extensions/using-kanban/`               | overlay 行尾标记；tool 参数 `parent`                                                                                |
| `README.md` / `SKILL.md` / 本文件                    | 文档                                                                                                                |

**没有破坏性迁移**：这是纯新增的可选字段，旧事件用 `parent: null` 默认值即可，不像 `pending → someday` 那样需要先改数据。

## 6. 决定（已拍板）

1. 收尾语义 → **纯派生进度 + 软提示**，不自动 done；并在 `doing`/`review` 上加硬门禁（见 6）。
2. 动词 → **专用** `ukb parent <id> --of <parent>` + `ukb unparent <id>`。
3. 跨项目父子 → **允许**，不强制。
4. 权限 → **只要求子卡**的 creator-or-assignee（改的是子卡）。
5. 显示 → **board 用行尾标记（`⤷#38` / `▸4/6`），`ukb show` 递归写法**；但因模型只允许一层，递归实际止于一层。
6. 强制禁止 → **伞卡有未完成子卡时不能进 `doing`/`review`**（进入时拒绝，报错列出未完成子卡；也不能把一个已在 `doing`/`review` 的卡变成伞卡）。`done` 仍不设门禁。

补充约束：**父子只能一层**（不能无限递归）。已在 3.1 与引擎中强制。
