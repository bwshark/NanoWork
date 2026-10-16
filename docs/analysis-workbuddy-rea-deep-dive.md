# WorkBuddy 深析(REA 静态 + 源码抽取)\&nanowork 复刻清单

> 第三篇。前两篇的定位:
>
> - 第一篇 `analysis-workbuddy-builtin-plugins.md` —— 拆 `plugins/`(给 agent 加能力)
> - 第二篇 `analysis-workbuddy-platform-capabilities.md` —— 拆整包的五层能力面
> - **本篇** —— 用 REA 对 `app.asar` 做静态重构,再抽出可读源码,聚&#x7126;**「运行期工程」**:进程治理、窗口安全档位、SQLite 维护、预热池、启动剖析。
>
> 重复项不再展开。以下主题经核查在前两篇中零命中,属本篇新增:  
> `prewarm / 预热`、`WAL / checkpoint`、`webPreferences / secure-web`、`code-cache / 代码缓存`、`lazy-chunk`。

---

## 〇、TL;DR

**结论先给:这一轮挖到的东西比前两篇更"能直接抄"。** 前两篇找到的多半是方向(B9 扩展运行时、B5 Job Object),这一轮找到的是**已经写好、结构清晰、体量在几十行以内**的成品模式。

六个新增能力面,其中三条**照着抄就行**(diff 级):

| #      | 能力面                                                                           | 本项目实测缺口                                                       | 体量                          |
| ------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------- |
| **C1** | **窗口安全档位表** `secure-web-preferences.js`                                       | `main.ts:560` 全局 `webSecurity:false`、无 `sandbox`              | ~20 行 + 一个表                 |
| **C2** | **SQLite WAL  checkpoint worker**                                             | `llm_usage.sqlite3-wal` **4.1 MB** vs 主库 143 KB,从未 checkpoint | ~60 行                       |
| **C3** | **进程治理四件套** no-orphans / windows-job / daemon-supervisor / core-process-roles | 主进程崩溃留孤儿占端口;`taskkill /T` fire-and-forget                     | ~150 行 + 1 个 native binding |
| **C4** | **lazy chunk manifest 契约**                                                    | 无 React.lazy,首屏 2.27 MB                                       | 中(要配合路由改造)                  |
| **C5** | **CLI 预热池**                                                                   | 引擎 spawn→listen 实测 **9.4 秒**,当前无任何预热                          | 大(架构决策)                     |
| **C6** | **启动剖析器** `startup-profile.cjs`                                               | 全仓零 `performance.mark`                                        | ~80 行                       |

最值得单独拎出来说的是 **C1**:WorkBuddy **也有**一个 `webSecurity:false` 的窗口 —— 但它被关进了一个叫 `image-decoder` 的命名档位里,并且**强制要求传入 `partition`,否则直接 throw**。同样的危险开关,人家做成了一个**默认拿不到**的结构,本项目是**全局默认打开**。这不是"安全意识强弱"的差距,是**设计手法**的差距,而手法是可以照抄的。

---

## 一、方法论与证据边界

### 1.1 三条命令的实际结果

用户指定的是全目录 `analyze-javascript-application D:\Program Files\WorkBuddy --json`。实际执行分三步:

| 步骤 | 命令/动作                                                           | 结果                                                                                                                                 |
| -- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| ①  | 全目录 `--json`                                                    | ❌ **硬失败**:`artifact_integrity_mismatch`。第一个卡住的是 `cli/bin/native/win32-x64/job-object.node`,声明 `sha256=0f7411db…` vs 实测 `2cf45879…` |
| ②  | 全目录 `--integrity-policy record-and-continue --max-heap-mb 6144` | ❌ **超容**:13990 个源文件,分析到 1931 个时 `resource_constraint`(`resource: "memory"`),parent 结果容量耗尽。产物 501 MB 且不含完整图                         |
| ③  | **`app.asar` + `--source-path` 精选 12 个模块**                      | ✅ 完成。产物 322 MB(其中绝大部分是 inventory,不是语义)                                                                                             |

**教训(值得记档)**:REA 对 Electron 应用的**全语义分析在这种体量下不可行**——瓶颈不是单个文件的解析,而是 **parent 端累积的 retain 结果**。正确用法是用 `--source-path` 把问题收敛到几十个文件以内。这条同样适用于本项目以后对自己打包产物做静态核查。

### 1.2 REA 给出的客观事实(观察,非推断)

目标改为 `app.asar` 后,REA 记录的身份与完整性事实:

| 字段                       | 值                                                                      |
| ------------------------ | ---------------------------------------------------------------------- |
| `input_path`             | `D:\Program Files\WorkBuddy\resources\app.asar`                        |
| `format`                 | `asar`                                                                 |
| `root_artifact_sha256`   | `035254bc76310ea46317433e4840602094543ef323d2d5c5aff7c131729de918`     |
| `inventory_manifest_id`  | `agm_5fe7e3ac61a9ec1e4533b56055ca0f5dfc3614397a9bed5824d66ae677082109` |
| `inventory_graph_sha256` | `d8d87c7ece840fb32af6d2eb53545aa07d0d99571597f80965fa54003033d0d6`     |
| asar 条目数                 | 17355                                                                  |
| `main/` 顶层模块             | 184                                                                    |
| 精选模块静态分析                 | ✅ 12/12 成功(未精选的 12 千余个文件报 `incomplete-module`,见 §1.3)                  |

> 更正措辞:`main/` 顶层模块清单通过 asar inventory 获得(**观察**);各模块的职责多为**命名推断**,下文凡已实际读取源码的会标注「已验证」。

**完整性矛盾清单**(REA 原话 `trust: "observed-untrusted"`):

```
cli/bin/native/win32-x64/job-object.node
cli/node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty.node
cli/node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty/OpenConsole.exe
cli/node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty_console_list.node
cli/node_modules/koffi/build/koffi/win32_x64/koffi.node
cli/vendor/genie-trash/win32-x64.exe
cli/vendor/ripgrep/x64-win32/rg.exe
cli/vendor/ripgrep/x64-win32/ripgrep.node
cli/vendor/sandbox/5.8.5/{betterleaks,sandbox-center,sandbox-cli-gc,sandbox-cli}.exe
cli/vendor/sandbox/5.8.5/{sandbox_ffi,tsbx}.dll
…
```

**这份清单本身是一条有用的情报**:矛盾文件**全部是原生二进制 / 可执行文件**,没有一个是 `.js`。REA 自己在 remediation 里写明了原因:

> packaging tools commonly sign or strip unpacked native binaries after writing the archive

即 **ASAR integrity 对 unpacked 原生文件天然不适用**。任何采用 `@electron/asar` + integrity 的项目都会撞到。

### 1.3 覆盖率声明(必须原样保留)

REA 对未精选的文件给出的 unknown reason 是明确的两类:

```json
{"family":"promise-ownership","relation_kinds":["chains"],
 "reason":"incomplete-module",
 "detail":"Source was not analyzed because it is outside the caller-selected source_paths."}

{"family":"promise-ownership","relation_kinds":["aggregates","awaits",...],
 "reason":"ambiguous-target",
 "detail":"Static await source resolution was unresolved.",
 "location":{"kind":"source-range","source":"main/sidecar-manager.js","start":{"line":16,"column":38958}}}
```

语义图族(family)共观察到:`call-flow` / `data-flow` / `object-flow` / `timer` / `promise-ownership` / `resource-lifecycle`。

**所以本篇的结论分为三档,下文逐条标注:**

- 🟢 **已读源码** —— 从 asar 抽出实际字节并阅读(不是看文件名)
- 🟡 **命名推断** —— 只依据 `main/*.js` 的文件名
- ⚪ **未知** —— 没有足够证据,不做结论

---

## 二、新能力面


### 2.1 🟢 进程治理四件套 —— 本项目差距最大的一块

四个文件都在 `cli/bin/`,全部**已读原文**:

#### ① `cli/bin/no-orphans.cjs`(2.2 KB)—— 已验证

```js
const STATE = Symbol.for('codebuddy.no-orphans');
const NO_ORPHANS_FLAG = '--no-orphans';
const DISABLE_ENV = 'CODEBUDDY_DISABLE_CHILD_PROCESS_CONTAINMENT';

function isDisabled(environment = process.env) {
    const value = environment[DISABLE_ENV];
    if (value === undefined || ['', '0', 'false'].includes(value)) {return false;}
    if (['1', 'true'].includes(value)) {return true;}
    throw new Error(`${DISABLE_ENV} must be 0, 1, true, false, or unset`);   // ← 非法值报错，不静默
}

function install({ platform, environment, args, state = globalThis, loadBinding: load = loadBinding,
                   warn = message => process.emitWarning(message) } = {}) {
    if (state[STATE] !== undefined) {return state[STATE];}      // 幂等
    if (platform !== 'win32') {return (state[STATE] = false);}  // 非 Windows 明确不支持
    // Read the startup flag before loading the application...
    const terminator = args.indexOf('--');
    const requested = args.slice(0, terminator < 0 ? args.length : terminator).includes(NO_ORPHANS_FLAG);
    if (!requested && isDisabled(environment)) {return (state[STATE] = false);}
    require('./daemon-supervisor.cjs').prepare();               // ← 顺序重要：先于进 Job
    try {
        load().ensureKillOnCloseJob();
        return (state[STATE] = true);
    } catch (error) {
        state[STATE] = false;
        warn(`Windows no-orphans cleanup unavailable: ${error.message}`);   // fail-open + 告警
        return false;
    }
}
```

三个可直接照搬的设计点:

1. **`Symbol.for(...)` 做跨实例幂等键** —— 同一个 process global 上重复 install 不会叠加副作用。本项目若在 `main.ts` 多处调用,同样的技巧可以避免重复安装。
2. **`isDisabled` 对非法值 throw 而不是默认 falsy** —— 环境变量写错了宁可报错也不要静默失效。
3. **注释里写清了「为什么不做什么」**:

```js
// We deliberately do not install Bun's parent-death watchdog: daemon/bg processes
// must outlive their launcher while still cleaning up their own descendants on exit.
```

这句是全套设计的**关键约束**,而且它解释了为什么需要下面那个 supervisor。

#### ② `cli/bin/windows-job.cjs`(0.9 KB)—— 已验证

```js
// Loading the platform binding has no process-lifetime side effects. Policy
// belongs to no-orphans.install(); only it calls ensureKillOnCloseJob().
function loadBinding() {
    if (process.platform !== 'win32') {throw new Error('Windows Job binding requires win32');}
    if (!binding) {
        if (globalThis.__CODEBUDDY_WINDOWS_JOB_NATIVE__) {
            binding = globalThis.__CODEBUDDY_WINDOWS_JOB_NATIVE__();
        } else {
            // __dirname is bin/ for the bootstrap and dist/ inside the bundle.
            const filename = path.resolve(__dirname, '../bin/native', `win32-${process.arch}`, 'job-object.node');
            binding = createRequire(__filename)(filename);
        }
    }
    return binding;
}
```

**职责切分干净到了苛刻的程度**:加载 binding 不产生任何进程生命周期副作用;策略只住在 `no-orphans.install()` 里,而且**只有它**能调 `ensureKillOnCloseJob()`。还留了 `globalThis.__CODEBUDDY_WINDOWS_JOB_NATIVE__` 注入点供测试替换。

#### ③ `cli/bin/daemon-supervisor.cjs`(5.7 KB)—— 已验证,**这是最可对症的一件**

解决了"既要 daemon 比 launcher 活得久,又要 launcher 挂了不留孤儿"这个矛盾:方法是**多加一个不进 Job 的中间进程**。

```
launcher ──(进 strict Job, kill-on-close)──► daemon-supervisor ──► daemon worker
                    ▲                              ▲ (detached, 不进 Job)
                    │                              │
               launcher 死 → Job 自动杀     supervisor 只在「自己的 worker 全退出
               所有后代(含 supervisor)        且 channel 断开」时才 exit(0)
```

关键代码:

```js
function prepare(platform = process.platform) {
    if (platform !== 'win32') {return;}
    if (globalThis[STATE]) {return globalThis[STATE];}
    if (process.env[CHANNEL_ENV]) {                     // 已经是 supervisor 子进程
        delete process.env[CHANNEL_ENV];
        if (process.send && process.connected) {
            globalThis[STATE] = process;
            process.channel?.unref?.();
            return process;
        }
    }
    const args = process.argv.slice(2);
    if (args[0] !== 'daemon' || !['start','restart','install'].includes(args[1])) {return;}
    return start();
}
```

```js
// A failed supervisor must reject the eventual daemon request, not crash
// the starter with an unhandled ChildProcess error.
child.on('error', error => { child.supervisorError = error; });
```

```js
let log;
try {
    log = options.logPath === undefined ? undefined : openSync(options.logPath, 'a');
    const worker = spawn(command, args, {
        cwd: options.cwd, env: { ...options.env, [CHANNEL_ENV]: '1' },
        detached: true, windowsHide: true,
        stdio: ['ignore', log ?? 'ignore', log ?? 'ignore', 'ipc'],
    });
    handedOff = true;
    workers.add(worker);
    listen(worker);                                     // supervisor 也接替 worker 的角色
    worker.once('spawn', () => reply({ pid: worker.pid }));
    worker.once('error', error => { handedOff = false; workers.delete(worker); reply({error}); maybeExit(); });
    worker.once('exit', () => { workers.delete(worker); maybeExit(); });
} finally {
    if (log !== undefined) {closeSync(log);}            // fd 一定关
}
```

以及 supervisor 自己的退出判据:

```js
const maybeExit = () => {
    if (!process.connected && workers.size === 0) {process.exit(0);}
};
```

**为什么这套东西本项目特别需要**:它的 `spawnDaemon` 强制校验 `args.includes('--serve')` 且 `env.CODEBUDDY_SESSION_KIND === 'daemon'`,即**只对 daemon 形态放行**,避免被当成任意进程启动器。

#### ④ `main/core-process-roles.js`(1.3 KB,**app.asar 内**,已抽出阅读)—— 已验证

```js
function resolveCoreProcessRoles(e = () => t.app.getAppMetrics(), n = process.pid) {
    let r = [], i = new Set([n]);
    try {
        for (let t of e()) {
            !Number.isInteger(t.pid) || t.pid <= 0 || (i.add(t.pid), t.type === `Tab` && r.push(t.pid));
        }
    } catch {}
    let a = getPerfMetricsDaemonPid(), o = a !== void 0 && a !== n ? a : void 0;
    o !== void 0 && i.add(o);
    return { mainPid: n, daemonPid: o, rendererPids: r,
             cliPids: getPerfMetricsCliPids().filter(e => !i.has(e)) };
}
```

把进程树去重后分类成 `mainPid / daemonPid / rendererPids / cliPids` 四桶 —— 这是给性能采集(populate perf tree)用的,但**完全可以复用到「诊断导出」**:本项目 `electron/diagnostics.ts` 目前只装 logs + traces,**没有进程维度**,所以拿到诊断包也排查不了孤儿占端口(C2 缺口的直接对应)。

#### 本项目现状(实测,with file:line)

| 缺口                                     | 证据                                                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 主进程崩溃 → `before-quit` 不触发 → 孤儿占端口      | `electron/main.ts:4567-4579` 只有 `app.on('before-quit')`;`main.ts` 内 **`process.on(` 零命中** —— 无 `uncaughtException` / `SIGINT` / `SIGTERM` 处理               |
| `taskkill /T /F` 不等待返回                 | `electron/main.ts:913-924`,`stdio:'ignore'` 且未 await;且 **`will-quit` 不存在**                                                                                 |
| `shell:true` 使 Electron 只是 cmd 的子进程    | `electron/main.ts:866-879`,`nanobot` 是 cmd 的**孙进程**                                                                                                        |
| `exit` 事件只置 null,无重启无广播                | `electron/main.ts:879`,注释后 `nanobotProcess = null`                                                                                                         |
| 引擎侧有完整 lease/supervisor,Electron 侧从不调用 | `nanobot/nanobot/gateway/runtime.py:509-518` `begin_orphan_shutdown()` + `_live_state()` PID 存活裁剪 —— **`spawn('gateway --foreground')` 绕过了整套引用计数**         |
| 运行时实证                                  | `run/gateway.{2643f60c,c2eaae52,4e20da55}.json` 三份,声明 pid 46184 / 31796 / 70856,**实测全部已死**,其中一份还指向另一个项目 `sciherd-cloud-smartagent` 的 config。启动时从不扫描 `run\` |

### 2.2 🟢 窗口安全档位表 —— 最值得立刻抄的一件

`main/secure-web-preferences.js`(**897 字节**,已抽出全文阅读):

```js
function createSecureWebPreferences(e, t={}) {
    switch(e) {
        case `main`:
            return {preload:t.preload, contextIsolation:!0, sandbox:!0, nodeIntegration:!1,
                    nodeIntegrationInSubFrames:!0, webviewTag:!0};
        case `first-party-window`:
            return {preload:t.preload, contextIsolation:!0, sandbox:!0, nodeIntegration:!1,
                    backgroundThrottling:!1};
        case `guest-popup`:
            return {sandbox:!0, contextIsolation:!0, nodeIntegration:!1};
        case `image-decoder`:
            if(!t.partition) throw Error(`[SecureWebPreferences] image-decoder kind requires options.partition`);
            return {partition:t.partition, webSecurity:!1, nodeIntegration:!1,
                    contextIsolation:!0, sandbox:!1, backgroundThrottling:!1};
        case `splash`:
            return {preload:t.preload, contextIsolation:!0, sandbox:!1, nodeIntegration:!1};
        case `no-preload-guest`:
            return {sandbox:!0, contextIsolation:!0, nodeIntegration:!1};
    }
}
```

**这张表的信息密度极高,逐条读:**

| 档位                   | sandbox | webSecurity | 特殊                                                    |
| -------------------- | ------- | ----------- | ----------------------------------------------------- |
| `main`               | ✅       | 默认          | `nodeIntegrationInSubFrames:true` + `webviewTag:true` |
| `first-party-window` | ✅       | 默认          | `backgroundThrottling:false`(不被节流)                    |
| `guest-popup`        | ✅       | 默认          | 无 preload                                             |
| **`image-decoder`**  | ❌       | **❌ false** | **缺 `partition` 直接 `throw`**                          |
| `splash`             | ❌       | 默认          | 唯一另一个关 sandbox 的(短命、无内容)                              |
| `no-preload-guest`   | ✅       | 默认          |                                                       |

三个可迁移的手法:

1. **危险开关必须"按名字领取",不能"默认继承"**。要做 image decode 就必须显式声明自己是 `image-decoder`,顺手把 `partition` 也交出来。
2. **缺失前置条件用 `throw` 而不是降级**。这也是本项目既有纪律「fail-closed 写在每一层」的同构写法。
3. **`backgroundThrottling:false` 只给特定窗口**,而不是全局关(省电 vs 后台存活的精确取舍)。

#### 本项目现状

```ts
// electron/main.ts:555-561
webPreferences: {
  preload: join(__dirname, 'preload.cjs'),
  contextIsolation: true,
  nodeIntegration: false,
  // 允许从 file:// 页面访问本地 nanobot 网关（端口见 DEFAULT_GATEWAY_PORT，可能被自动顺延），避免 CORS 导致离线
  webSecurity: false,      // ← 全局生效，且未设 sandbox
},
```

- `contextIsolation: true` / `nodeIntegration: false` ✅ 做对了
- **`sandbox` 未设置**(Electron 默认 false)❌
- **`webSecurity:false` 对主窗口全局生效** ❌ —— 关闭的是**同源策略与混合内容拦截**,影响面远大于注释里说的 "allow file:// → localhost CORS"
- 全仓 `webPreferences` 只有这一处(实测 grep:`main.ts:557/558/560` 三行)

> 注意:注释里那个需求本身是合理的 —— `file://` 页面访问 `http://127.0.0.1:端口` 确实会被 CORS 拦。问题不在需求,在于**用全局 `webSecurity:false` 解决一个局部问题**。正确解法见 §三 C1。

### 2.3 🟢 SQLite WAL checkpoint worker —— 一条线对上一个已实测的坑

`main/wal-checkpoint-worker.js`(**1.6 KB**,已抽出全文阅读)。这是个 **worker_thread**,专门做 WAL checkpoint:

```js
function openDb(){
    let n = t.nativeBinding ? new e(t.dbPath,{nativeBinding:t.nativeBinding}) : new e(t.dbPath);
    n.pragma(`journal_mode = WAL`);
    n.pragma(`busy_timeout = ${t.busyTimeoutMs}`);
    return n;
}

function doCheckpoint(e, t) {                       // e = 模式, t = 触发原因
    let r = Date.now();
    try {
        n ||= openDb();
        let i = n.pragma(`wal_checkpoint(${e})`), a = Date.now() - r;
        sendMessage({type:`checkpoint-done`, trigger:t, result:i?.[0]??null, durationMs:a});
    } catch (i) {
        let a = Date.now() - r;
        if (e === `TRUNCATE` && i instanceof Error && i.message.includes(`database is locked`)) {
            try {
                n ||= openDb();
                let e = n.pragma(`wal_checkpoint(PASSIVE)`);
                sendMessage({type:`checkpoint-done`, trigger:`${t}:fallback-passive`,
                             result:e?.[0]??null, durationMs:Date.now()-r});
                return;
            } catch {}
        }
        sendMessage({type:`checkpoint-error`, trigger:t,
                     error: i instanceof Error ? i.message : String(i), durationMs:a});
    }
}

function startPeriodicCheckpoint(e) {
    r && clearInterval(r);
    r = setInterval(() => {doCheckpoint(`TRUNCATE`,`periodic`)}, e);
    r.unref();                                       // ← 不阻塞进程退出
}

startPeriodicCheckpoint(t.intervalMs);
parentPort.on(`message`, e => {
    switch(e.type) {
        case `startup-checkpoint`: doCheckpoint(`TRUNCATE`, `startup`); break;
        case `checkpoint`:         doCheckpoint(e.mode, `manual`); break;
        case `update-interval`:    startPeriodicCheckpoint(e.intervalMs); break;
        case `shutdown`:
            r &&= (clearInterval(r), null);
            try { n ||= openDb(), n.pragma(`wal_checkpoint(TRUNCATE)`); } catch {}
            try { n?.close(); } catch {}
            n = null;
            sendMessage({type:`shutdown-done`});
            setTimeout(() => process.exit(0), 50);    // ← 让消息先发出去再退
            break;
    }
});
sendMessage({type:`ready`});
```

**可以直接照搬的四处细节:**

1. `busy_timeout` 显式设置,避免 checkpoint 瞬间撞锁就失败。
2. **`TRUNCATE` 失败且错误是 `database is locked` → 降级重试 `PASSIVE`**,且 trigger 被标成 `` `${t}:fallback-passive` `` —— **降级路径在消息里可见**,不是静默的。这正是本项目既有纪律里那条「失效打包的 leder 要可见」。
3. `setInterval(...).unref()` —— 周期定时器不阻止主进程退出。
4. 关闭序列:`clearInterval` → 最后一次 TRUNCATE → close → 回 `shutdown-done` → `setTimeout(exit, 50)` 留消息 flush 窗口。

#### 本项目现状(实测)

| 事实                      | 数值                        |
| ----------------------- | ------------------------- |
| `llm_usage.sqlite3` 主库  | **143 KB**                |
| `llm_usage.sqlite3-wal` | **4,132,392 字节(≈4.1 MB)** |
| WAL checkpoint          | **从未执行**                  |

顺带发现的相邻事实:

- `llm_usage.sqlite3` 有 `ttft_ms` / `generation_ms` 字段,但**实测 1148 条记录中 `stream=1` 的条数为 0、`ttft_ms>0` 为 0** —— 即 TTFT 通道采集率为 0(引擎侧 `providers/base.py:1423-1432` 埋点是对的,问题在写入/标记链路)。
- 渲染层 `src/ai/runtime/nanobotHttp/usage.ts:72-83` 的 `readCounters` **根本没有 ttftMs / generationMs 字段**,类型 `src/types/usage.ts:15-26` 也没有。→ 这解释了为什么第二篇说"TTFT 只用于用量展示"。

### 2.4 🟢 CLI 预热池 —— 对本项目 9.4 秒冷启动的正面对症药

`cbc-prewarm`(12.7 KB,**已读前 70 行**)是一个**纯 Node 脚本**,用于管理预热进程。头部注释把设计约束写死了:

```
/**
 * cbc-prewarm —— 预热进程轻量管理 CLI
 *
 * 设计要点：这是一个**纯 Node 脚本**，只使用内置模块（net/fs/os/path），
 * 故意**不** require 主 bundle（dist/codebuddy*.js ~16MB）、不启动 CellJS 容器、
 * 不做产品配置加载。它的唯一职责是作为 prewarm IPC 的客户端 + 发现工具，
 * 让外部（脚本 / 调度器 / daemon）能以毫秒级开销 list / ping / status / activate
 * 预热进程。
 */
```

要点:

- **管理端与被管的重 bundle 彻底解耦** —— 管理 CLI 只用内置模块,毫秒级开销才能做 `list/ping/status/activate`。
- IPC 路径约定跨 README 与进程侧保持同构(`codebuddy-prewarm-<id>`;unix `*.sock`,win `\\.\pipe\*`),**发现复用 daemon 的 `~/.codebuddy/sessions/`(`PidFileEntry.kind==='prewarm'`)**。
- `kill` 后有 5 秒优雅退出宽限 + 100ms 轮询。

对应的进程侧模块 `main/cli-prewarm-pool.js`(23.7 KB,🟡 **未读取,命名推断**)。

#### 本项目现状

`electron/main.ts:799-829` 的注释已经把问题量化:

```ts
/**
 * 子进程拉起后等待其端口进入监听的默认上限。
 * 实测 `nanobot serve` 从 spawn 到 listen 约 9.4 秒
 * （Python 导入依赖 + 注册工具 + 连接 MCP），留约 3 倍余量。
 */
const LAUNCH_READY_TIMEOUT_MS = 30_000;
```

> **9.4 秒这个数字被写进了注释,却从未被写进任何日志或埋点** —— 每次冷启动的真实耗时 0 留存。

当前处理方式是在 `app.whenReady()` 里并行 fire-and-forget(`main.ts:4551-4558`),拿周期为 0,没有任何抢占式预热。全仓 `new Worker | SharedWorker | worker_threads` **零命中**。

### 2.5 🟢 启动剖析器 —— 与 C6 / 前篇 B1 打通

`cli/bin/startup-profile.cjs`(14.1 KB,**已读前 60 行**)。三个 Against- dependency constraints:

```js
// Loaded only by an explicitly profiled CLI entry, before the application bundle.
// Keep this independent of CellJS, logging, settings, and the business module graph.
const { performance } = require('node:perf_hooks');
const { AsyncLocalStorage } = require('node:async_hooks');
```

- **只在显式开启时加载**:`cli/bin/codebuddy` 第一行就是判断,`--startup-prof` 或 `CODEBUDDY_STARTUP_PROFILE=1` 才 require。**普通启动零 I/O**。
- **`AsyncLocalStorage` 做跨异步的耗时归因** —— 这比单纯 `performance.mark` 强在能把耗时归因到「哪个异步上下文」。
- **`unionDuration(intervals)`**:重叠区间只算一次 —— 避免并发 span 加总导致虚高:

```js
function unionDuration(intervals) {
    let total = 0, end = 0;
    for (const [start, stop] of intervals.sort((a,b) => a[0]-b[0])) {
        total += Math.max(0, stop - Math.max(start, end));
        end = Math.max(end, stop);
    }
    return total;
}
```

- **路径消毒**:拒绝控制字符、文件名禁止 Windows 保留设备名(`con|prn|aux|nul|com[1-9]|lpt[1-9]`),且注释写明 "File stems deliberately follow Windows rules on every OS for portable commands"。
- `cli/bin/codebuddy` 还顺手记录 `global.__CODEBUDDY_PROCESS_START_TIME__ = Date.now()` —— **在任何模块加载之前**。

### 2.6 🟢 lazy chunk manifest 契约 —— 「manifest 优先,readdir 兜底」三级降级

`cli/bin/preload-lazy-chunks.cjs`(3.5 KB,**已读前 50 行**)。头文件契约写得极清楚:

```
// 契约：
//   - chunkDir 是一个具体 variant 的 lazy 目录（例如 dist/lazy、dist/lazy-headless）
//   - 优先读 `<chunkDir>/manifest.json` 的 `lazy_files` 数组，只加载列表内的文件
//   - manifest 缺失 / JSON 破损 / IO 异常 → fallback 到 readdir 全加载（仅 .js/.cjs/.mjs）
//   - 目录整体不存在 → 返回 `{ source: 'missing', loaded: 0, failed: 0 }`，不抛
//   - 单个 chunk 加载失败静默计入 failed，不阻塞其它
//   - 返回值：`{ loaded, failed, source }`；source ∈ 'manifest' | 'readdir' | 'missing'
```

```js
// 优先读 manifest —— 只加载"本 bundle 版本"的 chunks，避免并发升级场景下
// 把外来版本的 chunks 加进本进程 require.cache 造成模块图污染。
```

**`source` 三态必显**是这个模式的核心 —— 调用方能知道自己是走了理想路径还是兜底路径。这与本项目既有纪律「回退链两态(`preset`|`inline`)不许拍平」是同一个思想。

#### 本项目现状

这个问题第二篇没有展开;C4 在这里给出**可量化的证据**,纠正一个容易误判的点:

`vite.config.ts:36-52` 确实配了 `manualChunks`,但那**不等于懒加载**。实测 `dist/index.html`:

```html
<script type="module" crossorigin src="./assets/index-MaC1QCIx.js"></script>
<link rel="modulepreload" crossorigin href="./assets/react-CTHL-zcr.js">
<link rel="modulepreload" crossorigin href="./assets/mui-MxTL-zA4.js">
<link rel="modulepreload" crossorigin href="./assets/zustand-BiXJSHW4.js">
<link rel="modulepreload" crossorigin href="./assets/markdown-BPng-4oj.js">
```

| chunk                  |          字节 | 是否首屏预载               |
| ---------------------- | ----------: | -------------------- |
| `index-MaC1QCIx.js`    |     897,942 | 是(入口)                |
| `markdown-BPng-4oj.js` | **790,856** | **是(modulepreload)** |
| `mermaid-cCWvpXYd.js`  |     679,730 | 否(唯一真懒加载)            |
| `mui-MxTL-zA4.js`      |     335,014 | 是                    |
| `react-CTHL-zcr.js`    |     233,351 | 是                    |

**首屏 ≈ 2.27 MB**。`manualChunks` 在这里只赚到了 HTTP 缓存粒度,**没省一个首屏字节**。全仓唯一的真动态 import 是 `src/components/ArtifactRenderer.tsx:120-129` 的 mermaid。

### 2.7 🟡 `main/` 184 模块 —— 一张可直接读的架构地图

这 184 个文件名本身就是 ArchUnit 级别的文档。按功能分组(🟡 **命名推断**,除已标注 🟢 的):

| 组别               | 模块(部分)                                                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **进程 / 生命周期**    | `core-process-roles.js` 🟢、`app-lifetime-job.js`、`app-lifetime-job2.js`、`sidecar-manager.js`、`sidecar-entry.js`、`bootstrap-daemon-in-main-process.js`、`daemon-app-server-entry.js`、`daemon-app-server-main.js`、`daemon-bootstrap.js`、`core-process-roles.js` |
| **本地 HTTP / 服务** | `server.js`、`runtime-http.js`、`runtime-handlers.js`、`http.js`、`network.js`、`transport.js`、`contract.js`、`origins.js`、`url-classifiers.js`、`eval-inject-server.js`                                                                                            |
| **性能 / 剖析**      | `perf-metrics.js`、`cdp-profiler.js`、`perf-profiler-handlers.js`、`perf-menu-state-sync.js`、`marks.js`、`startup-mark-log-mirror.js`、`update-timing-writer.js`、`memory-check.js`、`promt-trace-reporter.js`(`prompt-trace-reporter.js`)                          |
| **存储**           | `wal-checkpoint-worker.js` 🟢、`app-server-database.js`、`localstorage-migration.js`、`legacy-localstorage-fastpath-marker.js`、`file-authentication-storage.js`、`expired-dir-marker.js`、`archive-artifact-sweep.js`                                             |
| **安全**           | `secure-web-preferences.js` 🟢、`log-acl-guard.js`(**1.94 MB**,最大的单文件 🟡)、`credential-protection-bootstrap.js`、`threat-database-galileo.js`、`safer.js`、`log-acl-guard.js`、`install-dir-guard-i18n.js`                                                         |
| **更新 / 自检**      | `update-service.js`、`self-check.js`、`crash-reporter.js`、`office-file-association-repair.js`、`dock-recent-apps-repair.js`、`repair` 相关                                                                                                                         |
| **身份 / 配置**      | `workbuddy-product-config.js`、`workbuddy-paths.js`、`workbuddy-user-agent.js`、`app-instance.js` 🟢、`env-product-provider.js`、`dev-env-override.js`、`custom.js`                                                                                                |
| **窗口 / UI**      | `window-presentation.js`、`window-apps.js`、`title-bar-overlay.js`、`office-window-host.js`、`remote-window-broker-transport.js`、`browser-preview.js`                                                                                                            |
| **外部集成**         | `wecom-new.js`、`wecom-ioa.js`、`wecomaibot.js`、`wechatmp.js`、`wechatkf.js`、`weixin.js`、`qq.js`、`dingtalk.js`、`feishu.js`、`slack.js`、`discord.js`、`telegram.js`、`yuanbao.js`、`tencent-docs-main-integration.js`、`tencent-docs-document-lifecycle-port.js`      |
| **杂项基础设施**       | `deterministic-id-generator.js`、`md5-worker.js`、`package-log-worker.js`、`tar.js`、`zip-parser.js`、`clipboard-zip-reader.js`、`multipart-parser.js`、`json-schema-traverse.js`、`rolldown-runtime.js`                                                             |

> **值得一提的两个条目命名**:`deterministic-id-generator.js` 与 `expired-dir-marker.js`。前者说明他们在需要幂等/可复现 ID 的场景(证书、日志、缓存键)做了专门工具而不是随手 `uuidv4()`;后者说明有「目录过期」这种元数据的显式标记能力。这两项都🟡未读源码,只做登记。

---

## 三、可直接复刻(diff 级)

### C1 ⭐⭐⭐⭐⭐ 窗口安全档位表

**抄什么**:把 `webPreferences` 从「一处写死」改成「按窗口角色查表」,危险选项按名字领取且缺前置条件即 throw。

**本项目落点**:`electron/main.ts:555-561`

```ts
// electron/windowPreferences.ts  — 新增
type WindowKind = 'main' | 'first-party' | 'guest-popup' | 'artifact-preview' | 'image-decoder';

function createWindowPreferences(kind: WindowKind, opts: { preload?: string; partition?: string } = {}) {
    switch (kind) {
        case 'main':
            return { preload: opts.preload, contextIsolation: true, sandbox: true, nodeIntegration: false };
        case 'first-party':
            return { preload: opts.preload, contextIsolation: true, sandbox: true,
                     nodeIntegration: false, backgroundThrottling: false };
        case 'guest-popup':
            return { sandbox: true, contextIsolation: true, nodeIntegration: false };
        case 'image-decoder':
            // 危险档位必须有独立 partition，否则 refuse——照 WorkBuddy 的写法
            if (!opts.partition) throw new Error('image-decoder 需要显式 partition');
            return { partition: opts.partition, sandbox: false, nodeIntegration: false,
                     contextIsolation: true, backgroundThrottling: false };
        case 'artifact-preview':
            // 产物预览：照第二篇 B3，CSP 收紧到 connect-src 'none'
            return { sandbox: true, contextIsolation: true, nodeIntegration: false };
    }
}
```

**同时必须处理的**:主窗口 `webSecurity:false` 的注释理由是"`file://` 访问本地网关"。正解不是全局关 Web 安全,而是下面两条之一:

- **方案 A(推荐)**:网关响应加 `Access-Control-Allow-Origin` 头(资产可以只在 `127.0.0.1` 监听 + `Origin` 校验),然后恢复 `webSecurity: true`;
- **方案 B**:把需要跨源的那一个窗口单独拆出来,用单独的 `kind` 领取闭环。

**注意**:`sandbox: true` 会让 preload 只能访问受限 API 集。本项目的 `preload.cjs` 如果用了 Node 内置模块,开启 sandbox 会直接崩 —— **这是必须先验证的前置条件**,不要盲目改。

### C2 ⭐⭐⭐⭐⭐ SQLite WAL checkpoint worker

**抄什么**:§2.3 那个 worker 的整体形状,特别是 TRUNCATE→PASSIVE 降级与 `trigger:fallback-passive` 的可观测标注。

**本项目落点**:新增 `electron/walCheckpointWorker.ts`;挂载点在写 `llm_usage.sqlite3` 的地方。

注意**本项目与 WorkBuddy 的差异**:`llm_usage.sqlite3` 的写入者是 **Python 引擎**(`nanobot/nanobot/llm_usage/store.py:295-301`),不是 Electron 主进程。所以落点有两个选项:

- **选项 A(推荐,改动小)**:在 Electron 侧加 worker,用 `better-sqlite3`(JS 侧已可能有依赖)对同一库做定期 `wal_checkpoint(TRUNCATE)`。**必须与引擎的写入协调**(设 `busy_timeout`,接受偶尔 PASSIVE 降级)。
- **选项 B**:在引擎侧 `llm_usage/store.py` 加一个 checkpoint 调用点。**更贴合写入者**,但要注意 Python 侧的线程/锁语义。

> **先量后改**:现在 WAL 4.1 MB / 主库 143 KB(≈29:1)。加完之后应能在几秒内压到接近 0。**这是可以直接前后验证的**。

### C3 ⭐⭐⭐⭐⭐ 进程治理

优先级排序(按「不做的后果严重度」而不是「实现难度」):

| 顺序   | 动作                                                                                                          | 落点                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| C3-a | 补 `process.on('uncaughtException' / 'SIGINT' / 'SIGTERM')` + `app.on('will-quit')` 里 **同步等待** `taskkill` 完成 | `electron/main.ts:4567` 附近(`before-quit` 只有一处)                        |
| C3-b | 加单实例锁 + `second-instance` 唤醒已有窗口                                                                            | `electron/main.ts:4550` 之前,**在 `app.whenReady()` 前**                  |
| C3-c | 把三处复制粘贴的 `stop→waitForPortFree→start` 抽成 `restartServe()`,且 **`waitForPortFree` 超时后短路报错,不要盲启动**             | `main.ts:2005` / `2303` / `4454`(MCP / 模型 / 技能覆盖)                     |
| C3-d | 启动时扫 `run/gateway.*.json`,比对 pid 存活做 stale 清理                                                               | 新增;当前 3 份已死状态文件跨两个不同 config                                           |
| C3-e | 诊断包加进程维度:pid 列表 + 端口绑定快照 + `run/*.json` 与 pid 存活比对                                                          | `electron/diagnostics.ts:150-171`;分类手法抄 `core-process-roles.js` 的四桶模型 |
| C3-f | (较重)Job Object。需要 native binding,或降级为 **`will-quit` 里 await 住的 `taskkill /T`**                              | 只在确认 f 之前的措施不够时才做                                                     |

> **C3-c 现在有个真 bug**:`waitForPortFree(…, 5000)` 超时后代码**仍然照常 `startNanobot()`**(`main.ts:2005-2013`),必然撞 `EADDRINUSE`。

> **C3-b 有个比"双开"更具体的伤害路径**(第二篇提到过,这里补强):双开 → 第二实例走 `main.ts:837-851` 的"复用端口"分支 → 两个窗口共用一个引擎 → **第二实例退出时 `taskkill` 掉它以为是自己拉起的进程 → 第一个实例瞬间失连**。

### C4 ⭐⭐⭐⭐ lazy chunk + manifest 契约

- `src/router/index.tsx:1-14` 目前 12 个页面全部静态 import → 改 `React.lazy`
- 把 `markdown` 分包从 `modulepreload` 挪到按需(照 `ArtifactRenderer.tsx:124` 现成的 mermaid 写法)
- 预期收益:首屏 2.27 MB → 约 1.1 MB(matrix:markdown 790 KB 是最大的一块)
- **「manifest 优先 / readdir 兜底 / missing 不抛」三态反转** (`source` 必显) 这条,更适合用在**未来的扩展/技能目录加载**,而不是首屏

### C5 ⭐⭐⭐ CLI 预热池

不建议一步到位。对本项目来说,最小可行版是:

1. **先做 C6 埋点**,把「9.4 秒到底花在哪」测出来(可能集中在 Python import,那预热的收益就有限);
2. 再把引擎 spawn 提前到 `app.whenReady()` 之前;
3. 只有确认收益明确后,才考虑常驻预热进程。**管理端必须轻(纯 Node 内置模块),不与重 bundle 耦合** —— 这是 `cbc-prewarm` 的核心约束。

### C6 ⭐⭐⭐⭐ 启动剖析器

照 `startup-profile.cjs` 的**两个原则**做本项目版:

1. **默认零 I/O** —— 只有显式开关(`NANOWORK_STARTUP_PROFILE=1`)才加载采集器。
2. **独立于业务模块图** —— 不 import store / config / logger。

至少打三个点:`whenReady→窗口可见`、`spawn→first listen`(那个 9.4 秒)、`首 token`。配合第二篇 B1 的自包含 HTML 报告食用。

---

## 四、需重设计借鉴

| #      | 借鉴点                                        | 为什么不能直接抄                                                                              | 重设计方向                                                                                                      |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **J1** | `daemon-supervisor` 的三层进程拓扑                | 本项目当前<｜hy_place▁holder▁no▁813｜> `--foreground`,语义是「进程由 launcher 托管」而非 detached daemon | 先决定:要么转 detached daemon 形态(类 WorkBuddy),要么保持 foreground 但补 Job Object 兜底(更贴合现状)。**两条路互斥**,别混着走             |
| **J2** | `AsyncLocalStorage` 归因耗时                   | 渲染层是 React,不做 native 异步上下文追踪                                                          | 主线用于主进程的 gateway spawn / IPC 往返;渲染层用 `performance.mark` 即可                                                 |
| **J3** | `log-acl-guard.js`(1.94 MB,推测是防凭据落日志的守卫)🟡 | 体积说明它可能是通用 ACL 规则引擎                                                                   | 借鉴「**诊断/日志出口必须过一遍凭据过滤**」这个**位置**,不要抄实现。本项目 `diagnostics.ts:15-19` 已经有正确的意识(刻意排除含凭据文件),缺的是**内容级扫描**而不是清单级排除 |
| **J4** | `credential-protection-bootstrap.js` 🟡    | 未读源码                                                                                  | 登记,日后做凭据面加固时回来看                                                                                            |
| **J5** | `memory-check.js` / `self-check.js` 🟡     | 未读源码                                                                                  | 登记。第二篇 B8「引擎运行时自检」可以合并考虑                                                                                   |
| **J6** | `deterministic-id-generator.js` 🟡         | 未读源码                                                                                  | 若本项目需要跨进程/跨重启的稳定 ID,值得回来看它的种子策略                                                                            |

---

## 五、不要做

| 项                                                                                              | 原因                                                                                                               |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 复刻 `identical` Job Object native binding 本身                                                    | 本项目引擎是 **Python** 不是 Node;Job Object 需要 native module(koffi/NAPI)或抽象到主进程。除非 C3-f 确认必要,否则先用 `taskkill /T` + await |
| 复刻整套 `sandbox/5.8.5` tsbx 规则系统                                                                 | 第二篇已评:OS 级沙箱差距大,但 tsbx 是为会话 chmod 目标设计的,体量与本项目不匹配                                                                |
| `wecom-*` / `wechat-*` / `dingtalk` / `feishu` / `slack` / `discord` / `telegram` 等 14 个渠道集成模块 | 腾讯生态 + 海外 SaaS 分发,与本项目定位无关                                                                                       |
| `tencent-docs-*` / `office-window-*` / `office-file-association-repair`                        | 同上                                                                                                               |
| 1.94 MB 的 `log-acl-guard.js` 整体移植                                                              | 体量过大且用途未验证;只借「过滤位置」的设计                                                                                           |
| `qimei-helper.js` / `turing-sdk.js`                                                            | 设备指纹与风控,不需要                                                                                                      |

---

## 六、落地顺序与验证纪律

**推荐顺序**(每步独立可合、可回滚):

```
C3-b 单实例锁        ┐
C3-a + will-quit     ├─ 第一批：一口气解决「双开 / 崩溃留孤儿」
C3-c restartServe()  ┘
        │
C1 窗口档位表        ─┐
  └─ 前置：先验证 preload.cjs 能否在 sandbox:true 下工作（不能则先只做 webSecurity 分流）
        │
C2 WAL checkpoint    ─┤ 第二批：安全 + 存储卫生，都有可观测的前后数值
C3-e 诊断包进程维度   ─┘
        │
C6 启动埋点          ─┐
        │             ├─ 第三批：先把「9.4 秒」拆开，再决定要不要做 C5
C3-d run/ 僵尸清理    ─┘
        │
C4 路由懒加载        ── 独立，任何时候可做
        │
C5 预热              ── 等 C6 的数据说话
```

**验证纪律**(照项目既有做法):

1. **每个整改项都要有变异验证**:改回旧写法 → 对应用例必须变红。特别是 C1 的 `throw Error('image-decoder 需要显式 partition')`,需要一条「缺 partition 必须抛」的用例。
2. **改 `electron/**.ts` 必须重建 `main.cjs` + `preload.cjs`** —— `build:electron` / `electron:serve` 才会重新生成,**不要手改 `.cjs`**。
3. **门禁三套 tsc 一起跑**,且带 `--max-workers=3`;跑全量要带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`,**永远看退出码**。
4. **C2 前后必须实测**:`ls -l llm_usage.sqlite3-wal` 的字节数。这就是最直接的成功判据。
5. **C1 之前先做前置验证**:`sandbox: true` 会让 preload 失去 Node API。先在 dev 里跑一次,别指望 typecheck 能发现。

---

## 附录 A:复现本篇证据的命令

```bash
# ① 全目录（会 integrity 硬失败）
npx -y rea-agents@6.5.0 analyze-javascript-application \
  "D:/Program Files/WorkBuddy" --json

# ② 续跑 + 加大堆（会因 parent 结果容量超容而中断）
npx -y rea-agents@6.5.0 analyze-javascript-application \
  "D:/Program Files/WorkBuddy" --json \
  --integrity-policy record-and-continue --max-heap-mb 6144

# ③ 正确的做法：定向 app.asar + 精选 source-path
npx -y rea-agents@6.5.0 analyze-javascript-application \
  "D:/Program Files/WorkBuddy/resources/app.asar" --json \
  --integrity-policy record-and-continue --max-heap-mb 4096 \
  --source-path main/app-instance.js \
  --source-path main/core-process-roles.js \
  --source-path main/wal-checkpoint-worker.js \
  --source-path main/secure-web-preferences.js
```

抽取可读源码(本篇用它读到了 §2.2 / §2.3 的全文):

```bash
# app.asar.unpacked/cli/bin/*.cjs 是可直接读的明文
head -60 "D:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/bin/no-orphans.cjs"

# app.asar 内的 main/*.js 需要先抽出（注意 asar 头是这个布局：
#   [0:4]=4  [4:8]=N+4  [8:12]=N  然后才是 N 字节的 header JSON）
# 见文档末尾 helper 的 asar_dump.py
```

> 本篇中间产物(两个百兆级 JSON)已清理。保留:`docs/rea/rea-main-core.err`(进度日志,4 KB)与 `docs/rea/_extracted/`(抽出的 4 个模块源码,共 ~7 KB,作为一手证据)。

---

## 证伪清单(本篇留给自己日后回看)

| 结论                                 | 证据强度                | 待验证点                                        |
| ---------------------------------- | ------------------- | ------------------------------------------- |
| C1 的档位表可迁移                         | 🟢 源码已读             | `sandbox:true` 与本项目 `preload.cjs` 的兼容性未验    |
| C2 的 worker 可迁移                    | 🟢 源码已读             | Electron 侧 JS 写引擎侧 Python 持锁的 SQLite,并发语义未验 |
| C3 supervisor 三层拓扑                 | 🟢 源码已读             | 本项目是否要转 detached daemon 形态是**产品决策**,未定      |
| C4 首屏 2.27 MB                      | 🟢 dist 实测          | 改 lazy 后的真实收益需实测                            |
| C5 预热收益                            | 🟡 未测               | 「9.4 秒」的成分未知,可能集中在 Python import 层          |
| `main/` 模块职责分组                     | 🟡 **命名推断**         | 除标 🟢 的 6 个外均未读源码验证                         |
| `log-acl-guard.js` 是凭据过滤           | 🟡 **纯文件名推断**       | 1.94 MB 体积,内容未读                             |
| ASAR integrity 对 unpacked 原生文件天然失效 | 🟢 REA 明示 + 20+ 条实例 | —                                           |
