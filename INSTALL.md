# 安装说明（给别人看的）

这是一份**可分享的副本**：解压后照下面做就能装上。全程不需要原作者的那台机器。

> 只是想自己用？看 [MANUAL.md](MANUAL.md)。想改代码？看 [AGENTS.md](AGENTS.md)。

## 你需要什么

| 条件 | 说明 |
|---|---|
| **DSH** | 实测于 `0.2.0-rc.2`。设置契约在这一版变过（插件改为声明 `Config`，不再注册命名空间），更旧的版本要用旧版插件 |
| **Node.js** | `^22.19.0` 或 `>=24`（DSH 自己就要求这个，通常已经有） |
| 浏览器 | Chromium 内核（Chrome / Edge）。Firefox 没测过 |

## 安装：三条路，选一条

### 路 A：官方命令（推荐）

```sh
dsh plugin --profile web add <解压出来的目录>
```

这条路会让 pnpm 把依赖也装好，**装完重启一次 DSH**。

> 桌面版（DSH Desktop）的 profile 名叫 `desktop`，而这个命令不允许直接改它
> （会报 `profile "desktop" is managed exclusively by the Electron application`）。
> 桌面版请走路 B 或路 C。

### 路 B：不重启（Windows）

```powershell
powershell -ExecutionPolicy Bypass -File tools\install.ps1
```

它自己找 DSH 的安装位置（先看环境变量 `DSH_HOME`，再找 `%USERPROFILE%\.dsh`），
在 profile 里建一个目录链接、追加一行配置，并**顺手把设置卡片需要的依赖链上**
（DSH 自带那份）。不碰 `package.json`，不跑 pnpm。

- 找不到 profile 会**明确报错并列出有哪些 profile**，不会乱写
- 装之前**自动备份** `cordis.patch.yml`
- 大多数 profile 会热加载（几秒内生效）；不热加载的，脚本会提醒你手动重启
- **撤销**：`powershell -ExecutionPolicy Bypass -File tools\uninstall.ps1 -ProfileName desktop`
  （桌面版 profile 叫 `desktop`，脚本默认找的是 `web`；详见下面的「卸掉」）

### 路 C：macOS / Linux

```sh
sh tools/install.sh --profile desktop   # 桌面版（DSH Desktop 用的那个 profile）
sh tools/install.sh                     # dsh web 用的那个（默认就是 web）
```

和路 B 是同一件事：找 DSH 的位置（先看 `DSH_HOME`，再找 `~/.dsh`）、在 profile 里建目录链接、
追加一行配置，并把设置卡片需要的 `@deepseek-ai/schemastery` 链上（DSH 自带那份，要 3.18.4 及以上）。
**不跑 pnpm、不改 `package.json`。** 装完重启一次。

- 找不到 profile 会**明确报错并列出有哪些 profile**，不会乱写
- 装之前**自动备份** `cordis.patch.yml`
- 已经作为 bundle 层挂着的机器上它会直接收工，不会挂出第二条同 id 的 entry
- 大多数 profile 会热加载（几秒内生效）；不热加载的，脚本会提醒你手动重启
- **撤销**：`sh tools/uninstall.sh`（`--profile` 同上）；它只摘掉自己追加的那行、删掉链接，
  并断言 `cordis.patch.yml` 回到安装前的字节

## 装完检查

1. **重启（或等几秒）后刷新浏览器**
2. 看到深海底背景 + 一条短片铺满窗口 → 装好了
3. 刷新后进 **设置 → 左侧菜单「启动动画」**，点开是一整页，里面是**三组可折叠的**：
   - **常用**：开启启动动画、播放影片声音、点鼠标直接进入、显示底部提示文字、淡入时长、进入方式
   - **片头素材池**：每条片子一行，带时长、徽章，以及「预览」「优化」两个按钮
   - **屏保**：启用屏保、闲置时长、退出时播放特效、屏保音量、随机切换、提示行、屏保素材池
   - **三组都在 → 完全正常**
   - **左侧菜单里没有这一项** → 设置卡片没注册上。现在这条几乎只有一个原因：
     插件旁边链接的 `@deepseek-ai/schemastery` **版本太旧**（要 3.18.4 及以上，
     它才有 `Schema.prototype.volatile`；没有这个方法的旧副本会让卡片静默消失）。
     看 DSH 控制台里 `boot-animation:` 开头的黄色告警，照那句话把链接换掉即可：
     把内核那份（随 DSH 一起发布、在 `app.asar` 里）解成盘上目录，再把
     `node_modules\@deepseek-ai\schemastery` 指过去。

**重启一次是必须的。** `entry.js` 的改动由 DSH 进程启动时加载；只刷新页面不会生效
（`src/boot-screen.js` 与素材不同，那两个刷新即可）。

## 屏保：装完是关着的，要自己打开

这个版本除了开机动画，还带一个**屏保**：你离开一段时间后，用素材铺满窗口盖住界面；
**点一下或按任意键**它就收回去。

> **它默认是关闭的**（`screensaverEnabled: false`）。打开设置卡片看到「屏保」那一组写着
> 「已关闭（默认）」，**这是正常的，不是坏了**。要用的自己去打开——因为它会**抢屏幕**，
> 默认开着的话你读文档、三分钟没动鼠标，画面就突然被盖住。

打开之后，这一组里可以调：

| 控件 | 说明 |
|---|---|
| **启用屏保** | 总开关，默认关 |
| **闲置时长** | 多久算「离开」。默认 **3 分钟**，可选 1 / 3 / 5 / 10 分钟，也能自己填 |
| **退出时播放特效** | 收回时碎成像素块飘散。可选随机或几种固定特效；关掉就是普通淡出 |
| **屏保音量** | 一个滑块，**最左＝静音**（默认就在最左）。只有视频能有声音，图片/动图/模型对它无反应 |
| **随机切换** | 默认**不轮换**。开了之后到点换下一条（等当前这条播完再换，带交叉溶解） |
| **提示行** | 屏保底部那行「点击或按任意键继续」，默认开 |
| **屏保素材池** | 每条一行，带类型徽章和「预览」按钮 |

**触发条件是两个，任一满足就出来：**

1. **整机闲置超时** —— 一段时间没有任何鼠标键盘输入，**不管 DSH 是不是当前窗口**
2. **窗口失焦超时** —— 你切到别的程序去了

> **非 Windows 系统上只有第 2 条。** 第 1 条靠的是 Windows 的 `GetLastInputInfo`，
> 这个接口没有跨平台等价物；在 macOS / Linux 上它读不到，屏保就只剩「窗口失焦」那一半
> 可用。这是真实的能力边界，不是没装好。

另外两条要知道的：**鼠标移动不算「回来」**（得点一下或按键，不然轻轻一晃就把画面清了）；
**窗口最小化时不会出来**（没人在看）。而窗口**只是被别的窗口盖住**时它**照样会出来**——
网页拿不到操作系统的窗口层级，这条做不到。

## 素材：两个文件夹，两个池

| 池子 | 文件夹 | 放什么 |
|---|---|---|
| **片头池** | `assets/videos/` | 视频。打开页面最先演的那段 |
| **屏保池** | `assets/screensaver/` | 视频 / 图片 / 动图 / Live2D 模型文件夹 |

分成两个文件夹是有意的：片头是「演一遍就交接」，屏保是「盖住等你回来」，两件事不一样。
混在一起的话，你往屏保池里加一段循环片，会顺手改掉片头的随机结果。

支持的格式按扩展名定：

| 扩展名 | 当成什么 |
|---|---|
| `.mp4` `.webm` `.m4v` `.mov` | 视频（**推荐 H.264 + AAC 的 mp4**） |
| `.png` `.jpg` `.jpeg` `.avif` | 静态图 |
| `.gif` `.webp` | 动图 |
| 一个**文件夹**（里面有 `.model3.json`） | Live2D 模型（**只在屏保池里认**，且需要适配器才能渲染） |

`.mkv`、`.svg` 会被忽略。设置卡片里两个池各有一个「打开片头文件夹 / 打开屏保文件夹」按钮，
点一下就在系统文件管理器里打开对应目录（**目录不存在会自动建一个**）。

## 换掉自带的片子

包里的素材是作者自己的动画，**不在 MIT 范围内**——作者保留全部权利。你可以随插件原样用
（自己机器上看、非商用），也可以随时换成自己的片子。**不要转售、不要商用**，需要商用得
单独取得作者书面许可。详见 [LICENSE](LICENSE)。

当前副本带的是
**片头 5 段 mp4**（`1.mp4`–`5.mp4`）和**屏保 7 段 mp4**（`屏保1.mp4`–`屏保7.mp4`）。

**片头：**

1. 把你的视频丢进 `assets/videos/`（格式见上面那张表；推荐 H.264 + AAC 的 mp4）
2. 打开设置卡片展开「片头素材池」，看那一行有没有黄色 **`未优化`** 徽章——
   有的话点它右边的 **「优化」** 按钮（在插件进程里无损把索引表挪到最前，
   原片自动备份到 `assets/videos/originals/`）
3. 刷新页面

**屏保：**

1. 把视频 / 图片 / 动图丢进 `assets/screensaver/`；Live2D 模型要放**整个文件夹**
   （里面有 `.model3.json`，`.moc3`、贴图等会被一起提供）
2. 刷新页面，展开设置卡片的「屏保素材池」勾选它
3. 记得**先把「启用屏保」打开**，否则它不会出来

> 屏保池的行**没有「优化」按钮**（重排是 mp4 的事，而屏保池里还可能有图片和模型）。
> 屏保的视频想重排，把它临时放进 `assets/videos/`、点一次「优化」再挪回 `assets/screensaver/`。

不想留作者的片子，直接把文件删掉再放自己的即可（池子空了也不会卡住，只是没有画面）。

## 卸掉

| 想要 | 怎么做 |
|---|---|
| 暂时不要动画 | 设置卡片里关掉「开启启动动画」 |
| 摘掉插件（Windows） | `powershell -ExecutionPolicy Bypass -File tools\uninstall.ps1 -ProfileName desktop`（桌面版 profile 叫 `desktop`，默认找 `web`），然后刷新 |
| 摘掉插件（macOS / Linux） | `sh tools/uninstall.sh --profile desktop`，然后刷新 |
| 彻底删掉 | 先跑上面的 uninstall，再删掉整个目录 |

profile 是热加载的，摘掉后刷新页面就回到 DSH 原生启动页，不必重启。

摘掉插件无非两件事：删掉 `cordis.patch.yml` 里那个 `- insert:` 块（它未必在文件末尾，DSH 自己
会重排这一层，所以**搜 `boot-animation` 找，别按位置找**），再删掉 profile 下的
`node_modules\dsh-boot-animation` 链接（用 `cmd /c rmdir`，它只删链接，不会跟到插件目录里）。
不想跑脚本就手工这么来。

> 早先版本的 `uninstall.ps1` 不能用：它读回再写出 `cordis.patch.yml` 时按 ANSI 解码无 BOM 的
> UTF-8，会把你 profile 里的中文写成乱码并加上 BOM。当前版本已改成按 UTF-8 原样读写。

## 这份副本里有什么、没有什么

**有的**（都能直接用）：

- **安装 / 卸载脚本四个**：`tools/install.ps1`、`tools/uninstall.ps1`（Windows），
  `tools/install.sh`、`tools/uninstall.sh`（macOS / Linux）——就是上面路 B / 路 C 用的那套
- **离线自检套件五个**：`tools/verify-pools.mjs`、`tools/verify-encoding.mjs`、
  `tools/verify-icon-route.mjs`、`tools/verify-client-card.mjs`、`tools/verify-exit-effects.mjs`。
  五个都纯离线、无端口、无交互，改完代码想自查就跑它们

**没有的**：

- **没有** `node_modules/`（依赖要现装；脚本会把设置卡片需要的 `@deepseek-ai/schemastery` 链上）
- **没有** `assets/videos/originals/`、`assets/screensaver/originals/`（重排前的原片备份，
  是卡片的「优化」按钮**在你自己机器上运行时才生成**的，不随包发出。它们不参与轮播。）
- **没有**媒体工具：`tools/faststart.mjs`、`tools/apply-faststart.mjs` / `.bat`、
  `tools/mp4-info.mjs`、`tools/mp4-audit.mjs`、`tools/box-chain.mjs`、
  `tools/codec-report.mjs`、`tools/preview.mjs`。这些绑定在作者的开发机上，
  发出来只会让你困惑；**它们的活由卡片上的按钮代劳**——「优化」跑的是插件内的
  `src/remux.js`，等于 `faststart.mjs`
- **没有**作者工作副本里那套更宽的 `verify/verify-*.mjs`（那些要指向 DSH 源码 checkout）。
  要改代码看 [AGENTS.md](AGENTS.md)

> README.md 是作者的完整开发记录，里面会提到上面那些没随包发出来的工具——那是历史记录，
> 每处都标了「不在本树」，不是使用说明。

## 许可

**代码**是 MIT，见 [LICENSE](LICENSE)：改、用、再分发、商用都可以，保留版权声明即可。

**素材不是。** `assets/videos/` 和 `assets/screensaver/` 里的视频是作者自己的原创动画，
作者保留全部权利，**不在 MIT 范围内**。你可以随插件原样使用（非商用），但不得转售、
不得商用、不得抽出来单独分发。要商用请先取得作者的书面许可，或者把这些片子删掉换成你自己的。

