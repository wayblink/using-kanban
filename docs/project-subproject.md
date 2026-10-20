# Project and subproject — a repository, and a direction inside it

> 状态：**已实现**（core / server / CLI / MCP / Web / Pi overlay）。
>
> 一句话：`project` 是代码仓库名，`subproject` 是这个仓库里的方向。一条约定，两个字段，不是两层新的容器。

## 1. 为什么需要它

一块看板同时装着十个项目的卡片时，"项目"这个词同时干了两件事：

- 回答**这段工作属于哪个代码库**（仓库边界）；
- 回答**这段工作在推进哪个方向**（产品/技术方向）。

两者混在一起，要么一个仓库开成好几张"项目"（`civil-forest-kb`、`civil-forest-roadmap`…），要么一个项目里所有方向平铺，看板和统计都失去分区。分开之后：

```
project: civil-forest        ← repository
subproject: kb-foundation    ← direction inside it
```

卡片显示为 `civil-forest/kb-foundation`，筛选可以只按仓库，也可以再按方向。

## 2. 模型

- `Card.subproject: string | null`，与 `project` 相同的 slug 规则：小写，`[a-z0-9._-]`，≤64。
- **子项目必须挂在项目下**。没有 project 的 subproject 在四门都返回 `invalid_input`。
- **清空 project 会一并清空 subproject**。一个没有仓库的方向没有意义；把卡片换到另一个仓库也会丢掉旧方向（同一次编辑里显式给 `--subproject` 仍然生效）。
- 事件兼容：`card.created` 的 payload 新增 `subproject`，默认 `null`；旧日志回放不需要迁移。
- 当前状态、看板、筛选、卡片对话框、CLI/MCP 输出都读同一个字段。

## 3. 约束是"建议"，不是硬校验

`project` 必须使用仓库名——这是一条**约定**，不是服务端能验证的事实：看板是单机的，服务端不知道这台机器上有哪些仓库，也不知道这张卡属于哪个 checkout。硬校验需要一份仓库注册表，而它会把现有不是仓库名的项目（`civil-forest`、`iceberg-index`、`dozo`…）全部判非法。

所以：

- 约定写进 `ukb` help、MCP 工具描述、Docs 的 Concepts、README 和 agent skill；
- 不在服务端拒绝非仓库名；
- 不自动从 cwd 推断仓库名（v1）。`ukb add` 仍然只在你显式传 `--project` 时设置；
- 现有项目名保持不变；想迁移就逐张卡改，不需要一次性重命名。

如果以后要更硬的约束，合理的方向是 `ukb doctor` + 一份可选的仓库根目录配置，而不是改 schema。

## 4. 各门的形状

| 门         | 形状                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| core       | `add` / `edit` 接受 `subproject`；`board(project, subproject)` / `mine(...)` / `reviewQueue(...)` 过滤                   |
| HTTP       | `POST/PATCH` body 的 `subproject`；`GET /api/board?project=&subproject=`；`GET /api/cards?subproject=`                   |
| CLI        | `--subproject`（add/edit）、`board --subproject`、`mine --subproject`；`--project ""` / `--subproject ""` 清空           |
| MCP        | `kanban_add` / `kanban_edit` / `kanban_board` / `kanban_my_cards` / `kanban_review_queue` 都带 `subproject`              |
| Web        | 项目筛选后面的子项目筛选（级联）；卡片徽章 `web/auth`；卡片对话框与新建弹窗的字段；`#/board?project=web&subproject=auth` |
| Pi overlay | `scope=all` 时每行在 id 前显示 `project/subproject`；`group=project` 按 `project/sub` 分组                               |

## 5. 没做（刻意）

- **不按 subproject 拆 Insights**：项目面板仍按 project 聚合；要按方向拆，先看实际使用量。
- **不给 overlay 加 `scope=project:web/auth`**：`scope=all` 已经能看到方向，等有真实需求再加。
- **不做 cwd 自动推断**：在没有确认之前，自动填 project 会让"无项目"卡片变得很难创建。
