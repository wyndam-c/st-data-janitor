#!/usr/bin/env bash
# 数据清洁工 (Data Janitor) — 安装脚本
# 用法: sudo ./install.sh [SillyTavern 路径] [用户名，默认 default-user]
set -euo pipefail

ST_ROOT="${1:-/root/SillyTavern}"
USER_DIR="${2:-default-user}"
HERE="$(cd "$(dirname "$0")" && pwd)"

[ -d "$ST_ROOT" ] || { echo "找不到 SillyTavern 目录: $ST_ROOT"; exit 1; }
[ -f "$ST_ROOT/config.yaml" ] || echo "⚠️  $ST_ROOT 下没有 config.yaml，确认路径对不对"

PLUGIN_DST="$ST_ROOT/plugins/st-data-janitor"
EXT_DST="$ST_ROOT/data/$USER_DIR/extensions/st-data-janitor"

echo "→ 安装服务端插件到 $PLUGIN_DST"
mkdir -p "$PLUGIN_DST"
cp -f "$HERE/plugin/index.mjs" "$PLUGIN_DST/"
mkdir -p "$PLUGIN_DST/lib"
cp -f "$HERE/plugin/lib/janitor.mjs" "$PLUGIN_DST/lib/"

echo "→ 安装前端扩展到 $EXT_DST"
mkdir -p "$EXT_DST"
cp -f "$HERE/extension/manifest.json" "$HERE/extension/index.js" "$HERE/extension/style.css" "$EXT_DST/"

echo "→ 确认 config.yaml 已开启服务端插件"
if ! grep -qE '^\s*enableServerPlugins:\s*true' "$ST_ROOT/config.yaml"; then
  echo "⚠️  config.yaml 里的 enableServerPlugins 不是 true，插件不会加载！"
fi

echo "✅ 装好了。重启 SillyTavern 后，在「扩展」面板里能看到「数据清洁工」。"
