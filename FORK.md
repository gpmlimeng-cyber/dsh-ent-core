# FORK.md — 上游关系与二开基线

> 本文件是本仓「与上游关系」的制度真源。变更策略时先改这里。

## 1. 立场

| 项 | 决定 |
|---|---|
| 上游 | [pointer-a/dsh-server-login](https://github.com/pointer-a/dsh-server-login)（MIT）|
| 导入基线 | commit `04bc832ee8ffcff56dc551dc12845da4a4f2550d`（2026-08-26）—— 本仓 `main` 的首个提交**逐字等于**它 |
| 同步 | **不做隐式同步**。不设自动回流；需要时显式 `git fetch upstream` 后人工比对，并在提交信息里写明取的是上游哪个 commit |
| 真源 | **本仓即唯一开发真源**。线上正在跑的那份是**构建产物**，不是真源（见 §2）|
| 许可 | 保持 MIT；`LICENSE` 与 `NOTICE` 里的上游版权行必须保留 |
| 边界 | 本仓 = **平台核心**（注册/审核/登录/多租户编排/反向代理/网页桌面）。企业 monorepo 是同账号的 [dsh-enterprise](https://github.com/gpmlimeng-cyber/dsh-enterprise)，两者不互相搬目录 |

## 2. 铁律：产物不是真源

历史上出现过「**直接改线上 `lib/*.js` 编译产物、源码仓里没有任何对应改动**」的漂移。
证据是线上 `lib/supervisor/` 里留下的热修备份：

```
proxy.js.orig-20261010232929   proxy.js.orig-20261010233006   proxy.js.orig-20261011-005637
orchestrator.js.orig-20261011-005637
```

这些热修（launch-token 浏览器门、面板保留主机名等）**从未回流到任何 git 仓**，
只有一个副本存在于线上主机。本仓建立后：

1. 任何改动**先进本仓 `src/`**（TypeScript），再构建，再部署；
2. **禁止**直接编辑部署产物。产物与 `src/` 不一致即为缺陷；
3. 紧急热修允许先改产物，但**必须同日回流成本仓提交**，并在提交信息里写明
   「热修回流」+ 线上文件的字节数/指纹，以便日后逐字核对；
4. 回流完成后，线上那些 `*.orig-<时间戳>` 备份应当清理，避免再次被当成真源。

## 3. 部署产物的形状（回流时对照）

线上安装形如：

```
<dsh home>/profiles/web/node_modules/dsh-server-login/
├─ lib/                ← 构建产物（由 src/ 编译；不是真源）
│   └─ supervisor/
│       ├─ orchestrator.js  spawner.d.ts  reconcile.js  ...
│       └─ *.orig-<时间戳>   ← 历史热修留下的备份
├─ web/                ← 静态页
├─ cordis.patch.yml
└─ LICENSE · package.json · README.md
```

判断「线上是否有未回流的改动」的办法：把线上 `lib/**` 与本仓 `npm run build`
的产出逐文件比对；不一致即为漂移。

## 4. 目录（沿用上游结构，不重排）

`src/`（TypeScript 源，**唯一真源**）· `web/`（静态页）· `deploy/` · `scripts/`
· `test/` · `docs/` · `poc/`
