# 线上热修回流清单（未回流 → 待回流）

> 目的：线上 `lib/supervisor/` 里有**从未回流到任何 git 仓**的热修。本文件把它们逐字存档，
> 使回流成为机械工作，并防止它们再次随构建产物丢失。铁律见 [FORK.md](../../FORK.md) §2。

## 1. 证据坐标

| 文件 | 原始（备份） | 现行（打过补丁） | 差值 |
|---|---|---|---|
| `lib/supervisor/orchestrator.js` | `orchestrator.js.orig-20261011-005637` · 12298 字节 | 12632 字节 · mtime 2026-10-11 00:56 | **+334 字节** |
| `lib/supervisor/proxy.js` | `proxy.js.orig-20261011-005637` · 10342 字节 | 13459 字节 · mtime 2026-10-11 07:30 | **+3117 字节** |

另有更早两枚备份 `proxy.js.orig-20261010232929`、`proxy.js.orig-20261010233006`（各 12996 字节），
说明 proxy 经历过**多轮**热修。

## 2. 四段补丁是什么

| 标记 | 文件 | 作用 |
|---|---|---|
| `[patch:dsh-token]` | orchestrator.js + proxy.js | 从子进程启动横幅抓 `?token=…`，**在宿主（回环）替浏览器换一次 DSH 的 authority 绑定 cookie**，再附到上游请求。**token 全程不进浏览器。** 逐用户 legacy 路径 `/u/<slug>/dsh/*` 依赖它 |
| `[patch:dsh-token-ws]` | proxy.js | 同一套覆盖 **WebSocket 升级**（否则终端 / 流式在 WS 上会被浏览器门挡回）|
| `[patch:panel-host]` | proxy.js | `RESERVED_PANEL_HOSTS`：`panel`/`login`/`www`/`api`… 这些一级名一律按「面板」解析，**不当作用户子域**。本部署 baseDomain 的 apex 是生产官网，面板占不到 apex，只能用 `panel.<base>` |
| `userId` 透传 | proxy.js | 两个 `onRequest` 钩子原只拿到 `endpoint`，补丁改为 `{ endpoint, userId }`，好让钩子用 userId 取 launch token |

## 3. 回流目标（机械映射）

```
src/supervisor/orchestrator.ts   ← [patch:dsh-token]：抓 token（instance.launchToken）
src/supervisor/proxy.ts          ← buildUpstreamHeaders(+extraCookie) / dshCookie() / launchTokenFor()
                                   RESERVED_PANEL_HOSTS / parseSubdomain() / 两个 onRequest / WS upgrade
src/supervisor/proxy.ts 的类型    ← endpoint 返回值加 userId；proxyHttp 加 extraCookie 形参
```

## 4. 回流后的验收

1. `npm run build`（`tsc -p tsconfig.json`）**0 错**；
2. `npm test`（`db` / `k8s-spawner` / `leader` / `local-user-fs`）**全绿**；
3. 与线上产物逐文件比对：只允许**注释与格式**差异，语义差异为 0；
4. 部署后浏览器实测三项：用户子域能进聊天界面（不再被要 token）· `panel.<base>` 落到面板 · WebSocket（终端 / 流式）可连；
5. 清理线上 `*.orig-<时间戳>` 备份。

## 5. 逐字 diff 存档

### 5.1 orchestrator.js

```diff
--- a/lib/supervisor/orchestrator.js
+++ b/lib/supervisor/orchestrator.js
@@ -202,6 +202,13 @@
                 }
             }
         });
+        // [patch:dsh-token] capture the child's launch token from its startup banner
+        instance.launchToken = undefined;
+        child.stdout?.on('data', (chunk) => {
+            const m = /[?&]token=([A-Za-z0-9_-]+)/.exec(chunk.toString());
+            if (m !== null)
+                instance.launchToken = m[1];
+        });
         child.stdout?.pipe(process.stdout);
         let stderrTail = '';
         child.stderr?.on('data', (chunk) => {
```

### 5.2 proxy.js

```diff
--- a/lib/supervisor/proxy.js
+++ b/lib/supervisor/proxy.js
@@ -30,7 +30,7 @@
     'x-forwarded-host',
     'x-forwarded-proto',
 ]);
-function buildUpstreamHeaders(headers, port) {
+function buildUpstreamHeaders(headers, port, extraCookie) {
     const out = {};
     for (const [key, value] of Object.entries(headers)) {
         if (value === undefined || STRIP_HEADERS.has(key.toLowerCase()))
@@ -40,10 +40,48 @@
     // Keep Host loopback: DSH's /api trust fence requires the Host to be loopback
     // or a `--trusted-host` authority — a real domain would 403 every /api call.
     // DSH's absolute URLs are rewritten to the real origin in proxyHttp below.
-    out.host = `127.0.0.1:${port}`;
+    out.host = "127.0.0.1:" + port;
+    // [patch:dsh-token] DSH 的浏览器门（索引 + 静态资源）只认它自己签发的 authority
+    // 绑定 cookie，而那张 cookie 只能用子进程启动横幅里的 launch token 换。这里在
+    // 本机（回环）替浏览器换一次并附到上游，token 全程不进浏览器。
+    if (extraCookie !== undefined && extraCookie !== "") {
+        const existing = out.cookie;
+        out.cookie = existing === undefined || existing === "" ? extraCookie : existing + "; " + extraCookie;
+    }
     return out;
 }
+const dshCookieCache = new Map();
+async function dshCookie(endpoint, token) {
+    if (token === undefined || token === "")
+        return undefined;
+    const key = endpoint.port + ":" + token;
+    const hit = dshCookieCache.get(key);
+    if (hit !== undefined)
+        return hit;
+    try {
+        const res = await fetch("http://127.0.0.1:" + endpoint.port + "/?token=" + token, { redirect: "manual" });
+        const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
+        const value = list.map((one) => one.split(";")[0]).join("; ");
+        if (value !== "") {
+            dshCookieCache.set(key, value);
+            return value;
+        }
+    }
+    catch {
+        // 子进程还没起来：下一次请求会重试
+    }
+    return undefined;
+}
+async function launchTokenFor(app, userId) {
+    if (app.config.deployMode !== "local")
+        return undefined;
+    const current = await app.supervisor.status(userId);
+    return current.main?.launchToken;
+}
 /** Extract `<slug>` from `<slug>.<baseDomain>`, or null when not a match. */
+/** [patch:panel-host] 保留一级主机名：这些名字一律按「面板」处理，不做用户子域解析。
+ *  本部署 baseDomain 的 apex 是生产官网，面板无法占用 apex，故用 panel.<base> 作面板。 */
+export const RESERVED_PANEL_HOSTS = new Set(["panel","login","register","www","api","mail","app","root","status","support","help"]);
 export function parseSubdomain(host, baseDomain) {
     if (host === undefined || baseDomain === '')
         return null;
@@ -52,7 +90,10 @@
         return null;
     if (name.endsWith('.' + baseDomain)) {
         const slug = name.slice(0, -(baseDomain.length + 1));
-        return slug !== '' ? slug.toLowerCase() : null;
+        if (slug === '')
+            return null;
+        const lower = slug.toLowerCase();
+        return RESERVED_PANEL_HOSTS.has(lower) ? null : lower;
     }
     return null;
 }
@@ -107,9 +148,9 @@
     const endpoint = await app.supervisor.endpointFor(session.user.id);
     if (endpoint === undefined)
         return { error: 'not_running', code: 404 };
-    return { endpoint };
+    return { endpoint, userId: session.user.id };
 }
-function proxyHttp(request, reply, endpoint, targetPath, rewritePrefix, rewriteLoopbackLocation = false) {
+function proxyHttp(request, reply, endpoint, targetPath, rewritePrefix, rewriteLoopbackLocation = false, extraCookie) {
     reply.hijack();
     const attempt = (retry) => {
         const upstream = httpRequest({
@@ -123,7 +164,7 @@
             agent: retry ? false : upstreamAgent,
             // Host header stays loopback for the DSH trust fence; the TCP target host
             // is endpoint.host above. k8s mode overrides the header port separately.
-            headers: buildUpstreamHeaders(request.headers, endpoint.port),
+            headers: buildUpstreamHeaders(request.headers, endpoint.port, extraCookie),
         }, (upRes) => {
             const headers = { ...upRes.headers };
             const location = upRes.headers.location;
@@ -178,7 +219,9 @@
         const prefix = `/u/${slug}/dsh`;
         const rawUrl = request.raw.url ?? '/';
         const targetPath = rawUrl.startsWith(prefix) ? rawUrl.slice(prefix.length) || '/' : rawUrl;
-        proxyHttp(request, reply, endpoint, targetPath, prefix, app.config.deployMode === 'local');
+        const legacyToken = await launchTokenFor(app, request.user.id);
+        const legacyCookie = await dshCookie(endpoint, legacyToken);
+        proxyHttp(request, reply, endpoint, targetPath, prefix, app.config.deployMode === 'local', legacyCookie);
     });
     // Per-user subdomain: HTTP (intercept before normal routing).
     app.addHook('onRequest', async (request, reply) => {
@@ -189,7 +232,9 @@
             reply.code(access.code).send({ error: access.error });
             return;
         }
-        proxyHttp(request, reply, access.endpoint, request.raw.url ?? '/', undefined, app.config.deployMode === 'local');
+        const subToken = await launchTokenFor(app, access.userId);
+        const subCookie = await dshCookie(access.endpoint, subToken);
+        proxyHttp(request, reply, access.endpoint, request.raw.url ?? '/', undefined, app.config.deployMode === 'local', subCookie);
     });
     // Per-user subdomain: WebSocket upgrade tunnel. Auth is async (DB lookup), so
     // the raw `upgrade` callback defers to an async IIFE before deciding to tunnel.
@@ -200,15 +245,25 @@
                 socket.destroy();
                 return;
             }
+            // [patch:dsh-token-ws] WebSocket 升级同样要过认证分支，cookie 也得附上
+            const upgradeCookie = await dshCookie(access.endpoint, await launchTokenFor(app, access.userId));
             const upstream = connect({ host: access.endpoint.host, port: access.endpoint.port });
             upstream.on('connect', () => {
                 const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
+                let cookieSent = false;
                 for (let i = 0; i < req.rawHeaders.length; i += 2) {
                     const name = (req.rawHeaders[i] ?? '').toLowerCase();
                     if (name === 'host' || STRIP_HEADERS.has(name))
                         continue;
+                    if (name === 'cookie' && typeof upgradeCookie === 'string' && upgradeCookie !== '') {
+                        lines.push('Cookie: ' + [req.rawHeaders[i + 1], upgradeCookie].filter((v) => v !== undefined && v !== '').join('; '));
+                        cookieSent = true;
+                        continue;
+                    }
                     lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
                 }
+                if (cookieSent === false && typeof upgradeCookie === 'string' && upgradeCookie !== '')
+                    lines.push('Cookie: ' + upgradeCookie);
                 lines.push(`Host: 127.0.0.1:${access.endpoint.port}`);
                 upstream.write(lines.join('\r\n') + '\r\n\r\n');
                 if (head !== undefined && head.length > 0)
```
