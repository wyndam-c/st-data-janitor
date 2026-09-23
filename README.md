# ST Data Janitor · 数据清洁工

SillyTavern 的「没用数据 / 多余数据」自动清理插件：**服务端插件 + 前端扩展**。

扫一遍你的 `data` 目录，把同步冲突副本、临时残留、系统垃圾、空目录、过量旧备份、孤儿缩略图、空文件挑出来，**先移进回收站**（可一键还原），再按需清空。

## 规则一览

| 规则 | 说明 | 默认 |
| --- | --- | --- |
| 同步冲突副本 | `xxx (conflict_on_日期)` / `(conflict #1_on_日期)` —— 云同步打架留下的 | ✅ 开 |
| 同步临时残留 | `.unison.*.unison.tmp` | ✅ 开 |
| 系统垃圾文件 | `.DS_Store` / `Thumbs.db` / `*~` / `*.swp` / `*.orig` 等 | ✅ 开 |
| 空目录 | 完全没有内容的目录 | ⬜ 关 |
| 过量旧备份 | 每个**聊天**的 `backups/` 只保留最新 N 份（默认 10） | ⬜ 关 |
| 孤儿缩略图 | `thumbnails/` 里找不到对应角色卡的 | ⬜ 关 |
| 空文件 | 0 字节且存在超过 N 小时 | ⬜ 关 |

## 安全设计

- **默认试运行**：不开「立即清理」就只报告，不动手；自动模式默认也只报告。
- **进回收站，不硬删**：所有删除都是同盘 `rename` 到 `<SillyTavern>/.janitor-trash/<批次>/`，写 `manifest.json`，可一键还原。
  - 回收站刻意放在 **`data` 同级**，避免被云同步（st-cloud-sync）带到对面去。
- **硬保护**：`_storage/`、`cookie-secret.txt`、`.gitkeep`、`node_modules/`、`.git/` 永不触碰。
- **旧备份按聊天分组**：只留「每个聊天最新 N 份」，不会因为某个聊天刷得勤就把别的聊天的备份清光。

## 安装

```bash
sudo ./install.sh /root/SillyTavern            # 第二参数=用户名，默认 default-user
# 然后重启 SillyTavern，扩展面板里会出现「数据清洁工」
```

前置：`config.yaml` 里 `enableServerPlugins: true`。

## 命令行用法（不装也行，直接跑一次）

```bash
# 只看不删
node plugin/lib/janitor.mjs --scan /root/SillyTavern/data
# 试运行（列出要动的东西）
node plugin/lib/janitor.mjs --clean /root/SillyTavern/data
# 真清理（移入回收站）
node plugin/lib/janitor.mjs --clean /root/SillyTavern/data --apply
# 附加规则
node plugin/lib/janitor.mjs --scan  /root/SillyTavern/data --old-backups --keep 10 --empty-dirs
```

## HTTP API（挂在 `/api/plugins/st-data-janitor` 下）

- `GET  /status` 状态 + 配置 + 最近报告 + 回收站
- `GET  /config` / `POST /config`
- `POST /scan` 后台扫描
- `POST /clean` `{ rules?, dryRun? }` 后台清理
- `GET  /trash` · `POST /restore {batch}` · `POST /empty-trash {keepDays}`

## 手动 / 自动

- **手动**（默认）：面板上点「扫描 / 试运行 / 立即清理」，想清才清。
- **自动**：选「自动」+ 设**间隔**（分钟 / 小时 / 天），到点自己跑。
  - 自动模式可勾「只报告不真删」——先观察一阵，确认规则合适再放开真删。
  - 自动跑的结果会显示在面板状态栏和最近一次报告里。

## 建议

如果 `backups/` 涨得飞快，多半是某个「聊天自动备份」类扩展导出太勤 —— 光清治标不治本，顺手把它的导出间隔调大些。

License: MIT · 白鸦 / 小草
