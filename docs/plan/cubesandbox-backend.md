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

| 位置 | 现状含义 | 加第三值后的行为 | 要做的事 |
|---|---|---|---|
| `src/web/server.ts:64-68` | 选后端 | 掉进 `LocalSpawner` | 加第三分支（显式） |
| `src/cli.ts:144-147` | `k8s` 才建 `ReconcileController` | **不再建收敛器** → 没有 AutoPause/回收 | **必须把 cubesandbox 也纳入** |
| `src/supervisor/proxy.ts:206,217` | 传 `deployMode === 'local'` 给 `proxyHttp` | 变 `false`（表现同 k8s） | **复核该布尔的真实含义**，必要时改成显式枚举 |
| `src/fs/provider.ts:33` | 选 `UserFs` 实现 | 掉进 local 分支（控制面直摸卷）| 新增 cubesandbox 分支（§10） |

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

---

## 10. 存储与文件面

| | per-user | per-task |
|---|---|---|
| 用户工作区 | **CubeSandbox Volume**（v0.6 框架，独立生命周期、可跨沙箱共享、可只读挂载、删除有引用计数保护） | 不需要（临时根 FS） |
| 输入/产物 | 同上 | 可选挂一个卷做传入/取出 |
| 与上游 `UserFs` 对接 | 新增 `src/fs/cubesandbox-user-fs.ts`，**照 k8s sidecar 范式**（`k8s-user-fs.ts`）：沙箱内跑文件服务，控制面走 `ensureFileService` | 不需要 |
| **不要用 raw host mount** | 上游卷框架明确：**raw host mount 会把快照钉在原节点**（跨节点恢复失败、快照不含它）；plugin Volume 不钉 | — |

`ensureFileService` 这个方法在上游是为 k8s sidecar 留的（`spawner.ts:77-79` 注释），**在 Cube 后端正好第二次用上** —— 又一个"上游设计已经预见到"的证据。

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
3. `test/reconcile.test.mjs`：`planReconcile` 对 **`paused` 行不得判为缺失**（这是 §9 的回退锁）；`stop` 后**期望行必须还在**；
4. `test/db.test.mjs` 扩：迁移 v5 在 **SQLite 与 PG 两侧**都能把旧库升上来（含 `paused` 可写）。

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

**资源前提（已侦察，不满足则 §13 全部做不了）**：官方最低 **4 核 / 8 GB / ≥50 GB XFS 数据盘**（PVM 路线**不需要 `/dev/kvm`**，但**要换内核并重启**）。现有生产机 2 核 / 3.6 GB / 剩 9.3 GB 且**单盘单分区** ⇒ **不满足**，且换内核会降级到 6.6.117（现为 6.6.119）。**结论：另开一台 CVM 专门跑沙箱，控制面继续留在生产机** —— 也正好就是本文的网络形态。

---

## 14. 分阶段落地

| 阶段 | 内容 | 前置 | 产出（可验证） |
|---|---|---|---|
| **P0** | 把线上未回流的三段热修（token / WS / panel-host）回流进 `src/` | 需要能构建的环境（本机缺原生依赖，建议服务器 Node 24） | `tsc` + `node --test` 全绿；[panel-hotfix-reflow.md](../fork/panel-hotfix-reflow.md) 作对照 |
| **P1** | `SandboxClient` 抽象 + `fake-client` + `cubesandbox-spawner` + 单测 | 无（不需要真沙箱） | §13 的 1、3 组测试全绿 |
| **P2** | `reconcile` 抽出 `SupervisedSpawner`；`deployMode` 加 `'cubesandbox'`；迁移 v5 | P1 | §13 的 3、4 组测试全绿；`local`/`k8s` 行为零变化 |
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
