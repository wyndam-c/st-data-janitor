# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
