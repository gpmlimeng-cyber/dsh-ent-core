# CubeSandbox 后端接入方案：per-user 长期沙箱 + per-task 一次性沙箱

> 状态：**方案（未实施）** · 2026-10-11
> 基线：上游 `pointer-a/dsh-server-login @ 04bc832`（见 [FORK.md](../../FORK.md)）
> 前置：线上未回流的三段热修见 [panel-hotfix-reflow.md](../fork/panel-hotfix-reflow.md)

## 0. 依据与置信度（先声明哪些是读出来的、哪些是外部资料）

| 结论类别 | 来源 | 置信度 |
|---|---|---|
| 上游接缝：接口 / 表 / 路由 / 配置 / 测试范式 | **本仓源码逐行读**，下文逐条给出 `file:line` | 高（可复核） |
| CubeSandbox 能力：AutoPause/Resume、Volume、PVM、CubeEgress… | 其**官方 README / CHANGELOG / docs**（外部资料） | 中 —— **本仓未实测**，落地前必须以真机行为为准 |
| 本机资源是否够装 | 只读侦察（CPU/内存/盘/内核） | 高 |

**本文的每一条"CubeSandbox 会怎样"都必须在真机上复核一遍**；本方案把它们当作**待验证的假设**，并为每条假设写出验证方法（§13）。

---

## 1. 目标

在上游的 **server-login 控制面**之上，增加一套 **CubeSandbox 执行后端**，同时支持两种生命周期：

| | **per-user（长期沙箱）** | **per-task（一次性沙箱）** |
|---|---|---|
| 归属 | 一个注册用户一台 | 一个任务一次，**不属于任何用户** |
| 生命周期 | 创建一次 → **长期持有**（默认不销毁） | create → 用完 → destroy |
| 空闲时 | **AutoPause**（整机快照：内存+文件系统） | 不需要（本来就短命） |
| 唤醒 | 下一个请求触发 **AutoResume** | 不适用 |
| 工作区 | **持久 Volume**（用户的工作区） | 临时根 FS（+ 可选输入/输出卷） |
| 入口 | `<user>.<baseDomain>` 子域（现有路由） | 控制面 API（不进子域路由） |
| 复用上游接缝 | `Spawner` 接口 + `dsh_instances` 期望态 + `reconcile` | **不复用** `Spawner`（语义冲突，见 §6） |

一句话：**per-user 是把上游的"进程/Pod 后端"换成"沙箱后端"；per-task 是上游完全没有的新能力面。**

---

## 2. 上游已有的接缝（这是本方案成立的前提）

上游**本来就是可插拔生命周期后端**，不是"为 local 写死的"。精确坐标：

| 接缝 | 位置 | 现状 |
|---|---|---|
| 生命周期接口 | `src/supervisor/spawner.ts:69-80` | 8 个方法：`launch` / `restartMain` / `spawnWatchdog` / `status` / `endpointFor` / `stop` / `teardown` / `ensureFileService` |
| 实例状态类型 | `src/supervisor/spawner.ts:12`（`InstanceStatus`）**＋** `src/db/types.ts:71`（`DshInstanceStatus`，注释写明"mirrors the column's CHECK"） | **两个镜像**，都**没有 `paused`** |
| 后端选择 | `src/web/server.ts:64-68` | `config.deployMode === 'k8s' ? K8sSpawner : LocalSpawner` |
| 期望态表 | `src/db/schema.ts:59-72`（SQLite）/ `:145-158`（PG） | `dsh_instances`，含 `role` / `status` 两个 CHECK |
| 迁移机制 | `src/db/schema.ts:217-229`、`:232-253` | `MIGRATIONS` 数组 + `schema_migrations`，双引擎各一段 SQL |
| 收敛器 | `src/supervisor/reconcile.ts:43-170` | leader-only；informer 看护 + 每 10s tick |
| 收敛纯函数 | `src/supervisor/reconcile.ts:29-40` | `planReconcile(desired, live)` —— 无副作用、可单测 |
| **空闲回收** | `src/supervisor/reconcile.ts:131-140` | **`spawner.stop()` + `db.deleteInstance()`** ← 本方案的分水岭 |
| 会话判据 | `src/db/adapter.ts:45` `hasActiveSession`、`src/config.ts:39` `sessionTtlSeconds` | 回收由**会话过期**触发，不是"N 分钟无操作" |
| 文件面抽象 | `src/fs/provider.ts:33`、`src/fs/local-user-fs.ts`、`src/fs/k8s-user-fs.ts` | 控制面直摸卷 / 每用户 sidecar 两种实现 |
| 后端专属方法范式 | `src/supervisor/k8s-spawner.ts:292-344` | `setFencing` / `listUserPods` / `ensureUserResources` / `watchMainPods` / `logError` |
| **测试范式** | `test/k8s-spawner.test.mjs`（163 行） | **注入假客户端，不需要集群**（`k8s-spawner.ts:130-153` 的第 5 个可选参数就是为此留的） |

**结论**：加第三个后端 = 实现一个 `Spawner` + 改 4 处二值分支 + 一条迁移。**不是架构改造。**

---

## 3. 总体设计

```
浏览器
  └─ tls-gateway:443 ──> fastify 控制面 127.0.0.1:3080
                            ├─ proxy.ts ──> endpointFor(userId) ──> 沙箱节点:映射端口
                            ├─ userFs   ──> 〔文件面，见 §10〕
                            ├─ ReconcileController（leader）
                            │     ├─ 期望态缺失 → launch
                            │     ├─ 孤儿        → destroy
                            │     └─ 会话过期    → ★pause（不是 stop+删行）
                            └─ TaskSandboxService（新） ──> 一次性沙箱

控制面 ──(VPC 私网 / 走 CubeSandbox 控制面 API)──> CubeMaster / Cubelet（沙箱宿节点）
```

三个新件：

1. `src/sandbox/client.ts` —— **CubeSandbox 调用面抽象**（接口）
   `create / pause / resume / destroy / exec / info / ensureVolume` + 类型。
   `cubesandbox-client.ts`（真实：SDK 或 REST）+ `fake-client.ts`（测试）。
   **per-user 与 per-task 共用这一个抽象** —— 这是本方案最重要的一条结构决策。
2. `src/supervisor/cubesandbox-spawner.ts` —— `implements Spawner`，per-user。
3. `src/sandbox/task-service.ts` —— per-task，**不实现 `Spawner`**（理由见 §6）。

---

## 4. per-user：`Spawner` 8 方法 → CubeSandbox 动作

| 方法 | 动作 | 说明 |
|---|---|---|
| `launch(userId, folder, patch?)` | `client.create({template, volumes:[workspace], env, files:{patch}})` | `patch` 是**内容**（上游约定，见 `spawner.ts:64-67`）→ 写进沙箱内某个路径再由 `dsh --patch` 读 |
| `endpointFor(userId)` | 返回 **`{host: <宿节点>, port: <映射端口>}`** | k8s 那支本来就是跨机 DNS（`spawner.ts:61-62`）⇒ **跨机 endpoint 已被支持，proxy.ts 不用改** |
| **`stop(userId)`** | **`client.pause()`**，**不是 destroy** | 本方案的语义核心：会话过期 ≠ 销毁，是挂起 |
| `status(userId)` | `client.info()` → 映射到 `UserStatus` | 需要 `paused` 这个新状态（§7） |
| `restartMain(userId)` | 沙箱内重启 `dsh` 进程（**保住工作区与卷**） | 不要 destroy+create，否则用户状态全丢 |
| `spawnWatchdog(userId)` | 同沙箱内再起一个 headless 进程 | 上游语义一致（`k8s-spawner.ts:182-232`） |
| `ensureFileService(userId)` | **确保用户 Volume 存在并已挂载** | 上游为 k8s sidecar 留的方法，这里正好复用 |
| `teardown()` | 停/销毁本后端持有的全部沙箱 | — |

**构造签名照抄 k8s 那支的依赖注入**（`k8s-spawner.ts:130-153`）：

```ts
constructor(config, db, resolveApiKey, resolveUid, client?: SandboxClient)
```

第 5 个可选参数 = 测试注入假客户端，**不需要真沙箱就能跑单测**。

**不需要的东西（沙箱模式下的简化）**：`--isolation-mode account`（`setpriv` 降权）、`src/supervisor/firewall.ts` 的 iptables 规则、`resolveUid` / `baseUid` / `hashUid` 那套每用户 uid 分配 —— **沙箱本身就是硬件级隔离边界**，再降权是多余的。`resolveUid` 可直接返回常量（如 1000）。这是一条**减法**，应显式写进验收清单，避免"照抄 local 分支把无关机制一起带进来"。

---

## 5. `deployMode` 的第三个值会踩到 4 处"二值假设"（必须逐个复核）

`deployMode` 现状是 `'local' | 'k8s'`（`src/config.ts:61,198-199`）。加 `'cubesandbox'` 后，所有 `=== 'k8s'` / `=== 'local'` 的地方都会**静默走到 else 分支**：

| 位置 | 现状含义 | 加第三值后的行为（改前预判） | 要做的事 | **P2 实做** |
|---|---|---|---|---|
| `src/web/server.ts:64-68` | 选后端 | 掉进 `LocalSpawner` | 加第三分支（显式） | ✅ 加了第三分支；客户端从 `createSandboxClient()` 取（P3 前抛异常，见下） |
| `src/cli.ts:144-147` | `k8s` 才建 `ReconcileController` | **不再建收敛器** → 没有 AutoPause/回收 | **必须把 cubesandbox 也纳入** | ✅ 纳入；并把原来的裸转换 `as K8sSpawner` 换成运行时能力检查 `isSupervisedSpawner()` |
| `src/supervisor/proxy.ts:206,217` | 传 `deployMode === 'local'` 给 `proxyHttp` | 变 `false`（表现同 k8s） | **复核该布尔的真实含义**，必要时改成显式枚举 | ✅ **复核后确认不动**：该布尔的语义是"endpoint 是回环地址"（决定要不要把 `127.0.0.1` 的 Location 改写成真实 origin）。沙箱 endpoint 是**沙箱节点**的 `host:port`，永远不是回环 ⇒ 与 k8s 同值 `false` 恰好正确。改它是为零收益而动线上代理路径 |
| `src/fs/provider.ts:33` | 选 `UserFs` 实现 | 掉进 local 分支（控制面直摸卷）| 新增 cubesandbox 分支（§10） | ⚠️ **改为响亮失败**：控制面不持有用户卷，掉进 `LocalUserFs` 会**静默服务错的那块盘**（控制面本地空目录）⇒ 抛错而不是猜。真实现属 P3/§10 |

> **两处"配了就崩"是刻意的**：`createSandboxClient()`（`src/sandbox/provider.ts`）与 `createUserFs()` 的 cubesandbox 分支都是 P3 的接缝，在 P3 之前**故意抛异常并说明是哪个阶段**。理由与 P1 把 client 设成必填构造参数一致：宁可启动即失败，也不要让"编译得过、部署必错"成为可能。`local`/`k8s` 两条路径行为零变化（有回归锁）。

> 另外：**DB 后端不是由 `deployMode` 选的**，而是由 `DSH_SERVER_LOGIN_DB_URL` 是否存在决定（`src/db/adapter.ts:4`、`src/db/sqlite.ts:4`）。决策点：单控制面 + 沙箱 → SQLite 够用；多副本控制面 → 必须 PG（`pg.ts` 还兼作 leader 选举/单飞）。

---

## 6. per-task：为什么**不**塞进 `Spawner`

`Spawner` 的每个方法都以 `userId` 为键，且 `dsh_instances` 存的是**每用户期望态**（`types.ts:75` 注释原文："desired state the k8s controller reconciles against"）。把一次性任务塞进去会立刻打架：

- `planReconcile`（`reconcile.ts:29-40`）会把"有 Pod、无期望行"当**孤儿销毁**（`:115-121`），把"有期望行、无 Pod"当**缺失拉起**（`:122-125`）——一次性任务两种都会被误伤；
- 空闲回收（`:131-140`）基于**用户会话**判断，与任务的生命周期无关；
- `hasActiveSession(userId)` 对一个不属于任何用户的任务没有意义。

**所以 per-task 走独立面**：

```
新增表 task_sandboxes（id, owner_user_id?, status, sandbox_id, node, created_at, expires_at, …）
新增 src/sandbox/task-service.ts   —— create / exec / destroy / 超时回收
新增路由 src/web/routes/sandbox.ts —— 控制面 API（凭据校验沿用现有 session 中间件）
```

**共用部分**：两者都只调 `SandboxClient`，差异**仅在生命周期策略**（谁决定 destroy、要不要绑 userId、空闲怎么处理）。把这条差异收敛在 service 层，别让它渗进 `Spawner`。

**`owner_user_id` 建议保留但可为空**：既能给"用户发起的任务"做归属（配额/审计），又不强迫任务必须是某人的。

---

## 7. 数据库迁移 v5（两条引擎都改，别只改一条）

> **✅ P2 已落地。** 实做与本文的一处偏离：**只加 `paused`，没有加 `sandbox_id` / `node` / `paused_at` 三列**。理由是本文"建议加新列"的隐含前提（"反正要重建表，一次做完"）不成立 —— SQLite 只有**改 CHECK** 必须重建，**加列是普通 `ALTER TABLE ADD COLUMN`**（v2/v3/v4 都是这么加的），所以现在加将来加一样便宜，而少三列就少三处类型/映射/两条 SQL 的改动面。`sandbox_id`/`node` 的真实形态要等 P4（per-task）决定沙箱命名是否还保持确定性推导（现为 `dsh-<userId>`）。（`paused_at` 若要做可观测性，另开一刀。）

`status` 的 CHECK 在**两处**重复（`schema.ts:67` SQLite、`:153` PG），加 `paused` 必须都改；新列建议 `sandbox_id` / `node` / `paused_at`。

```ts
// src/db/schema.ts —— MIGRATIONS 追加（当前到 version 4，见 :224-229）
{ version: 5, name: 'sandbox lifecycle state', sqlite: SQLITE_V5, pg: PG_V5 }
```

**PG 侧**（CHECK 是建表时内联的，PG 会自动命名为 `dsh_instances_status_check`）：

```sql
ALTER TABLE dsh_instances DROP CONSTRAINT dsh_instances_status_check;
ALTER TABLE dsh_instances ADD CONSTRAINT dsh_instances_status_check
  CHECK (status IN ('starting','running','crashed','repairing','stopped','paused'));
ALTER TABLE dsh_instances ADD COLUMN sandbox_id TEXT;
ALTER TABLE dsh_instances ADD COLUMN node TEXT;
ALTER TABLE dsh_instances ADD COLUMN paused_at BIGINT;
```

**SQLite 侧是真坑**：SQLite **无法 ALTER 一个 CHECK**，必须走"建新表→拷数据→删旧表→改名"重建（12 步）。两点注意：

1. 没有任何表外键引用 `dsh_instances`（它是引用方，不是被引用方）⇒ 重建对其它表无副作用；
2. `runSqliteMigrations` 是在**一个事务里** `db.exec(migration.sqlite)`（`schema.ts:242-251`）⇒ 迁移 SQL 里**不能依赖 `PRAGMA foreign_keys=off`**（事务内是 no-op）。

> 可接受的简化替代：**直接去掉这条 CHECK**，状态校验交给 TS 联合类型。代价是丢一层 DB 级兜底 —— 本仓代码全部经 `InstanceStatus` 类型（`spawner.ts:12`），所以这个替代在工程上是站得住的。**两条路都可行，建议走重建**（有 `test/db.test.mjs` 可验证），并在提交信息里写明取舍。

**`paused` 的连带影响：4 处"状态定义"必须同时改，漏一处就是运行期不一致**

| # | 位置 | 形态 |
|---|---|---|
| 1 | `src/supervisor/spawner.ts:12` | `InstanceStatus` 联合类型 |
| 2 | `src/db/types.ts:71` | `DshInstanceStatus` **镜像**（`types.ts:73-76` 说明它 mirror 列的 CHECK）—— **最容易漏的一处** |
| 3 | `src/db/schema.ts:67` | SQLite `dsh_instances.status` CHECK |
| 4 | `src/db/schema.ts:153` | PG `dsh_instances.status` CHECK |

再往下是**消费点**：`reconcile` 的缺失判断（§9 第 1 条）、`src/db/repo.ts` 的状态写入、`src/web/routes/desktop.ts` 的状态展示、以及前端对状态的文案。这是本方案里最容易漏的一整类改动。

---

## 8. `reconcile` 现在是**硬绑 k8s** 的（上游的第二个欠缺）

> **✅ P2 已落地，按本文建议的第 2 种（抽出 `SupervisedSpawner`）。** 实做补充三点：
> 1. `SupervisedSpawner` 多了一个成员 `idlePolicy`（§9 的开关）——由**后端**回答"空闲该不该保留期望行"，控制器只读它，不认 `deployMode`。
> 2. `watchMainPods` 的返回类型不是 k8s 的 `Informer`，而是一个结构性最小的 `LiveWatcher { start(); stop() }` ——否则共享模块还得 import 集群客户端，等于把同一个类型泄漏换个地方。k8s 的 `Informer` 天然满足它。
> 3. `ReconcileController` 里那句**裸转换** `app.supervisor as K8sSpawner`（`cli.ts`）换成了运行时能力检查 `isSupervisedSpawner()`：`buildServer` 交回的是 `Spawner`，将来若新增一个 deploy mode 忘了提供受监督实现，必须在**启动时**报错，而不是在第一次 tick 里以 TypeError 现形。
>
> 沙箱侧的 `watchMainPods` 用**轮询适配器**（`watchIntervalMs` 已是配置字段，默认 10s）。它每次轮询都对所有受管沙箱发一次事件，比 informer 冗余 —— 这是**安全的**，因为崩溃路径本身有 `watchdogFired` 去重（重复事件不会拉起第二个 watchdog，健康事件是空操作），而且轮询失败只记日志、下一轮继续（对不上时 tick 仍会收敛）。

`ReconcileController` 的构造函数（`reconcile.ts:50-56`）**收的是具体类 `K8sSpawner`**，不是 `Spawner` 接口，并且 tick 里直接用了 5 个 k8s 专属成员：

```
setFencing(fencing)          // leader 切换时设栅栏
startInformer/watchMainPods  // Pod informer（崩溃看护）
listUserPods()               // 期望态 vs live 的 live 侧
ensureUserResources(userId)  // 重建丢失的 Service/NetworkPolicy
logError(err)
```

三种选择，**建议第 2 种**：

| 方案 | 做法 | 代价 |
|---|---|---|
| 1 | 给 `Spawner` 接口直接加这 5 个方法 | 污染接口；`LocalSpawner` 也得实现或抛异常 |
| **2（建议）** | 抽出**可选**接口 `SupervisedSpawner`（上述 5 个成员），`ReconcileController` 依赖它，`K8sSpawner`/`CubesandboxSpawner` 各自实现；Cube 侧的 `watchMainPods` 用**轮询适配器**实现（它没有 informer） | 一处接口调整 + 一次纯重构，有 `leader.test.mjs` / `k8s-spawner.test.mjs` 兜底 |
| 3 | 给 Cube 写一个独立 controller | 收敛逻辑（期望态/孤儿/崩溃修复）**复制一份**，长期双维护 |

★ **`planReconcile` 那个纯函数（`:29-40`）两种后端都能直接用** —— 它是"期望 main 行 vs live 列表"，与实现无关，是本仓设计得最好的一处接缝，应原样复用。

---

## 9. 分水岭：把"回收"从 destroy 改成 pause（`reconcile.ts:131-140`）

现状（原文）：

```ts
// Idle reap (Phase 4): a desired main whose user has no active session has
// outlived its session TTL — stop the Pod and drop the desired row so the
// next tick does not relaunch it.
for (const instance of desired) {
  await this.safe(`reap ${instance.userId}`, async () => {
    if (await this.db.hasActiveSession(instance.userId)) return
    await this.spawner.stop(instance.userId)
    await this.db.deleteInstance(instance.id)     // ← 期望态被删掉
  })
}
```

**这段是"一次性消费"与"长期持有"的唯一分界线**：删掉期望行 ⇒ 下次根本不拉起 ⇒ 用户回来是冷启动、状态全丢。

改为（cubesandbox 模式）：

```ts
if (await this.db.hasActiveSession(instance.userId)) {
  // 会话回来了 → 若曾被挂起，唤醒
  await this.spawner.resume?.(instance.userId)
  return
}
await this.spawner.stop(instance.userId)   // = pause（整机快照）
await this.db.markPaused(instance.id)      // ★ 期望行【保留】，只改状态
```

连带三件事：
1. `planReconcile` 必须把 **`paused` 的期望行仍算作"应当存在"**，否则下一个 tick 会把它当缺失去 `launch`（重复创建）；
2. `endpointFor` 在 `paused` 状态下返回的地址，**语义变成"唤醒后可用的地址"**（proxy 的请求会阻塞到 AutoResume 完成 —— 需要确认 `proxy.ts` 的 `proxy_read_timeout` 与上游超时是否够长）；
3. **首次访问的唤醒延迟必须实测**（这是用户可感知的：点开页面等几秒）。若实测过长，需要在 UI 上给"正在唤醒"状态。

> **✅ P2 已落地。** 实做取的是"后端自答"而不是"看 `deployMode`"：新增 `IdlePolicy = 'release' | 'retain'`，`K8sSpawner` 报 `release`，`CubesandboxSpawner` 报 `retain`，控制器据此决定 `deleteInstance` 还是 `setInstanceStatus(id,'paused')`。三种路径都有回归锁（`test/reconcile.test.mjs`，含"k8s 行为不变"那一条）。
>
> 本文原案里的 `spawner.resume?.(userId)` **没有采纳**：沙箱平台的 AutoResume 是数据面触发的（用户下一个请求本身就会唤醒它），控制面再发一次 resume 是多余的网络往返，且会把唤醒延迟叠加一倍。控制面改为**只观察**：`planReconcile` 新增 `markRunning` —— 一个 `paused` 行若被观察到**已在 running**，说明它被（平台的）AutoResume 唤醒了，就把行记回 `running`。没有这一步 `paused` 会变成**粘性状态**：唤醒后再也不会被回收。观察发生在回收之后，所以"本轮记回 running、下一轮用户已离线时再挂起"是收敛的。
>
> 两个实现细节值得记：① 回收循环对**已经是 `paused` 的行直接跳过**，否则每个 tick 都会重复写一次同一状态（有测试锁"写次数恰为 1"）；② 行状态**不在请求路径上** —— proxy 只调 `endpointFor()`，从不读 `dsh_instances`，所以即使行状态短暂滞后也不会挡用户。

---

## 10. 存储与文件面

| | per-user | per-task |
|---|---|---|
| 用户工作区 | **CubeSandbox Volume**（v0.6 框架，独立生命周期、可跨沙箱共享、可只读挂载、删除有引用计数保护） | 不需要（临时根 FS） |
| 输入/产物 | 同上 | 可选挂一个卷做传入/取出 |
| 与上游 `UserFs` 对接 | 新增 `src/fs/cubesandbox-user-fs.ts`，**照 k8s sidecar 范式**（`k8s-user-fs.ts`）：沙箱内跑文件服务，控制面走 `ensureFileService` | 不需要 |
| **不要用 raw host mount** | 上游卷框架明确：**raw host mount 会把快照钉在原节点**（跨节点恢复失败、快照不含它）；plugin Volume 不钉 | — |

`ensureFileService` 这个方法在上游是为 k8s sidecar 留的（`spawner.ts:77-79` 注释），**在 Cube 后端正好第二次用上** —— 又一个"上游设计已经预见到"的证据。

> **⚠️ P2 状态：文件面还没落地，而且被改成响亮失败。** P2 给 `ensureFileService`/`ensureUserResources`（= 确保卷存在）写了实现，但 **`UserFs` 本身还没有**：`createUserFs()` 遇到 `cubesandbox` **抛错**，而不是掉进 `LocalUserFs`。原因是这条 fallback 是**静默错误**：控制面不持有用户卷（与 k8s 同理），`LocalUserFs` 会去读 `dataRoot/users/<id>` —— 那里是空的，用户会看到"文件全没了"，而不是一个错误。真正的 `SandboxUserFs`（照 `k8s-user-fs.ts` 的范式，走 client 的文件 API）属 P3，与真实客户端同一刀，因为**它也需要那个客户端**。

---

## 11. 凭据：CubeEgress 注入（Phase 3，属产品决策，不进第一刀）

上游现状：`credential_vault` 加密存 `secret_ref` → `resolveApiKey(userId)` → 注入成 `DEEPSEEK_API_KEY`（`server.ts:51-59`；k8s 侧落成 Secret，本地侧落成环境变量）。

CubeEgress 的做法是**L7 代理按域注入凭据，密钥对沙箱代码不可见**。若采用，则：

- `resolveApiKey` 可以返回 `null`（沙箱里不放 key），凭据改由**每沙箱的 egress 策略**绑定；
- 好处：**你现在最脆的一环（每个用户自己的 `.credentials.yaml` / `credential_vault` 明文可解）不再进沙箱**；
- 代价：**按用户归因/计费要在 egress 策略层做**；多 provider 自助配置（已知产品缺口）要考虑怎么表达成策略。

**建议：第一刀不做。** 先让 `resolveApiKey` 原样注入（即 Cube 后端沿用现有凭据链），把 egress 注入列为独立一刀，因为它改变的是**产品语义**（谁持有密钥），不只是实现。

---

## 12. 网络与端口（结论：**不要停 80/443**）

链路：

```
用户浏览器 ──443──> tls-gateway 容器 ──> 控制面 127.0.0.1:3080 ──proxy.ts──> endpointFor()
                                                                              └─> 沙箱节点:映射端口
```

- **沙箱不需要任何公网端口** —— 入口已经是控制面（子域路由）。所以"停 80 释放给沙箱"**不需要做**；而且生产箱的 80 只在跑 **ACME http-01** 证书续期（tls-gateway 配置里写明"绝不能跟着跳转，否则证书无法续期"）⇒ **停它 = 证书续期断**。
- CubeProxy 的 HTTP/HTTPS 端口默认值会占 80/443 ⇒ **只在"装到生产箱上"才冲突**。**装到独立 CVM ⇒ 冲突不存在**；即便如此也应显式改掉默认端口，并在安全组**不对外开放**这两个端口。
- 控制面 → 沙箱宿节点：走 **VPC 私网**（同地域内网），不要走公网。
- 两条方向别搞混：控制面**主动连沙箱**（inbound）需要**端口映射**（宿主侧端口由 Cubelet 从固定区间自动分配，**不可指定**）；沙箱**主动连宿主服务**（outbound）走它的 **host-service BPF shortcut**。若将来要让沙箱内的 agent 调控制面 API，走后者。

---

## 13. 测试与验收（合上"未实测"这个缺口）

**能立刻做的（不需要真沙箱）——照 `test/k8s-spawner.test.mjs` 的范式：**

1. `test/cubesandbox-spawner.test.mjs`：假 `SandboxClient`，覆盖 `AlreadyRunningError`、pause 幂等、`endpointFor` 映射、`ensureFileService` 幂等、`teardown` 全清；
2. `test/task-sandbox.test.mjs`：create→exec→destroy、超时回收、owner 可空；
3. `test/reconcile.test.mjs`：`planReconcile` 对 **`paused` 行不得判为缺失**（这是 §9 的回退锁）；`stop` 后**期望行必须还在**； 　**✅ P2 已写（12 条）**，并且不止纯函数：用假 elector + 假受监督 spawner 真把控制器跑起来，分别断言 `retain`（保留并标记）与 `release`（删除，k8s 不变）；
4. `test/db.test.mjs` 扩：迁移 v5 在 **SQLite 与 PG 两侧**都能把旧库升上来（含 `paused` 可写）。 　**⚠️ 只写了测试，本机跑不了**：见下。

> **P2 的 SQLite 侧另有真引擎验证（补上本机跑不了 `test/db.test.mjs` 的缺口）**：本机 `better-sqlite3` 无 android-arm64 绑定，但 Node 24 自带 `node:sqlite`。于是把 **`lib/db/schema.js` 里那五段 SQLite 迁移原文抽出来**（抽取，不是复制）喂给真 SQLite，验四件事：
> - **A. 阳性对照**：v1..v4 确实**拒绝** `paused`（证明"是 v5 打开了这个值"，而不是它本来就允许）；
> - **B.** 全新库跑到 v5：6 个状态全接受、`'bogus'` 仍被拒、不留 `dsh_instances_v5` 残表；
> - **C.** 带数据的旧库：`SELECT *` 逐字段与重建前**完全相同**（含 v4 加的 `patch`），`paused` 可写，且 `REFERENCES users(id)` **仍然生效**（插孤儿行报 FOREIGN KEY）；
> - **D.** 重入性：连做两次 v5 仍只剩 1 行且值未变（真跑两次不会丢数据）。
>
> **PG 侧仍未验证**（本机无 PG、无 Docker）：`DO $$ … pg_constraint … %I … $$` 那段只经过人工复核。两处要留意：① 它依赖"无参数多语句"走 pg 的 simple-query 路径（既有迁移本来就是这条路）；② 用 `conname LIKE '%status%'` **按名查找**而非硬编码 `dsh_instances_status_check`，是为了避免"猜错名字 ⇒ 旧约束仍在 ⇒ 新约束形同虚设"。**首次在有 PG 的环境跑迁移时必须人看一眼**。

**必须在真机核（每条都是对一个外部假设的验证）：**

| # | 假设 | 验证方法 |
|---|---|---|
| 1 | AutoPause 真能存"整机内存+文件系统" | 挂起 → 重启宿节点 → 唤醒 → 会话/进程内状态仍在 |
| 2 | AutoResume 时数据面请求会阻塞到恢复完成 | 计时首次访问延迟，与 `proxy.ts` 超时对比 |
| 3 | `paused_resource_release_ratio` 默认 0（挂起不释放配额） | 挂起 N 台后看宿节点配额占用是否不变 |
| 4 | Volume 语义（跨沙箱共享、只读挂载、删不掉的引用计数） | 建卷→挂两沙箱→只读挂其中一个 |
| 5 | 端口映射区间与自动分配行为 | 建多个沙箱看宿主端口 |
| 6 | 沙箱 → 宿主服务 shortcut 是否真通 | 沙箱内 curl 控制面 API |
| 7 | 跨节点 pause/resume（preview）是否可用 | 挂起后能否在另一节点恢复 |
| 8 | **`list` 是否包含 `paused` 沙箱**（P2 新发现的前提） | 挂起一台 → `list()` 看它还在不在。**若不在**，`planReconcile` 每 tick 都会把该用户判为"缺失"并 `launch` —— 好在 `launch` 先查 `info`，会 `resume` 而不是**再建一台**，所以后果是多余往返而非重复沙箱（这一点已写在 `listUserPods` 的注释里）。真机读数决定要不要给 `list` 加一个显式状态过滤参数 |
| 9 | 沙箱 API 的错误形状（404 vs 403 vs 传输失败） | 造一个不存在的 id、用坏 key、断网，三种各看一次 —— `SandboxClient.info` 的"缺席 ≠ 失败"纪律（P1 的 `SandboxNotFoundError`）依赖它 |

**资源前提（已侦察，不满足则 §13 全部做不了）**：官方最低 **4 核 / 8 GB / ≥50 GB XFS 数据盘**（PVM 路线**不需要 `/dev/kvm`**，但**要换内核并重启**）。现有生产机 2 核 / 3.6 GB / 剩 9.3 GB 且**单盘单分区** ⇒ **不满足**，且换内核会降级到 6.6.117（现为 6.6.119）。**结论：另开一台 CVM 专门跑沙箱，控制面继续留在生产机** —— 也正好就是本文的网络形态。

---

## 14. 分阶段落地

| 阶段 | 内容 | 前置 | 产出（可验证） |
|---|---|---|---|
| **P0** | 把线上未回流的三段热修（token / WS / panel-host）回流进 `src/` | 需要能构建的环境（本机缺原生依赖，建议服务器 Node 24） | `tsc` + `node --test` 全绿；[panel-hotfix-reflow.md](../fork/panel-hotfix-reflow.md) 作对照 |
| **P1** | `SandboxClient` 抽象 + `fake-client` + `cubesandbox-spawner` + 单测 | 无（不需要真沙箱） | §13 的 1、3 组测试全绿 |
| **P2** | `reconcile` 抽出 `SupervisedSpawner`；`deployMode` 加 `'cubesandbox'`；迁移 v5 | P1 | §13 的 3、4 组测试全绿；`local`/`k8s` 行为零变化 —— **✅ 已完成（见 §17）** |
| **P3** | 真机打通：模板（dsh 装进镜像）+ Volume + AutoPause/Resume | 新 CVM（PVM 内核） | §13 的 7 条真机假设逐条出读数 |
| **P4** | per-task 面（表 + service + 路由） | P1 的 client 抽象 | `test/task-sandbox.test.mjs` |
| **P5** | CubeEgress 凭据注入（产品决策，可延后/可取消） | P3 | 沙箱内无密钥仍能调模型 |

**P1/P2 在现有机器上现在就能做完并测完**（全部是假客户端单测）—— 这是本方案最划算的一点：**不等硬件就能把 80% 的代码与门禁落地**。

---

## 15. 风险与未决项

**风险**

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | CubeSandbox 能力描述来自文档、**未实测** | 方案可能建立在错误前提上 | §13 的真机验证清单；P1/P2 全部用假客户端，**不提前依赖外部行为** |
| 2 | 跨节点 pause/resume 仍是 **preview** | 用户会话钉在节点上，节点故障即会话不可用 | 单节点起步；共享存储（S3/MinIO）准备好再谈跨节点 |
| 3 | 沙箱**故障自愈**（崩溃 VM / 卡住的 shim）在 roadmap 上**尚未提供** | 长驻沙箱集群最怕这个 | `reconcile` 的期望态收敛是天然兜底（`planReconcile` 已能重建缺失实例） |
| 4 | 唤醒延迟为用户可感知 | 体验 | P3 实测 + UI 上加"正在唤醒" |
| 5 | SQLite CHECK 重建有操作风险 | 迁移失败 | `test/db.test.mjs` 覆盖双引擎；或走"去 CHECK"简化 |
| 6 | `deployMode` 第三值踩到 4 处二值分支（§5） | 静默错分支 | 显式改成枚举分支 + 对每处加断言/测试 |

**未决（需要产品裁决，不是技术问题）**

1. **per-task 沙箱谁可用**：仅管理员 / 所有登录用户 / 也允许匿名？（决定配额与滥用面）
2. **per-user 空闲多久挂起**：沿用现有 `sessionTtlSeconds` 会话过期语义，还是引入独立的"无操作 N 分钟"计时器？（现在是前者，见 `reconcile.ts:136`）
3. **挂起配额释放比**（`paused_resource_release_ratio`）：默认不释放更稳、密度低；调到 1 则密度高但唤醒可能撞容量上限（409）。
4. **模板策略**：dsh 版本进模板 ⇒ 每次升级 dsh 都要重建模板并重新分发；是否接受？
5. **per-task 的产物怎么取出**：走 Volume 还是走 API 回传？
6. **SQLite 还是 PG**（§5 末）：单控制面够用 vs 多副本必须 PG。

---

## 16. 本方案对上游的三条改动原则

1. **不改语义，只加分支**：`local` / `k8s` 两条既有路径的行为必须**零变化**（用现有 3 个测试文件当回归锁：`k8s-spawner.test.mjs`、`leader.test.mjs`、`local-user-fs.test.mjs`）。
2. **接口改动集中在 `spawner.ts` 一处**，并把"哪些成员是可选的后端专属能力"写进注释（现在这个区分是靠 `k8s-spawner.ts` 的类型泄漏隐含的）。
3. **外部依赖（CubeSandbox）一律经过 `SandboxClient` 接口**，绝不在 `Spawner` 实现里直接 import SDK —— 否则单测就必须有真沙箱，P1/P2 也就做不成了。

---

## 附：顺带记录的两处仓内既有问题（本方案不修，只登记）

1. **文档漂移（规模比预想大）**：`src/` 里 **26 处**引用 `docs/k8s.md` 的章节（`§4.3/§4.4/§4.8/§4.9/§4.10/§5.1/§5.2/§5.4/§5.7/§5.8/§6.0-1`），但 **`docs/k8s.md` 不存在** —— 实际文件是 `docs/k8s-deploy.md`（20.9 KB）与 `docs/k8s-deployment.md`（6.5 KB）两个名字相近的文档。⇒ 读这些注释的人**永远找不到**对应章节；要么补一份 `docs/k8s.md`，要么把这 26 处指向真文件。
2. **`reconcile.ts` 的类型泄漏**：构造函数（`:50-56`）与成员（`:52`）声明的是具体类 `K8sSpawner` 而非接口 —— 这是 §8 那个改动要处理的根因。

---

## 17. 实施记录

### P1（已完成）

| 文件 | 内容 |
|---|---|
| `src/sandbox/client.ts` | `SandboxClient` 接口 + 类型 + `SandboxNotFoundError`。**"缺席"与"失败"分离**（照 k8s 的 404/403 纪律：`info()` 只在真不存在时返回 `undefined`，其余失败照抛） |
| `src/sandbox/fake-client.ts` | 内存假客户端：可注入失败、可强制状态、记录每次 exec —— 单测与本地 dry-run 共用 |
| `src/supervisor/cubesandbox-spawner.ts` | `implements Spawner` 的 8 个方法 |
| `src/config.ts` | 新增 `CubeSandboxConfig` + `resolveCubeSandboxConfig`（**只加配置字段，`deployMode` 第三值仍留 P2**） |
| `test/cubesandbox-spawner.test.mjs` | 17 条 |

**与本文方案的四处有意偏离**（都有代码注释 + 测试钉住）：

1. **`SandboxClient` 是必填构造参数，不是可选第 5 参。** 方案 §4 设想"可选 + 默认真实客户端"，但真实客户端是 P3 才有的事物 ⇒ 给它一个会抛异常或装假的默认值，等于让"编译通过、部署必炸"成为可能。必填参数把"必须提供真客户端"变成类型约束。
2. **不接收 `resolveUid`**：把 §4 那条减法落到签名上 —— 沙箱即隔离边界，不需要每用户 uid。
3. **`paused` 在 P1 上报为 `'stopped'`**：`paused` 尚未进 `InstanceStatus` 与两条 CHECK（§7 要求四处同时改），而 P1 从不把该状态写进 DB，所以先做保收缩映射；**P2 迁移后必须翻转**（测试名已写明这一点）。
4. **接口比 §3 的 7 个方法多两个**：`list`（`teardown` 与 P2 的 live 侧都需要"本后端持有的一切"）、`exec` 的 `background` 选项（dsh 是常驻进程，必须能分离启动）。

**验收读数**（本机 Node v24.18.0）：

```
tsc -p tsconfig.json      → 0 错
test/cubesandbox-spawner  → 17/17 通过（含 "--patch 必须在 --host 之前" 的 argv 锁）
test/k8s-spawner          →  7/7 通过   ← 回归锁
test/leader               →  6/6 通过   ← 回归锁
test/local-user-fs        →  5/5 通过   ← 回归锁
test/db                   →  本机不可运行（见下）
```

**两处环境限制（与本刀无关，如实记录）**：

- `test/db.test.mjs` 需要 `better-sqlite3` 的原生绑定，本机（android-arm64）没有对应预编译产物 ⇒ 13 条全红。须在 Linux/Node 24 上跑。
- 本机 `node --test <file>` 一律失败（子进程报 `expected absolute path: "--test-concurrency=0"`）——**未改动的上游测试文件同样失败**（`local-user-fs.test.mjs` 直跑 5/5、`--test` 直报错）。故测试改为 `node test/<file>.test.mjs` 逐个直跑：等价，且每条都真正执行了。

**顺带发现的一个上游缺陷（本刀未修，建议另开一刀）**：`k8s-spawner.ts:411` 的 `args.splice(1, 0, '--patch', …)` 把 `--patch` 插到了 `--profile` 与它的值 `web` **之间**，而 `orchestrator.ts:166-171` 的注释恰好写明这条规则（`--patch` 必须在 `--host`/`--port` 之前、`--profile <name>` 之后）。k8s 分支从未实机跑过，所以一直没暴露。修法一行：`splice(1` → `splice(2`。


### P2（已完成）

| 文件 | 内容 |
|---|---|
| `src/supervisor/spawner.ts` | `InstanceStatus` 加 `'paused'`；新增 `IdlePolicy`、`LiveWatcher`、`SupervisedSpawner`、`isSupervisedSpawner()` |
| `src/supervisor/reconcile.ts` | 依赖 `SupervisedSpawner`（不再是具体类 `K8sSpawner`）；`planReconcile` 认 `paused` 并新增 `markRunning`；空闲回收按 `idlePolicy` 分岔；**去掉最后一条 k8s import** |
| `src/db/types.ts` | `DshInstanceStatus` 镜像加 `'paused'`（§7 表里"最容易漏的一处"） |
| `src/db/schema.ts` | 迁移 **v5**：SQLite 重建表 / PG 按名换约束 |
| `src/supervisor/k8s-spawner.ts` | `implements SupervisedSpawner` + `idlePolicy = 'release'` |
| `src/supervisor/cubesandbox-spawner.ts` | `implements SupervisedSpawner`；`idlePolicy = 'retain'`；`paused → 'paused'`；`listLiveInstances` → `listUserPods`；新增 `ensureUserResources` / 轮询 `watchMainPods` / `setFencing`（栅栏标签） |
| `src/config.ts` | `DeployMode` 加 `'cubesandbox'`；`CubeSandboxConfig.watchIntervalMs` |
| `src/sandbox/provider.ts`（新） | `createSandboxClient()` —— **P3 的接缝，现在抛异常** |
| `src/web/server.ts` / `src/cli.ts` | 第三分支；`as K8sSpawner` 换成 `isSupervisedSpawner()` |
| `src/fs/provider.ts` | cubesandbox 分支**响亮失败**（不静默摸错盘） |
| `test/reconcile.test.mjs`（新） | 12 条 |
| `test/cubesandbox-spawner.test.mjs` | 17 → **22 条**（翻转 P1 钉下的 `paused` 断言 + 5 条新成员） |
| `test/db.test.mjs` | +1 条（`paused` 可写 / `'bogus'` 仍被拒） |
| `package.json` | `test` 脚本登记 `test/reconcile.test.mjs` |

**验收读数**（本机 Node v24.18.0）：

```
tsc -p tsconfig.json --noEmit  → 0 错
test/reconcile                 → 12/12 通过（新）
test/cubesandbox-spawner       → 22/22 通过
test/k8s-spawner               →  7/7 通过   ← 回归锁（k8s 行为零变化）
test/leader                    →  6/6 通过   ← 回归锁
test/local-user-fs             →  5/5 通过   ← 回归锁
test/db                        → 本机不可运行（better-sqlite3 无 android-arm64 绑定）
v5 SQLite 重建（真引擎 node:sqlite，抽 lib 里的 SQL 原文跑）→ A/B/C/D 四组全过（见 §13）
```

**与本文的三处有意偏离**（§5/§7/§9 各有一段说明）：① `proxy.ts` 的 `=== 'local'` **复核后不动**（语义是"endpoint 是否回环"，沙箱永远不是）；② 迁移 v5 **只加 `paused`，不加三个新列**（加列不需重建，"一次做完"不成立）；③ 不调 `spawner.resume()`，改为**只观察** `markRunning`（AutoResume 是数据面触发的，控制面再发一次只会把唤醒延迟叠一倍）。

**P2 结束后的真实可达性**：`deployMode: 'cubesandbox'` **能在配置层被接受，但一启动就抛**（客户端 P3）。这是刻意的 fail-closed，不是遗漏 —— 三个未实现接缝（客户端、`UserFs`、以及"没有人给 cube 传 template"）都会在启动或首次 launch 时**指名道姓**地报错。**`local`/`k8s` 两条线上路径行为零变化**。


## 18. 机器采购清单（P3 前置）

> 依据：官方 [Quick Start](https://github.com/TencentCloud/CubeSandbox/blob/master/docs/guide/quickstart.md) 与 [PVM 部署](https://github.com/TencentCloud/CubeSandbox/blob/master/docs/guide/pvm-deploy.md)（原文取回，**本仓未实测**）。

### 官方硬门槛（逐条来自原文）

| 项 | 要求 | 为什么 |
|---|---|---|
| 架构 | **x86_64** | PVM 宿主内核只发布 `*.x86_64.rpm` / `*_amd64.deb`；**ARM64 必须用自带 KVM 的裸金属**，走 Bare-Metal 而非 PVM |
| 操作系统 | **OpenCloudOS 9**（官方推荐）/ TencentOS 4；其它发行版须 **glibc ≥ 2.31** | 二进制建在 Ubuntu 20.04（glibc 2.31）上 |
| CPU | ≥ 4 核（官方"推荐"32 核） | |
| 内存 | ≥ 8 GB（官方"推荐"64 GB） | |
| `/data/cubelet` | **≥ 50 GB，且必须是 XFS**（建议独立数据盘；多模板/自定义镜像建议 200 GB+） | XFS **reflink** 是 CoW 快照的硬依赖 —— Ubuntu/Debian 默认 ext4，要手工另建 XFS |
| 权限 / 网络 | root；能出网（要拉 release 包**和 Docker 镜像**） | |
| 内核 | 装 PVM 内核 → `grubby --set-default-index` → **重启** → `modprobe kvm_pvm` | `CUBE_PVM_ENABLE=1`；`.env` 里的 `CUBE_PVM_ENABLE=0` 会**静默覆盖**它（官方明写这个坑） |

装完自带：E2B 兼容 REST（**3000**）、CubeMaster / Cubelet / CubeShim（宿主进程）、**MySQL + Redis（Docker Compose）**、CubeProxy（mkcert TLS）+ CoreDNS（`cube.app`）。

### 本仓选型（三档）

| 档 | 规格 | 用途 | 判断 |
|---|---|---|---|
| 官方最低 | 4C / 8G / 50G | 只够跑通 quickstart | ✗ 一个模板镜像 + 若干挂起快照就到底 |
| **起步档（建议买这个）** | **8C / 16G / 系统盘 60G + 200G XFS 数据盘** | P3 真机打通 + 小规模内测 | ✅ |
| 放量档 | 16C+ / 32G+ / 500G+ | 数十并发活跃用户 | 等 §13 实测曲线；CVM 可在线升配，官方也支持 [多节点集群](https://github.com/TencentCloud/CubeSandbox/blob/master/docs/guide/multi-node-deploy.md) |

**磁盘比 CPU/内存更该给足。** 盘上同时要放：模板镜像 + 可写层 + **每个挂起沙箱的整机快照（内存 + 文件系统）**。挂起只关掉 MicroVM，快照留在盘上（或转 S3）⇒ **磁盘容量随"总用户数"增长，内存随"同时清醒数"增长**。后者正是 §13 第 3 条（`paused_resource_release_ratio` 默认 0）要实测的假设，**在拿到读数前不要把内存按"总用户数"买**。

### 下单要点

- **同地域、同 VPC** —— 控制面走私网拨沙箱节点（§12），**不要走公网**
- 机型：**标准型 / 计算型**；避开**突发性能型**（沙箱是持续负载，CPU 积分会被抽干）
- 镜像：**OpenCloudOS 9.x 64 位**（默认 XFS，省掉 Ubuntu 手工建 XFS 那一步）
- 数据盘：200 GB SSD → 挂 `/data`，XFS
- 安全组：**一律不对公网开** CubeProxy 的 80/443、E2B 的 3000、以及端口映射区间（宿侧端口由 Cubelet 自动分配）；只对内网放行控制面 + 运维口
- 计费：**按量付费**先跑通，P3 出读数后再定包月规格

**不要买**：ARM 机型 · GPU（roadmap 未提供）· 试图装在**生产箱**上（80 是 ACME http-01 唯一通道，且换内核要重启生产站 —— §12/§13）。

### 到手后先回三个读数

```bash
uname -m        # 必须 x86_64
free -g         # 目标 ≥ 8
df -hT /data    # 目标 ≥ 50G，且 Type 列必须是 xfs
```

再按 §13 的 9 条清单逐条出真机读数。
