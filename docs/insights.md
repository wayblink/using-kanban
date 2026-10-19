# Insights — 看板的时间维度

> 状态：**已实现**（`#/insights`，`GET /api/insights`）。
>
> 一句话：**Events 回答"谁做了什么"（逐条流水），Insights 回答"事情在往前走吗"（聚合趋势）。**

## 1. 为什么不叫 Analysis / Dashboard

调研过的工作管理产品，分析页的命名有一条清晰的谱系：

| 名字         | 谁在用                  | 含义                                      |
| ------------ | ----------------------- | ----------------------------------------- |
| **Insights** | Linear、GitHub Projects | 对当前数据做分析、给结论                  |
| Reports      | Jira                    | 固定报表（burndown / velocity），偏产出物 |
| Dashboards   | Linear、Plane、monday   | 可自由拼装的 widget 画布                  |
| Analytics    | Plane                   | 全量数据面，范围更大                      |
| Pulse        | GitHub                  | 一段时间内的活动摘要，适合窄条            |

本页是固定面板、按时间段切、点击钻取——和 Linear / GitHub 的 Insights 同构。叫 Dashboard 会承诺一个我们没做的 widget 编辑器；叫 Analytics 比页面本身大。

`Board` 不改名：在 Jira / Linear / Plane / GitHub 里，board 是**视图**，不是容器；容器是 project，而这里的 project 只是卡片上的一个字段。把看板页叫 `Cards` 会把"东西是什么"和"怎么看它"混在一起。

## 2. 面板

1. **状态总数** — 五个状态的当前卡片数与占比。
2. **吞吐** — 每日完成 / 新建，叠加 7 日滑动平均；7 / 30 / 90 天切换。
3. **分项目 × 状态** — 横向堆叠条形，按活跃卡片数排序；点击跳到 `#/board?project=<slug>`。
4. **累积流图（CFD）** — 每日结束时各状态的卡片数，堆叠面积。WIP 膨胀、review 堆积一眼可见。
5. **瓶颈** — doing / review 里停留最久的卡片，以及本窗口完成卡片的周期时间（中位数 / P85），外加真正被阻塞的卡片数。

## 3. 数据从哪来

`GET /api/insights?days=30&tz=Asia%2FShanghai` 由 `packages/core/src/insights.ts` 的 `buildInsights()` 计算：

- **历史**（每日完成/新建、CFD、周期时间）来自事件日志的一次回放。`/api/log` 最多 500 条、按条数分页，90 天的板子不够用，所以聚合在服务端做。
- **当前**（状态总数、分项目）来自当前卡片，和 `/api/board` 的 `projects` 同源。
- **分日**按调用方传入的 IANA 时区，不是 UTC。事件 `ts` 是 UTC，晚上干的活算到前一天是错的。
- **完成口径**：按"到达 done 的卡片"计数，同一张卡同一天 done→reopen→done 只算一次；这和"当前 done 卡片数"是两个数。
- 被删除的卡片仍然参与历史回放（删除前的事件算数），但不进当前状态。

## 4. 取舍

- **一次全量回放**而不是增量缓存：这个规模的板（千级事件）单次请求是毫秒级，缓存带来的失效问题不值得。事件数到十万级时再考虑按日物化。
- **零依赖图表**：内联 SVG 手写，和整个 Web UI 的零构建一致，不引 chart 库。
- **不在 v1**：按 actor 拆分、90 天热力图、任意时间范围、可拼装的 widget。需要时再加，数据层已经够用。
