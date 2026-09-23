# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 文档

- 📱 README 新增**手机（安卓 / Termux）从零开始教程**：「方式四 → Android」部分重写为完整七步 ——
  装 Termux（含 `termux-change-repo` 换镜像）、装依赖、装/启动酒馆、一键装本插件、
  **保活与开机自启**（`termux-wake-lock` / Termux:Boot / 常用别名）、更新与卸载、以及手机特有的坑（`/sdcard` 别放酒馆、
  32 位机报 `Unsupported platform: android arm LEtime-web` 要 `pkg install esbuild`、存储紧张推荐改的 `config.yaml` 几项）。
- 🖼️ README 的面板实拍图换成新截图（手机浏览器里的真实面板），并加 `?v=2` 破缓存。

## [1.7.0] — 2026-09-24

### 新增

- 📱 **手机（安卓 / Termux）一键安装器 `install-termux.sh`** —— 在 Termux 里贴一行就能装：

  ```bash
  pkg install -y curl && curl -fsSL https://raw.githubusercontent.com/wyndam-c/st-data-janitor/main/install-termux.sh | bash
  ```

  - 专门为手机环境写：**全程不需要 `sudo`**，自动找 `~/SillyTavern`、`/sdcard/SillyTavern`，
    连 **proot-distro** 各个发行版里的酒馆也能翻出来。
  - 保活：自动 `termux-wake-lock`（防安卓杀后台）；`--autostart` 可写一个 **Termux:Boot** 开机自启脚本。
  - 重启：认得出 **pm2 / proot-distro / `start.sh` / `node server.js`**，重启后还会主动探端口（HTTP 200/302/401 才算起来）。
  - 其他参数与 Linux 版一致：`--fix-config`、`--deps`（缺 node/curl/tar 就 `pkg install`）、`--uninstall`、`--dry-run`、`--wake-lock / --no-wake-lock`。
- 🪧 **面板安装引导卡会按「酒馆所在机器」选命令**（Windows / Linux·NAS / 手机 Termux）：
  插件在时看**服务端上报的系统**（`/status` 新增 `env`：`platform` / `arch` / `node` / `termux`），
  拿不到（插件还没装）就先按浏览器 UA 猜——避免了「用手机浏览器看 NAS 上的酒馆，却被发手机安装命令」这类误判。

### 文档

- README：安装章节新增「📱 手机（安卓 / Termux）」一行装与常用参数；Android 分步教程同步改写为
  推荐 `install-termux.sh`、手动拷文件作为备选；🔄 更新 / 🗑️ 卸载 两章补上手机版命令；特性与目录结构同步。

## [1.6.1] — 2026-09-24

### 文档

- 📚 README 新增/重写两大块：**🔄 更新**（面板一键更新 / 重跑安装器 / 手动 `git pull` 三种方式，
  并交代清楚「更新内容」是从哪取的）和 **🗑️ 卸载**（安装器卸载 / 手动两步 / 回收站与 `enableServerPlugins` 注意事项）。
- 原「让酒馆里能一键更新（可选）」小节并入「🔄 更新 → 方式三」，统一成三种更新方式并列。

## [1.6.0] — 2026-09-24

### 新增

- 🧰 **分平台一键安装器**（不用再手敲 mkdir/cp）：
  - `install.sh` —— Linux / macOS / NAS(飞牛·群晖·威联通) / WSL。支持 `curl … | bash` 一行装，
    自动探测酒馆目录（依次试脚本旁边、`$PWD`、`/root/SillyTavern`、`/opt/…`、`/volume1/…`、`/vol1/…`、`/app` 等），
    备份旧版本（`*.bak-时间戳.tar.gz`）、检查并按需修正 `config.yaml` 的 `enableServerPlugins`；
    下载走 **直连 → gh-proxy.com → ghfast.top** 三级回退（国内网络友好）；参数：
    `--st / --user / --from-dir / --online / --channel / --plugin-only / --ext-only / --fix-config / --restart / --uninstall / --dry-run`。
    `--restart` 会尝试识别 **systemd / pm2 / docker** 并重启。
  - `install.ps1` + `install.cmd` —— Windows，**可双击**（cmd 会自动拉 ps1）；自动探测 `%APPDATA%\SillyTavern` 等位置；
    `-FixConfig` / `-Restart`（先关 node 进程再用 Start.bat 拉起）/ `-Uninstall` / `-DryRun`。
  - `install-docker.sh` —— 酒馆跑在容器里时用：自动找容器名与容器内路径（`/home/node/app`、`/app`…），`docker cp` 进去。
- 🧩 **支持在酒馆扩展页直接安装前端扩展**：`扩展 → 安装扩展`，URL 填仓库地址、**分支填 `ext-dist`** 即可。
  （已核实酒馆 `POST /api/extensions/install` 接受 `branch`，且要求分支根目录有 `manifest.json`，`ext-dist` 正好符合。）
- 🪧 **面板自带安装引导卡**：检测到服务端插件没装（`/status` 返回 404）时，面板显示「还差一步：装服务端插件」
  ＋按系统给出**可复制的安装命令**（Windows 自动给 PowerShell 命令）＋「装好了，重新检测」按钮，
  并说明「酒馆没有装服务端插件的界面」（已翻遍 `src/endpoints/`，确认无此接口）。

## [1.5.1] — 2026-09-24

### 新增

- 🛡️ **彻底删除前强制先试运行**：选「彻底删除」后，面板会自动先跑一次 `dryRun`，把「会删什么」
  按规则列出来（如「系统垃圾文件 2 项」），再弹确认框等你点「确认彻底删除」。
  - **服务端同样卡关**：`POST /clean`、`/clean/stream` 带 `permanent: true` 但未先试运行过 → **HTTP 400**
    （提示先调 `{ dryRun: true }`）；试运行结果有效期 **15 分钟**，且只对同一批目标（同一 `rels` / 规则范围）有效。
  - 取代了之前的「两次点击」防误触：那只是前端手法，现在改成真的先看后删。
  - 试运行完成的提示不再说「移入回收站 0 项」，而是「试运行完成：会处理 N 项 / X（什么都没动）」。

## [1.5.0] — 2026-09-24

### 新增

- 🗑️ **清理时先问一句：放回收站还是彻底删除**。点「立即清理 / 清理选中项」不再直接开动，
  而是弹窗选「**移入回收站**（可还原）」或「**彻底删除**（不可恢复）」；
  选彻底删除按钮会变红并要求**再点一次**确认（5 秒内有效），防误触。
  - API：`POST /clean`、`POST /clean/stream` 支持 `permanent: true`；返回值多了 `permanent` / `deleted`。
  - 彻底删除不会建回收站批次，也不会生成 `manifest.json`；空目录仍用 `rmdir`（非空不会被删）。
  - 完成提示会区分「移入回收站 N 项」/「彻底删除 N 项」。

## [1.4.0] — 2026-09-24

### 新增

- 🔍 **扫描预览 + 勾选清理**：扫描完不再只给「哪条规则多少个」，而是列出**逐个文件**：
  名字 · 所在目录 · 格式 · 大小，前面带勾选框。
  - 支持按规则「全选 / 清空」，也支持全局「全选 / 清空选择」；底部实时显示「已选 N 项 / X MB」。
  - 新增「清理选中项 / 试运行选中」；`POST /clean`、`POST /clean/stream` 现在支持 `rels: [...]`。
  - 服务端会把勾选路径跟**本次扫描结果取交集**，不在里面的（过期路径 / 越权路径）一律跳过，
    并在返回里报 `notFoundCount`；空目录也能被单独选中处理。
  - 清理完自动重扫一次，列表自己刷新；`/scan` 报告里每个 item 多了 `name / dir / type / size`。
  - 扫描报告每规则最多列 500 条（原来 200）。

### 修复

- 扫描完成后的提示语之前恒为「可清 0 项 / 0 B」（报告里的 `rules` 是对象而非数组，前端没解析对），
  现已修正；清理完成提示会一并带上「失败 / 跳过」数量。

## [1.3.3] — 2026-09-24

### 修复

- **更新弹窗里的「更新内容」是空的**：抽取 CHANGELOG 小节的正则少了 `s` 标志，跨行不匹配。
  现在能正确抓到对应版本的说明（含 1.3.2 及以后）。

## [1.3.2] — 2026-09-24

### 优化

- **「检查更新」改走 git 通道（更准、更快）**。之前只靠 HTTP 拉 `raw.githubusercontent.com`，国内经常超时，
  于是误报“已是最新”。现在改为：优先在插件目录里 `git fetch` 后直接读 `origin/plugin-dist` /
  `origin/ext-dist` / `origin/main` —— 跟酒馆 `git pull` 走**同一条路**，拉得到就查得到，通常 1-3 秒出结果；
  git 不可用时才退回 HTTP 镜像（raw → gh-proxy → ghfast → jsDelivr，并避开 jsDelivr 的 12h 缓存）。

## [1.3.1] — 2026-09-24

### 修复

- **「检查更新」在直连 GitHub 不稳定时误报“已是最新”**。国内直连 `raw.githubusercontent.com` 经常超时，
  现加了**镜像回退**：原生地址超时就换 `cdn.jsdelivr.net`；单个请求超时从 10s 提到 12s。
- **一键更新的 git 拉取加固**：`git fetch` 加 `http.version=HTTP/1.1` 和大 `http.postBuffer`，
  失败自动**重试一次**；git / curl / tar 均加了执行超时，不会永久卡住。

## [1.3.0] — 2026-09-24

### 新增

- **面板内「检查更新 / 一键更新」**。扩展面板顶部现在显示当前版本，旁边一个「检查更新」按钮；
  载入面板时也会静默查一次。
  - 已是最新 → 只提示一句「已经是最新版本 vX，无需更新」。
  - 有新版本 → 弹窗显示**更新内容**（从仓库 CHANGELOG 对应小节抓取），提供「**立即更新**」与「**取消**」两个按钮。
  - 比对基准是**发布分支**（`plugin-dist` / `ext-dist`）上的版本号 —— 也就是酒馆 `git pull` 真正能拿到的东西；
    更新动作：`git fetch` + `git reset --hard origin/<发布分支>`；若目录不是 git 仓库（直接拷文件装的），
    自动改用发布分支的 tar 包覆盖。
  - 更新后：前端扩展刷新页面即生效；服务端插件需重启酒馆（结果里会带上 `restartNeeded`，面板会提醒）。
  - 新增接口：`GET /update-check`、`POST /update-apply`。

## [1.2.1] — 2026-09-24

### 改进

- **进度弹窗改为挂在页面最外层（`document.body`）**。之前的弹窗是插在扩展面板里的，会被面板自身的
  定位/滚动上下文限制，显得又小又不显眼；现在改成**全屏遮罩 + 居中大卡片**：进度条加粗、百分比字号加大、
  新增「已用时间」实时计时和转圈动效；扫描/清理结束后还会再弹一条汇总提示。（纯前端改动，刷新页面即生效）

### 修复

- **发布流程改为线性历史，`git pull` 永不失败**：`publish.sh` 不再用 `git subtree split` + `git push -f`
  （会改写 `plugin-dist` / `ext-dist` 分支历史，导致酒馆自动更新报
  `Not possible to fast-forward, aborting`）。改为把目录树做成新提交、父提交指向远端分支当前 tip，
  天然 fast-forward；内容未变时会自动跳过。此变更**不影响工具本身**，版本号不变。

## [1.2.0] — 2026-09-24

### 新增

- **扫描 / 清理时弹出进度条窗口**。点「扫描」「试运行」「立即清理」后会弹出模态框，实时显示
  进度百分比、当前阶段（遍历目录 / 各规则 / 去重比对 / 移入回收站），不再“一片空白干等”。
- 服务端新增流式接口（NDJSON）：`POST /api/plugins/st-data-janitor/scan/stream`、
  `.../clean/stream`；核心库 `scan()` / `clean()` / `collectTargets()` / `collectDuplicates()`
  均支持可选的 `onProgress` 回调（CLI 不用时可忽略）。
- 前端若遇到不支持流式的旧服务端，会自动退化为“一次性拿结果”，不影响使用。

## [1.1.0] — 2026-09-24

新增第 8 条规则：**重复文件去重**（角色卡 / 世界书 / 预设 / 主题 / 快捷回复）。

### 新增

- **重复文件去重**：在所选集合里找出「多余副本」并入回收站，三种判重方式可独立开关：
  1. **内容相同** —— 文件字节完全一致（sha256；先按体积分桶，仅同体积才计算哈希，省 IO）；
  2. **同名副本** —— 文件名带 `(1)` / `（1）` / `[1]` / `- 副本` / `copy` 等明确的副本标记；
     （只认明确标记，**不**碰结尾的普通数字，避免把「插入体位1 / 插入体位2」误伤）
  3. **角色卡同名** —— 按 PNG 卡内嵌的**卡名**（`chara` / `ccv3` 块）判重，同卡不同文件名的也能对上。
- **保留策略**：默认「优先留文件名最干净的那份（无 (1)/副本 标记；角色卡则优先文件名=卡名），再按修改时间取最新」；可关掉改成纯按时间。
- **体积门槛** `minSizeKB`：小于该体积的文件不参与判重，便于避开「空模板」类误伤（例如一堆内容相同但各自独立的空世界书）。
- **范围可勾选**：角色卡 / 世界书 / 预设 / 主题 / 快捷回复，逐项开关。
- **联动缩略图**：角色卡去重时，顺带清掉对应缩略图（`thumbnails/avatar/`），不留孤儿。
- 命令行新增 `--dupes`（可配 `--dup-keep N`）。

### 安全默认值

- 该规则**默认关闭**（删的是「看起来一样」的副本，需先看试运行报告）；删除照旧先进回收站、可还原。

## [1.0.0] — 2026-09-24

首个版本。

### 新增

- **服务端插件** `st-data-janitor`，HTTP API 挂载于 `/api/plugins/st-data-janitor`：
  `GET /status`、`GET|POST /config`、`POST /scan`、`POST /clean`、`GET /trash`、
  `POST /restore`、`POST /empty-trash`。
- **前端扩展**面板：扫描 / 试运行清理 / 立即清理 / 保存配置 / 清空回收站 / 回收站还原。
- **7 条清理规则**（可独立开关）：
  1. 同步冲突副本（`xxx (conflict_on_日期)`）
  2. 同步临时残留（`.unison.*.unison.tmp`）
  3. 系统垃圾文件（`.DS_Store` / `Thumbs.db` / `*~` / `*.swp` / `*.orig` …）
  4. 空目录
  5. 过量旧备份（按聊天分组，保留最新 N 份）
  6. 孤儿缩略图
  7. 空文件（0 字节 + 超龄）
- **手动 / 自动模式**：可设「每 N 分钟 / 小时 / 天」自动执行；自动模式可只报告不真删。
- **回收站机制**：删除一律 `rename` 到 `<SillyTavern>/.janitor-trash/<批次>/` 并写 `manifest.json`，
  支持整批还原、手动清空、按 `trashKeepDays` 自动清理过期批次。
  回收站刻意置于 `data` **同级目录**，避免被云同步工具带到对端。
- **硬保护名单**：`_storage/`、`cookie-secret.txt`、`.gitkeep`、`node_modules/`、`.git/`、回收站自身。
- **命令行模式**：`node plugin/lib/janitor.mjs --scan|--clean <dataRoot> [--apply] [--old-backups --keep N] [--empty-dirs]`。

### 安全默认值

- 默认**试运行**，不真删。
- 有判断风险 / 后果较重的规则**默认关闭**（空目录、旧备份、孤儿缩略图、空文件）。
- 自动模式默认「只报告不真删」。
