> **这是发布副本。** 里面只有运行插件需要的东西。作者开发副本里的自检套件
> （`tools/verify-*`）与绑定了开发机路径的安装脚本**不随包发出**——下文提到它们
> 的地方属于开发记录。**安装请从 [INSTALL.md](INSTALL.md) 开始。**
>
> 下文中出现的绝对路径都是**作者机器的开发记录**，不是给你的操作指令。

# dsh-boot-animation

DSH 启动加载动画：短片**片尾交叉溶解进界面**、多片随机、启动进度可见、启动失败有兜底，**淡入时长 / 进入方式 / 素材池都在「设置 → 插件」里可调**。**不改 DSH 本体源码**，升级 DSH 不受影响。

## 先看哪一份

| 文档 | 给谁 | 内容 |
|---|---|---|
| **[MANUAL.md](MANUAL.md)** | 用它的人 | 设置在哪、怎么换片子、徽章什么意思、出问题怎么办 |
| **[AGENTS.md](AGENTS.md)** | 接手维护的人 / AI | 架构、**不许破坏的规则**（每条都是踩出来的）、改动后要不要重启、怎么自检 |
| 本文件 | 想追根究底的人 | 每个坑的完整来龙去脉与证据 |

下面这份是全景记录，篇幅长；日常使用看 MANUAL 就够。

## 设置在哪里

**设置 → 插件 → 「插件配置」**，里面会多出一行「启动动画」——**和其他插件一样是收起的**，点一下才展开：

| 项 | 作用 |
|---|---|
| **开启启动动画** | 总开关。关掉就是**完全不注入**——没有覆盖层、不发任何素材请求，回到 DSH 原生启动页 |
| **淡入时长** | 1 / 1.5 / 2 / 3 / 4 秒，默认 2 秒 |
| **进入方式** | 片尾交叉溶解（默认）/ 放完再淡 / 点击才进 |
| **素材池** | 勾选哪些片子参与随机轮播（**读的是设置本身，所以勾完立刻变**）；每行会**实际播放一遍**给出结论：时长（读到元数据就有），外加**只在有问题时**才出现的徽章——`浏览器播不了`（解码被拒）、`一直没有画面`（能开始播但 8 秒没出画面）、`未优化`（`moov` 在文件尾） |

**总开关不是"脚本自己判断一下然后什么都不做"**，而是 Host 侧直接不加那两行注入。这样关掉之后是真的关掉：没有覆盖层占着视口，没有配置全局变量，也没有一次素材请求。`verify-settings.mjs` 断言了这一点——关掉时注入行数是 **0**，打开时是 **2**。

**默认收起**是有意的：这一页是插件清单，"哪张卡片展开"是用户的阅读动作，由卡片自己持有；一张进来就把控件摊开的卡片会把下面所有插件挤出视野。折叠头的字号、圆角、边框、层级底色和箭头动画都是从 harness 自己的卡片样式（`ui-settings-plugins/src/client/PluginCard.module.css`）抄来的，token 名同样是 `--dsw-alias-label-*` / `--dsw-alias-bg-layer-*`，所以它在清单里看起来是原生的而不是外来的。

还有一处性能上的理由：素材池要读一次清单、再给每条起一个 `<video preload=metadata>` 探时长。**这两个副作用都挂在「已展开」上**，所以收起状态下这张卡片一次请求都不发。

改完**刷新页面生效**，不用重启 DSH（改了 `entry.js` 的那次除外），也不用重新构建。

> **下面这段记的是 0.2.0-rc.2 之前的接法，已经失效**——保留它是因为症状仍然会以同样的面目出现。当前事实见紧随其后的「适配 DSH 0.2.0-rc.2」。

它是怎么接进去的：DSH 的设置页把「插件配置」页渲染成**两份账本的交集**——Host 提供（`settings.register`）的设置命名空间，和浏览器注册进 `settings.plugin.item` 槽位的卡片。两张卡片的配对键就是命名空间字符串（`boot-animation`），所以两半各在一边、互不相识。这也是 DSH 给**本仓库之外的插件**预留的路径，`ui-settings-plugins` 的槽位注释写得很明白。

> **卡片这一半我没法在这里验证。** 客户端 React 组件在真机 GUI 里长什么样、点下去有没有反应，只有你刷新看一眼才知道——沙箱里起不了浏览器。我能做到的是：把 `lib/client.js` 加载进桩 React + 桩 DOM **真渲染一遍**，断言三个小节渲染出来了、当前值被标为选中、点「4 秒」真的把 `fadeMs: 4000` 写进设置。这能拦住"接线错了/渲染抛了"，拦不住"样式在真主题下难看"。

### 适配 DSH 0.2.0-rc.2（当前事实）

DSH 0.2.0-rc.2 **删掉了 Host 侧 `settings.register(ns, schema)`**：现在命名空间不是"注册"出来的，而是**由插件条目本身派生**的。规则有三条，缺一条卡片就不出现：

1. **声明，而不是注册。** 插件模块的导出对象上要有一个 `Config`（schemastery schema）。`RegistryService.plugin()` 把它记成 `runtime.Config`，`@deepseek-ai/dsh-settings` 的 `describe()` 只挑**正在运行、且解析得到 `Config`** 的条目。
2. **命名空间 = profile 补丁里的条目 id。** 这里是 `cordis.patch.yml` 里的 `- insert: id: boot-animation`。浏览器半侧在 `src/client.js` 的 `SETTINGS_NAMESPACE` 里写同一个字符串，通过客户端的 `configForms` 服务（`whileServed` + `get`）接上——**没有第二本账**，也不再有 `settings.plugin.item` 这个槽位（现在是 `plugins.item`）。
3. **字段必须标 `.volatile()`。** `describe()` 内部先做一次 `volatileForm(schema)` 投影，**只保留 volatile 字段**；一个 volatile 字段都没有时它返回 `undefined`，条目被整个跳过——`describe()` 连这条都不返回，`whileServed` 自然永不触发。写入侧同样：`write()`（`update`/`replace`/`mutate` 全走它）对非 volatile 路径直接抛 `Config field "..." is not volatile`。所以四个字段全部标了。

`.volatile()` 还有一个必须知道的后座力：**它在 `apply(ctx, config)` 里给的不是值，是一个稳定引用**（`{ get() }`，用 `Symbol.for('cosmokit.volatile.write')` 跨 ESM/CJS 副本识别）。要 `.get()` 才是当前快照——`dsh-bash-local` 也是这么读的（`config.timeoutMs.get()`）。这也是"改完刷新就生效"的机制：只有 volatile 值变化时，`@deepseek-ai/cordis-plugin-loader` 会把新快照**原地提交进同一个引用**并发出 `loader/volatile-update`，**不重启 fiber**，所以下一次 index 渲染读到的就是新值。`entry.js` 里对应的是 `readField()`。

还有一处**没有变、但更致命**的依赖：`Config` 必须是模块命名空间对象上的属性，所以 `import z from '@deepseek-ai/schemastery'` 变成了**静态导入**（老的惰性 `import` 永远声明不出 `Config`）。代价是失败模式变了——**schema 包解析不到，整个模块都求值不了**，路由和开机画面一起没了。因此 `package.json` 里它是 **`peerDependencies: { "@deepseek-ai/schemastery": "*" }`**（由宿主提供，不再声明 `dependencies`），而盘上那份链接必须指向**内核用的副本（3.18.4 或更新）**——工作区检出旁边那份 3.18.1 的 `lib/index.mjs` 与 `lib/index.cjs` 里 `volatile` 出现 **0 次**，直接调用会让模块求值即抛。`entry.js` 的 `LIVE_CAPABLE` 先探测该方法：有就标 volatile，没有就退化成普通 schema，并在 `apply` 里留一条说明该改哪个链接的告警——最坏情况是"卡片不出现 + 一条可诊断的告警"，而不是插件全灭。

### 装依赖的一个坑（已踩，惰性导入时代的历史）

设置命名空间需要一个 schema，用的是 DSH 自己的 `@deepseek-ai/schemastery`。它在 `entry.js` 里是**惰性 `import`**，而 **ESM 解析不认 `NODE_PATH`，只从"导入文件所在目录"逐级往上找 `node_modules`**——而且会先把符号链接解析成真实路径。

本插件是通过 junction 装进 profile 的，真实路径是 `D:\DSH\dsh-boot-animation\package`，上一级根本没有 `node_modules`，于是 `import` 必然失败（表现是"设置里没有这张卡"，但插件本身照常工作，因为 registration 失败只损失设置面）。两处修好了：

1. `package.json` 声明了 `dependencies: { "@deepseek-ai/schemastery": "^3.18.4" }`——正规 pnpm 安装时，pnpm 会在包的真实路径旁建 `node_modules`，就能解析。
2. 当前这个 junction 安装，在包内建了 `node_modules/@deepseek-ai/schemastery` → profile 那副本的链接，所以**现在就生效**。

`tools/verify-settings.mjs` 专门验这件事：它**从 profile 的链接位置导入 `entry.js`**（和真实加载一致），然后断言 schema 真的注册上了、默认值/上下界/枚举都对。如果你哪天重装依赖把这个链接弄没了，这个套件会从"18/18"变成报告 `schema path: not exercised`。

> **这两条现在都过时了，但结论反过来更要紧。** `entry.js` 改成了**静态**导入（`Config` 必须是模块导出对象的属性，惰性导入永远声明不出来），`package.json` 里它也从 `dependencies` 移到了 `peerDependencies: { "@deepseek-ai/schemastery": "*" }`。盘上那个可解析的副本仍然必须存在——但**必须是内核用的那份 3.18.4+**；指到工作区检出旁边的 3.18.1，`LIVE_CAPABLE` 探测失败，卡片不出现并留一条告警（详见上一节）。

### 卡片没出现的第二个坑：`ctx.get` 抢跑

第一次装完卡片**没有出现，而且控制台一个字都没有**——最坏的一类失败。根因是 `ctx.get('slots')` 在客户端运行时读不到服务，代码按「服务不可用」静默 `return`，于是**「服务迟到」和「服务不存在」是同一个值**，无从区分。

查法是把整个部署里**所有**客户端产物扫一遍，比对可用写法，结论很干脆：

| 项 | 结果 |
|---|---|
| 用 `ctx.get('slots')` + `ctx.get('settingsScope')` 的产物 | **本插件是全 profile 唯一一个** |
| 用 `ctx.inject([...], cb)` 的产物 | image-gen(4) / git-graph(2) / model-selection(2) / genui / better-sidebar / harness 自己的包——全部 |
| 回调里怎么读服务 | `owner.get('sessions')` 这种形式，不是属性访问 |

两个原因叠在一起：本插件没有声明服务依赖，**可能在 `ui-settings` 应用到之前就 `apply`**，一次性 `get` 就抢跑了；而 `ctx.inject` 会等。已改成：

```js
ctx.inject(['slots', 'settingsScope'], (owner) => {
  const slots = owner.get('slots')      // 不是 ctx.get，也不是 owner.slots
  ...
})
```

`verify-client-bundle.mjs` 现在有一条断言：**剥掉注释后，代码里不许出现 `ctx.get(`**，且必须走 `ctx.inject`；桩上下文也**只**提供 `get`、不提供属性，所以退回属性访问会在这里就红。（断言必须先剥注释——产物是源码原样拼接，模块头解释旧写法的那段话会被正则误抓，这个坑今天踩了两次。）

## 它长什么样

`dsh web` 每次加载页面时：

1. 一屏深蓝深海底 + 一条短片（从素材池随机取一条，不连着重复同一条）。**只放一遍，不循环**
2. 底部一条细进度条，跟着真实插件激活进度走
3. **片尾交叉溶解成界面**（默认）——淡入正好在片子放完那一刻结束。也可在设置里改成「放完再淡」或「点击才进」；想早点进，点一下画面或按 Esc / 空格 / 回车
4. 启动失败时不硬拦——提示行变琥珀色「启动失败，点击查看」，点掉就能看到错误报告
5. 启动超时（默认 15s 还没就绪）也会放开，提示「启动较慢，点击继续」

## 进入时机：三种方式

### 片尾交叉溶解（默认）

**淡入不是"放完再淡"，是从片尾往前 `FADE_MS` 开始淡。** 15 秒的片子、2 秒淡入，就从 **13 秒**开始溶解，到 **15 秒**两者一起结束——而不是先播完、停在最后一帧、再淡 2 秒。这是**交叉溶解**：影片在最后两秒逐渐让位给界面。

触发不是"排一个定时器"，而是**每帧检查 `片长 − 当前进度 ≤ FADE_MS`**：

- 定时器在播放卡顿时就会偏——而"正好落在最后一帧"恰恰是这里唯一要买的东西。
- 检查同时挂在 `requestAnimationFrame` 和 `timeupdate` 上：前者帧级精确但后台标签页会被节流，后者粗糙但那时还有效。**两个都不能少**。
- 真正触发时，淡入时长用的是**当时的真实剩余时间**（不是配置值本身），所以即使检查晚了一帧，落点仍然在片尾。

### 放完再淡

片子完整放完、停在最后一帧，再淡出。想要"一点不截断"就用这个。

### 点击才进

短片**循环播放**（所以没有片尾可等，`ended` 根本不触发），直到你点一下才进。第一下点击开声音、第二下进入——这是最早那版的两步设计，现在作为可选方式保留。

| 方式 | 片子循环 | 谁触发进入 | 淡入起点 |
|---|---|---|---|
| 片尾交叉溶解 | 否 | 片尾 + 内核就绪 | 片尾前 `FADE_MS` |
| 放完再淡 | 否 | 片子结束 + 内核就绪 | 片子结束后 |
| 点击才进 | **是** | 只能是你点 | 点击当下 |

### 三种方式共同的第二个条件：内核就绪

淡入就是界面显形的过程，所以它只能在界面真能显示时才启动——启动慢时短片继续放，就绪那一刻立刻从当前位置开始淡。没有这个条件，片尾一到就会溶解出一个还没搭好的界面。例外是「点击才进」：它连内核就绪都不自动放行，因为那本来就是你说了算。

### 尾部溶解不适用时

| 情况 | 为什么 |
|---|---|
| 片子短于 `2 × FADE_MS`（默认 4 秒） | 溶解得从片子还没出现时就开始，那是坏效果 |
| 时长未知（MediaRecorder WebM，`duration` 是 `Infinity`） | 没有片尾可以倒推；走 20 秒兜底计时器，不会永久卡住 |
| 内核在片尾窗口之后才就绪 | 只能从那一帧起淡 |

### 启动路径上每个「走不下去」的地方都有上界

这张表是 2026-09-28 那次连续出问题之后补的：**这个屏幕是装饰品，它没有任何一种失败可以合理地扣住用户**。每一条都由 `verify-enter-sequence.mjs` 用假时钟真跑一遍。

| 卡在哪 | 谁来放开 |
|---|---|
| 素材清单请求挂住不回应 | 10 秒后当作「没有素材」，就绪即进 |
| 素材池是空的 | 同上，立刻放行 |
| 某段片子开始播了但一帧都出不来 | 6 秒后换下一段；全部失败则就绪即进 |
| 片子放完但内核还没就绪 | 停在最后一帧等 `clientReady`，就绪立刻进 |
| 片子时长未知（`duration` 是 `Infinity`） | 20 秒兜底 |
| 内核启动失败 | 提示行变琥珀色「启动失败，点击查看」 |
| 内核一直不就绪 | 15 秒提示「启动较慢，点击继续」（可点） |
| 以上全部失效 | 按 Esc / 空格 / 回车 随时直接进 |

`verify-exit-simple.mjs` 断言 `maybeEnter` 的函数体里**没有 `duration`、没有 `setTimeout`、没有毫秒阈值**——哪天有人加一个"最多等 10 秒"之类的判断，8 秒和 15 秒的两段片子立刻就不同命了。`verify-enter-sequence.mjs` 则用桩 DOM 真跑时序，三种进入方式各有用例：离片尾 2.1 秒不淡、进 2 秒窗口才淡、用的是剩余时间而不是配置值；「放完再淡」进窗口也不提前淡；「点击才进」片子循环、内核就绪和片子放完都不进、按一下才进。还有一条兜底：**全部素材取消勾选时忽略清单照常播**——否则池子空了就永远到不了交接。

> 代价：**进入前的等待等于片长。** 抽到 15.10s 那段，不点的话就要看满 15 秒。想早点进随时点一下或按 Esc。

## 退出方式：尾部一次交叉溶解

只有这一种。深海底、短片、底部进度条作为一个整体一起走，没有分屏、没有故障效果、没有配置项。

早期版本做过 `random` / `fade` / `split-v` / `split-h` / `glitch` 五种可选过渡（`transition` 配置键），已经**全部删掉**，只保留溶解：

- 分裂要靠"把当前帧冻结成一张图再切成两半"（一个 `<video>` 不能同时出现在两处），多一层合成就多一层可能出错的时序。
- 故障效果的实现仍在 `tools/transition-sampler.mjs` 里（本地样本页，端口 8880），要回看或提取随时可以，但它不在启动路径上。

淡出的两条硬要求，都由 `verify-exit-simple.mjs` 守住：

1. **覆盖层必须整个消失**。早先只淡出下方 chrome、留着不透明面板，结果转场后那层面板还盖在对话上面。现在淡出结束（`FADE_MS + 100`）时整块节点从 DOM 移除，没有任何东西留到淡出之后。
2. **声音不能跟着淡出被掐掉**。淡出前先把**还在播放**的 `<video>` 摘到 `<body>` 上（脱离正在移除的覆盖层），它继续放；1 秒时视频才淡出，3.3 秒才暂停并移除。所以提前跳过时听见的那一拍不会断在转场里。

   > 已经播完的片段**不摘也不重播**。`audioRetry()` 里那句 `play()` 对播完的元素等于回到 0 秒重放，自动交接恰好总是发生在片尾，不挡住它就会在淡出底下把整段片子重演一遍。

地址加 `?dshbootdiag=1`，诊断行会显示这次的实际播放、音频与交接状态（`done=` 片子是否放完、`boot=` 内核是否就绪、`fade=` 淡出时长）。

## 关于声音（浏览器的硬规则）

**Chromium 不允许没有用户手势的带声音自动播放**（`play()` 返回 `NotAllowedError`）。短片以静音开始，声音靠**一次点击**解锁——但**进入不再需要点击**，因为片子放完自己会进：

| 操作 | 发生什么 |
|---|---|
| **点一下画面** | 开声音。这次点击是音频策略要的手势，画面**留着继续演** |
| 声音已开时再点一下 | 提前进入（跳过剩下部分） |
| **什么都不点** | 片尾 2 秒自动开始溶解，片子放完时正好进界面 |
| 按 Esc / 空格 / 回车 | **直接进入**（不给键盘用户加多余一步） |

提示行会跟着状态走：静音时是「点一下开声音 · 播完自动进入」，开声后变成「播完自动进入 · 点一下提前进」，不用猜为什么点了没反应。

**为什么不把"开声音"和"进入"绑成一次点击**：手势解锁声音需要时间起效，而"进入"会关掉画面——绑在一起就是"刚出声就进界面"。所以开声音那一下**故意不进入**，让片子继续放；进入交给片尾。**提前跳过**（而不是尾部溶解）时，短片会被摘到 `body` 上继续放、1 秒开始淡出、3.3 秒才停止，声音不会在转场里被掐断。

> 「摘走短片」这一步在尾部溶解里**故意不做**：溶解要的就是影片和覆盖层一起变淡，把短片摘到 `body` 上会变成一块不透明的视频压在界面上，交叉溶解就没了。两条路径的区别正是这里。

想完全免点击：多点几次第一次（积累媒体参与度 MEI），Chrome 记住这个来源后就会**自动带声**；或在 Chrome 地址栏左侧 → 网站设置 → 声音 → 改成 **「允许」**（注意 **「自动」≠「允许」**，前者只是交给 Chrome 判断）。

### 卡住时怎么诊断

给地址加 `?dshbootdiag=1`，提示行会变成实时读数：

```
diag shown=1 rs=4 muted=true t=3.2 dur=8.1 paused=false ended=false done=0 boot=1 tail=0 fade=2s stall=- err=- audio=refused
```

`shown` = 画面是否已显形 · `rs` = readyState · `muted` = 是否静音 · `t` = 播放位置 · `dur` = 片子时长 · `paused` / `ended` = 元素自身的状态 · `done` = 片子是否已放完 · `boot` = 内核是否就绪 · **`tail` = 尾部溶解是否已经开始**（`1` 的那一刻 `t` 应该正好是 `dur − 2`） · `fade` = 标称淡入时长 · `stall` = 距上次卡顿多久 · `err` = MediaError 码 · `audio` = 声音策略结果。

想知道"淡入是不是在 13 秒开始"，就看这一行：`dur=15.1` 时 `tail` 应该在 `t≈13.1` 翻成 `1`。`dur` 比 `t` 大说明还在放；`boot=0` 说明内核还没就绪（此时即使进了片尾窗口也不会淡，这是故意的）。

## 为什么是插件而不是改源码

启动页 `packages/client/web/src/boot-page.ts` 由内核在 shell 模块脚本里同步创建。唯一比它更早的时机是**索引注入**：本插件在 Host 侧订阅 `webserver/index-inject`，往 `<head>` 插一行解析阻塞脚本。那行脚本在内核启动页出现之前就已经占住了视口。

顺带避开一个坑：入场层挂在 `document.body` 上、**不放进 `#root`**，所以 `ui-renderer` 挂载时 `#root` 里没有 `[data-dsh-boot]`，走的是 `createRoot` 而不是 `hydrateRoot`，不存在 hydration 内容不匹配的问题。

## 装法

两条路，选一条。**免重启**改动最小，**重启**写入的是正式依赖声明。**路一只是"先看效果"，最终状态应当是路二**：路一不写依赖声明，profile 里那次 `pnpm install`（例如你以后用 `dsh plugin add` 装别的插件）可能把这个未声明的链接剪掉，而 `cordis.patch.yml` 里那行 insert 还在——那时 DSH 会因为"行解析不到包"再次起不来。路二把插件变成和另外 15 个插件一样的 bundle 层，并在同一步里把路一追加的那行移除（同一插件被两层各挂一次会产出**两条同 id 的 entry**，已实测）。

### macOS / Linux：一条路

Windows 那两条路在这里合成一条：`tools/install.sh` 直接把插件接线成正式依赖（路二的终态），跑完重启一次。

```sh
sh tools/install.sh --profile desktop   # 桌面版（DSH Desktop 用的那个 profile）
sh tools/install.sh                     # dsh web 用的那个（默认就是 web）
```

三个参数值得记一下：`--profile`（装进哪个 profile，默认 `web`）、`--dsh-home`（先看 `DSH_HOME`，再找 `~/.dsh`）、`--package-dir`（默认是本脚本所在包的根目录）。

它做四件事：备份 profile 的 `cordis.patch.yml` → 在 profile 的 `node_modules` 里建链接 → 往 `cordis.patch.yml` 追加一行 insert → 把一份 ≥3.18.4 的 `@deepseek-ai/schemastery` 链进包目录（少了它设置卡片会静默消失）。**不跑 pnpm、不改 `package.json`**；如果这台机器已经把它当作 bundle 层挂着，它会直接收工，不会挂出第二条同 id 的 entry。

跑完**完全退出并重开 DSH**。撤销：

```sh
sh tools/uninstall.sh                  # --profile 同上
```

它只摘掉自己追加的那三行、删掉链接，并断言 `cordis.patch.yml` 回到安装前的字节（你原有的行、注释、CRLF、末尾换行都原样保留）。

> 这两个脚本是 macOS / Linux 版；`tools/*.ps1` 与 `.bat` 仍是 Windows 专用。

### 路一：免重启（推荐先试）

```powershell
powershell -ExecutionPolicy Bypass -File D:\DSH\dsh-boot-animation\package\tools\apply-live.ps1
```

只做三件事：备份你的 `cordis.patch.yml` → 在 profile 的 `node_modules` 里建一个目录链接 → 往 `cordis.patch.yml` **追加**一行（你原有行不动）。**不碰 `package.json`、不跑 pnpm、不重启 dsh。**

原理：profile 的 `patchReload` 默认即 `live`，CLI 会给 `cordis.patch.yml` 装一个 Cordis HMR 监听器；文件一变就重新组合整个 patch 列表并**事务性热应用**到根 include。patch 行里的裸包名走 loader 的 `bareModuleBaseUrl` 从 profile 的 `node_modules` 解析，所以不必出现在 `bundle` 列表里。

**跑完刷新浏览器**：看到深海底 + 短片 + 进度条 + 「播完自动进入 · 点一下提前进」就是成了；若仍是原样，说明这台机器上 watcher 没按预期生效，改走路二。

撤销（同样不用重启）：

```powershell
powershell -ExecutionPolicy Bypass -File D:\DSH\dsh-boot-animation\package\tools\rollback-live.ps1
```

### 路二：重启安装（写正式依赖）

```powershell
powershell -ExecutionPolicy Bypass -File D:\DSH\dsh-boot-animation\package\tools\apply-boot-animation.ps1
```

双击版：`D:\DSH\dsh-boot-animation\apply-boot-animation.bat`（**必须在 dsh 之外的窗口运行**——它会杀掉 3080 上的进程，也就杀掉了跑在 dsh 里的东西，包括帮你写这段的助手；它自己的控制台不受影响）。

1. **写回滚点** —— profile 配置快照 + SHA256 清单，落到 `D:\develop\dsh\.dsh-rollback-bootanim-<时间戳>`
2. **迁移接线**（`tools/migrate-wiring.mjs`，可先预演）—— 写 `dependencies`（`link:` 指向本包）+ `dsh.profile.bundles`，**移除路一在 `cordis.patch.yml` 里追加的 insert 行**（两层都挂会产出两条同 id 的 entry，已实测），建 node_modules 链接，然后用 **dsh 自己的 profile 加载器**断言"本插件恰好一层、组合后恰好一条 entry"；断言不过就自己把两个文件还原
3. **同步 lockfile** —— 跑 `pnpm install`（带 `minimumReleaseAge` 回退），让 lock 与 `node_modules` 一致；**失败不致命**（启动走链接，不读 lock），只警告并给出补跑命令
4. **重启并自检** —— 重启 dsh，然后自检；自检分两档，取决于能不能拿到那行令牌 URL：
   - **强校验**：抓到 `dsh web: http://127.0.0.1:3080/?token=…` → 用令牌换 cookie → 断言**真实首页里含本插件的注入标记**，且注入行**排在 shell 脚本之前**
   - **降级校验**：抓不到（启动器有自己的控制台，那行不一定进日志）→ 断言服务在应答、composition 在盘上齐全（依赖已声明、bundles 已含、node_modules 链接在、Host 入口与 Client 产物都在），**并且打一遍插件自己的路由**（`clips.json` 有片子 + `Range` 请求回 206）——这一条能证明 Host 半侧真的挂上了，光看"文件在盘上"证明不了
   - 两档都会**明确告诉你验证到了哪一步**，不含糊
5. **失败自动回滚** —— 自检不过就还原配置、按快照恢复/移除链接、重新拉起，并给出回滚点路径

退出码：`0` 装好且自检通过；`1` 失败但已回滚且服务恢复；`2` 失败且需人工介入。

**为什么必须重启 dsh**：客户端模块图是**启动时快照**——`client-modules` 在启动时扫描 loader 条目、组合客户端 bundle；免重启路径只热应用 patch 层，Host 侧（素材路由 + 索引注入）能立刻起来，客户端半侧却进不去，要等重启才补齐。入场层脚本本身不是原因：`entry.js` 每次渲染索引都重新读一次 `src/boot-screen.js`，改文案不必重启。

**也可以手动接线**（等价，不跑脚本）：

```bash
dsh plugin --profile web add link:D:/DSH/dsh-boot-animation/package
```

或在 `.dsh/profiles/web/package.json` 里加 `"dsh-boot-animation": "link:D:/DSH/dsh-boot-animation/package"` 到 `dependencies`、把 `dsh-boot-animation` 追加到 `dsh.profile.bundles`，再把包 junction 到 `node_modules/`，最后重启 dsh。

> ⚠️ **四个 PowerShell 脚本必须是纯 ASCII。** Windows PowerShell 5.1 会把无 BOM 文件的 CJK 字节按系统 ANSI 解码，足以吃掉字符串终止符、让整个脚本报 "missing terminator" 并指向无关行号。脚本里因此用通配符解析启动器路径，而不是写中文文件名；`tools/verify-powershell-ascii.mjs` 会守住这条。

## 放视频

把 mp4 / webm 丢进 `assets/videos/`，**不用改代码、不用重新构建**。Host 每次请求 `clips.json` 都实时扫目录；增删文件刷新页面即生效。

素材的缓存规则分两种，区别很重要：**整片响应**用 `no-cache` + `ETag`（要问一次，没换片就 304 秒回）；**切片响应（206）用 `no-store`**，绝不允许被当成完整资源留下来。

manifest 给每条 src 拼一个 **`?v=<mtime>-<大小>`** 版本号：**同名替换素材**（比如把片子重新导出一遍覆盖原文件）时版本号会变，浏览器不会拿旧缓存糊弄你。`delete + 重新放入` 也一样生效。

版本号里带上**大小**不只是更精确——它还救过一次现场：旧的坏缓存条目是按「只有 mtime」的 URL 存下来的，**换成新格式等于把所有旧 URL 作废**，普通刷新立刻重新取，不必先让用户按一次 Ctrl+Shift+R。（`no-store` 只能阻止写入新的坏条目，清不掉已经存在的。）

### 为什么切片不能缓存（2026-09-28 踩的坑）

症状是：**普通刷新（Ctrl+R）时 `1.mp4` / `2.mp4` 播不出来，界面只剩背景色；硬刷新（Ctrl+Shift+R）三段都正常。**

原因是这三件事凑在一起：

1. 入场层播完（或跳过）时**替换 `<video>` 元素**，这会**中断还在传输的媒体请求**；
2. 浏览器把已经收到的部分**当成一个缓存条目标下来**；
3. 我原来给的是 `immutable`——**它让浏览器永远不再校验这个条目**。

于是下次普通刷新就解一个**截断的副本**：`moov` 在文件尾部的那两段没有索引 → 一帧都出不来；而 `3.mp4` 的索引在前几 KB 里，截断了也照样能播。硬刷新丢弃该条目 → 三段全好。

这条只影响「缓存复用」这一层，和文件本身无关——所以当时从字节里查编码、查索引、查服务端全都正常。`verify-host-routes.mjs` 现在有两条断言守着它：整片带 `ETag` 且非 `immutable`、**切片必须是 `no-store`**。

占位用的 `placeholder.webm` 已经删掉了（真实素材三段到齐），但生成它的 `tools/record-placeholder.mjs` 保留着——本机没有可用的 H.264 编码器（剪映自带的 `ffmpeg.exe` 是 `--disable-ffmpeg`，只有 gif/mjpeg），真要再造一个占位片只能靠 canvas + MediaRecorder。**注意那种 WebM 头部没有时长元数据**，永远不触发 `ended`，靠的是 20 秒兜底计时器。

真片子请按这几个约束来（都是为了能接进这套播放器）：

| 项 | 建议 | 原因 |
|---|---|---|
| 画幅 | 16:9（当前三段都是 1280×720） | `object-fit: cover`，比例越接近窗口裁得越少 |
| 时长 | **等于你要等的启动时长** | 播完才进，所以片长就是进入前的等待时间；8–15s 是合适的区间 |
| 容器 | **`moov` 必须在文件最前** | 否则浏览器要整段下完才出画面（见上面那一节） |
| 轨道 | 带 AAC 音轨 | 静音起播，第一次点击后出声 |
| 分辨率 | 720p 足够 | 铺满窗口后差别很小，文件却小一半以上 |
| 构图 | 主体别顶满，四边留深色 | 蒙版会把四边渐隐掉，顶满会被吃掉 |
| 文字 | 不要出现文字/水印 | 会和进度条打架 |

## 调参

注入的配置行在 `entry.js` 末尾：

- `holdMs` — 超时放开时间，默认 15000
- 视觉参数（蒙版半径、底色、字标）都在 `src/boot-screen.js` 顶部的 `style()` 里

改完 `src/boot-screen.js` 要重启 dsh（脚本内容是进程启动时读一次）。

## 本地预览（不装进 DSH 也能看）

```bash
node tools/preview.mjs
```

起两个本地服务（页面 :8877、素材池 :8878），页面里带一排调试按钮：明暗主题、模拟启动失败、模拟应用挂载、合成测试片段、选本地视频。改视觉时用这个迭代，不用反复重启 dsh。

## 离线自检

```bash
node build-client.mjs     # 改了 src/client.js 之后重新出产物
node tools/verify-all.mjs # 跑全部离线校验
```

`tools/verify-all.mjs` 汇总十五项，均为纯离线、零系统改动：

| 检查 | 覆盖的契约 |
|---|---|
| `verify-injection.mjs` | 两条注入行落在 `<head>` 内、**早于** shell 脚本（这是整套机制成立的根本） |
| `verify-client-bundle.mjs` | `lib/client.js` 能被模块系统物化、不请求任何共享模块、导出可调用的 `apply` |
| `verify-host-routes.mjs` | 把路由 handler 挂真 HTTP 服务器打真请求：manifest、整片、Range 206/416、404、目录穿越 |
| `verify-real-context.mjs` | **拿真实的 Cordis Context 跑 `apply`**：effect 被接受、路由注册到 webServer 服务、`emit` 真的产出两行、`dispose` 会注销路由 |
| `verify-install-rehearsal.mjs` | **用 dsh 自己的 `loadProfileDirectory` 预演"装完之后"**：20 层全解析、本插件成为最后一层、patch 被解析、insert 行正确、Host 入口与 Client 产物都在盘上，并把 `exports["./client"]` 解成落地文件断言其存在、断言 `files` 覆盖所有运行时读取路径 |
| `verify-powershell-ascii.mjs` | 两个 `.ps1` 保持纯 ASCII（PowerShell 5.1 的 ANSI 解码坑，见下） |
| `verify-patch-row.mjs` | 用真实 `loadOverlayPatches` 解本包 patch：恰好一条 insert 行、`id` 与裸包名正确 |
| `verify-live-roundtrip.mjs` | 对着**真实 profile 的 patch 层**做免重启路径的追加/回滚往返（只读现场文件，改的是临时副本） |
| `verify-blast-radius.mjs` | 入场层脚本写坏时，DSH 仍能起来（承认这块代码有一天会失效） |
| `verify-audio-affordance.mjs` | 声音按钮、静音兜底、两次手势的语义、退出时声音不被掐断 |
| `verify-exit-simple.mjs` | 退出只有一次 2 秒淡出；删掉的过渡不留悬空引用；**放行逻辑里没有时长/定时器/毫秒阈值** |
| `verify-enter-sequence.mjs` | **把 `src/boot-screen.js` 加载进桩 DOM、推假时钟真跑时序**：只就绪不放行、片尾先到要等就绪、时长未知有兜底、播完不被重放、**三种进入方式各有用例**。这是唯一能证明"内核就绪但片子还在放时**不会**进"的套件——正则做不到 |
| `verify-client-bundle.mjs` | 客户端产物的完整契约：工厂签名、`require` 的模块都在 shell 基线表里、**拿不到 react 也不影响交接信号**，并把卡片**加载进桩 React 真渲染一遍**，断言三个小节渲染出来、当前值被标记、点击真的写入设置 |
| `verify-settings.mjs` | 设置面：**两半的命名空间必须一致**（配对全靠这个字符串，别处没人查）、schema 真的注册上、默认值/上下界/枚举、注入的配置跟着存储值变、清单带 `enabled`/`bytes`/`faststart`。0.2.0-rc.2 之后"注册"这一步没了，对应的是"`Config` 真的被导出、字段真的标了 volatile、注入跟着 volatile 引用的当前快照变" |
| `verify-real-clips.mjs` | 对**三段真实素材**逐条打真 Range 请求、逐字节比对；并断言清单不把 `.faststart` 副本收进随机池 |

后两项是关键补强。前几项用的是手写桩，桩只能证明插件自洽；`verify-real-context.mjs` 证明它跟真实 Cordis 对接正确；`verify-install-rehearsal.mjs` 用 dsh 真正的 profile 加载器预演"装完之后"，证明 **bundle 解析与 patch 解析能离线通过**。

它证明不了的那一步必须说清楚：**client-modules 的客户端产物体检（`resolveMeta` → `initialBundleSnapshot`）不在它覆盖范围内**——而那正是 2026-09-26 把 DSH 挡在启动之外的那一步。所以该预演现在额外做两件事：把 `exports["./client"]` 解成落地文件并断言它真实存在（兼容 `string` 与 `{ default }` 两种写法），以及断言 `files` 覆盖运行时读取与模块系统解析的每一条路径。同类"声明与产物错配"从此会在离线自检里被拦下，不必等到启动。

改动 `entry.js` / `src/boot-screen.js` / `src/client.js` 之后都应重跑。

**动接线之前先预演**（把真实 profile 复制到临时 home，迁移副本并用真加载器验证，现场文件只读）：

```bash
node tools/rehearse-migration.mjs --keep D:\DSH\_ba-verify
```

留下的目录是一份完整 `DSH_HOME`：把 `DSH_HOME` 指向它、用**仓库里构建好的** CLI 起第二个实例，就能在不动现场的前提下真启动一次（`pnpm dsh web` 走 tsx/esbuild，沙箱里会 `spawn EPERM`；`node apps/cli/lib/bin.js web --no-open --port 0` 不需要 esbuild，那条路能起）：

```powershell
$env:DSH_HOME='D:\DSH\_ba-verify'; $env:NO_PROXY='localhost,127.0.0.1'
node D:\DSH\deepseek-harness\apps\cli\lib\bin.js web --no-open --port 0
```

它会打印带令牌的 URL，用它换 cookie 打首页即可复看注入标记；插件路由则不需要令牌。

> 后几项需要 `NODE_PATH=D:/DSH/deepseek-harness/node_modules`（`verify-all.mjs` 已替你设好）；`verify-real-context.mjs` 只能导入 cordis 的**构建产物**——vendor 源码用了 TS 构造函数参数属性，Node 的类型擦除不支持。
>
> `verify-powershell-ascii.mjs` 只查字节，不查语法：**代理沙箱里 Node 起不了子进程**（`spawnSync ... EPERM`）。语法校验请用 PowerShell 侧：
>
> ```powershell
> $e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile(
>   'D:\DSH\dsh-boot-animation\package\tools\apply-boot-animation.ps1',[ref]$null,[ref]$e); $e.Count
> ```

## 目录

```
entry.js                  Host 半侧：设置注册 + 素材路由 + 索引注入（含 clips.json 与 Range 支持）
src/boot-screen.js        注入进 <head> 的入场层脚本（无框架，必须在 shell 之前跑）
src/client.js             浏览器半侧：交接信号 + 「设置 → 插件」里的卡片（React）
lib/client.js             构建产物（window.__ModuleLoader__.load 闭包工厂）
build-client.mjs          产物构建：仓库外的包拿不到共享 preset，自己复现那五行外壳
tools/preview.mjs            本地预览（含模拟启动页与调试按钮）
tools/verify-all.mjs         离线自检汇总入口
tools/verify-*.mjs           十七项独立校验（其中三项用桩 DOM / 桩 React 真跑）
tools/verify-tree-hygiene.mjs 其中一项专管「没有垃圾文件/死工具/腐烂的文档路径」
tools/verify-faststart.mjs   其中一项专管「重排工具真的把 moov 移到了前面」
tools/apply-faststart.mjs    一条命令把池子里所有需要重排的片子就地处理好（原片留备份）
tools/apply-faststart.bat    上面那条命令的双击版
tools/fake-dsh-auth.mjs      假服务器：复现 DSH 鉴权，用于验证自检判据本身
tools/migrate-wiring.mjs     接线迁移：写依赖 + bundle 层、移除 patch 行、用真加载器验证（失败自还原）
tools/rehearse-migration.mjs 在 profile 副本上预演迁移（可留 --keep 目录当第二个实例的 DSH_HOME）
tools/faststart.mjs          无损把 mp4 的 moov 索引表前移（不带 ffmpeg，默认只报告不写）
tools/box-chain.mjs          打印每条素材的顶层 box 链与 moov 位置（查"为什么是黑屏"）
tools/codec-report.mjs       读出编码与 AVC 档次/level（排除"浏览器不认这个档次"）
tools/mp4-audit.mjs          校验索引与数据是否自洽（排除"文件本身放不出来"）
tools/mp4-info.mjs           从容器里读时长 / 分辨率 / 有没有音轨
tools/transition-sampler.mjs 过渡效果样本页（端口 8880，纯本地开发用，不在启动路径上）
tools/record-placeholder.mjs 用 canvas + MediaRecorder 录一个占位片段（本机没有 H.264 编码器时用）
tools/install.sh             macOS / Linux 装机：回滚点 + 链接 + 追加 patch 行（不跑 pnpm、不改 package.json）
tools/uninstall.sh           上面那步的撤销：摘掉它追加的行 + 删链接，断言字节还原
tools/apply-live.ps1         免重启接线：备份 + 建 node_modules 链接 + 追加 patch 行
tools/rollback-live.ps1      撤销上面那一步
tools/apply-boot-animation.ps1     装机：回滚点 + 迁移 + 重启 + 自检 + 自动回滚
tools/rollback-boot-animation.ps1  手动撤销
tools/deactivate-boot-animation.ps1 紧急拆除：摘掉 patch 行 + 删链接，纯 ASCII，已预演
assets/videos/            素材池（只放视频文件；子目录不入池）
```

> 曾经有过一个 `assets/videos/faststart/` 暂存目录（`faststart.mjs --write` 的输出落点），已按你的要求删掉。工具还在，随时可以重新生成。
>
> 这个目录清单会被 `verify-tree-hygiene.mjs` 核对——**点到的路径必须真实存在**。加这一条是因为上面那行 `faststart/` 在被删掉之后还在文档里挂了一阵。

## 项目根目录（`package/` 之外）

| 路径 | 是什么 |
|---|---|
| `assets/ref/xiaoD_sheet_chibi.png` | 小D 的 Q 版定妆图（角色设定原图，不是素材） |
| `assets/ref/xiaoD_sheet_detailed.png` | 小D 的精细版定妆图 |
| `prompts.md` | 生成三段片头用的提示词记录（纯文本，没有脚本读它） |
| `apply-boot-animation.bat` | 双击版装机入口，等于直接跑 `package/tools/apply-boot-animation.ps1` |
| `tools/` | 早期的工作流脚本：`clip-probe.mjs`（浏览器里探素材参数，已被 `mp4-info.mjs` 与卡片自己的探针取代）、`restart-and-verify.ps1` / `restart-verify-detached.ps1`（重启+自检，已被 `apply-boot-animation.ps1` 合并）、`launch-dsh-no-open.bat`、`启动过渡样本.bat`（样本页启动器） |

`verify-tree-hygiene.mjs` **只覆盖 `package/`**——这一层放的是项目自己的资料（定妆图、提示词）和一次性脚本，不是要发布的东西，所以按「有没有人引用」来判死反而会误伤。

## 素材容器的第一个坑：moov 必须在文件最前

播放器**必须读到 `moov`（索引表）才能解出第一帧**。如果 `moov` 在文件末尾，浏览器就得先把整段下完才出画面——10MB 的片子就是 10MB 的黑屏。这是「片头是黑的」最常见的成因。

本机三段素材实测（2026-09-28 重排后）：

| 素材 | 重排前 | 现在 |
|---|---|---|
| `1.mp4`（原 `视频节点 11.mp4`） | 偏移 8383836（尾部） | **偏移 32（最前）** |
| `2.mp4`（原 `视频节点 7 - 副本.mp4`） | 偏移 11052570（尾部） | **偏移 32（最前）** |
| `3.mp4`（原 `智能剪辑 13 成片.mp4`） | 偏移 36（最前） | 本来就正常 |

重排前的原片保留在 `assets/videos/originals/`（子目录不入池），要还原就把它们搬回上一层。

`moov` 本身只有 7–12KiB，前移之后**首帧从「读完 8–10MB」变成「读前几 KB」**。重排是纯粹的字节搬移：

```sh
node tools/faststart.mjs            # 只报告，不改任何文件
node tools/faststart.mjs --write    # 输出到 assets/videos/faststart/
```

不用 ffmpeg：`moov` 里只有 `stco`/`co64` 两张表存**绝对文件偏移**（指向 `mdat` 里的采样块），把每个条目加上位移量即可，其余 box 都是相对的。

### 这个工具曾经是坏的，而它的证明骗过了所有人

工具写出来之后连着两次「重排」都是假的：`plan()` 把 `moov` 放在**「它前面那些盒之后」**——对 `moov` 本来就在尾部的文件，这句话等于**原地不动**。于是它输出的是**逐字节相同的副本**，却报告成功。

更要命的是它自带的两道「无损证明」对这个情形**全部退化**：文件没动，所以 `mdat` 逐位未变成立，偏移量的位移量是 **0**，`now === was + 0` 也成立。**证明没有撒谎，只是被证明的东西不是要证明的东西。**

缺的那条断言是关于**结果**而不是计划的：重排之后，输出的 box 顺序里 `moov` 必须排在 `mdat` **前面**。现在由 `tools/verify-faststart.mjs` 在真片子的副本上端到端地验：跑完断言 `ftyp -> moov -> … -> mdat`、等长、除 `moov` 外逐位未变，并且拿一个本来就没问题的片子做反向对照（必须报 SKIP），再拿一个非 mp4 文件做反例（必须报错）。

> 副本默认写在 `videos/faststart/` 子目录里是有意的：素材池只收录常规文件，**写在原片旁边会被当成第二条片段**，同一段片子就会在随机轮播里出现两次。`verify-real-clips.mjs` 与 `verify-tree-hygiene.mjs` 都盯着这件事。
>
> **解码仍然只能由你看画面确认**——Chromium 在本沙箱里起不来（Mojo IPC 要建命名管道，被禁）。结构性证明是完备的，但那不等于播得出来。这次的差别是：**池子里的字节真的变了**（以前两次都没有）。

## 已知限制

- 依赖启动页的 `data-dsh-boot` 属性与 `#root` 结构。DSH 大改版可能失效——失效只是退回原生启动页，不会崩。
- 入场层显示期间，底下的应用其实已经挂载完成，只是被盖住。键盘输入理论上能到达底层（鼠标被拦住了）。如果以后发现输入串了，处理方式是把底层设为 `inert`。
- **设置卡片这一半没在真机 GUI 里验证过。** 沙箱起不了浏览器，所以卡片只有「桩 React 渲染通过」这一层保证；样式与真主题的配合、以及它在真实设置页里的落位，需要你刷新看一眼。
- **改卡片代码可能要 Ctrl+Shift+R（硬刷新）。** 客户端 bundle 是带 `immutable` + `rev` 发的。`rev` 在重建时是内容哈希、HMR 会推新 URL，但**冷启动时那个初始 rev 是「不看字节直接分配」的**，所以卡片可能出现「改了没生效」。入场层不受影响——它内联在 `<head>` 里，永远刷新即生效。
- 卡片的文案是**硬编码中文**，没有走 DSH 的 locale 字典（DSH 的 `verify-client-ui-i18n` 只扫仓库内的包，本包在仓库外）。要出英文版得自己加一套。
- **进入前的等待等于片长**。播完才进，所以抽到 15.10s 那段就要看满 15 秒（除非选「点击才进」或点一下跳过）。
- 视频不带首帧封面，所以画面显形前可能先看到底色（深海底渐变）再淡入短片。`moov` 前置能让这段短很多。
- **显形时机靠 `play()` 的 promise 驱动，并用内联样式写入透明度**（不是 CSS 属性选择器）。原因是实测遇到过 `[data-shown=1]` 匹配不上、视频在播但 `opacity` 计算值仍为 0 的情况；内联值不参与优先级竞争，最稳。
- 占位片段曾是 MediaRecorder 产出的 WebM，**头部没有时长元数据**，Chromium 里 `readyState` 可能永远不到 2、`duration` 为 `Infinity`。占位片已删除，但这条约束仍在：显形判断不能依赖 `loadeddata`，而且这种片段**不触发 `ended`**，进界面靠的是 20 秒兜底计时器。
