#!/usr/bin/env bash
# 数据清洁工 (ST Data Janitor) 一键安装器 —— Linux / macOS / NAS(飞牛·群晖·威联通) / WSL
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/wyndam-c/st-data-janitor/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/wyndam-c/st-data-janitor/main/install.sh | bash -s -- /path/to/SillyTavern
#   bash install.sh                  # 在源码目录里跑 = 用本地文件安装
#   bash install.sh --dry-run        # 只演练，不动任何文件
#
# 常用参数：
#   --st <路径>        指定 SillyTavern 根目录（也可用环境变量 ST_HOME）
#   --user <名字>      指定酒馆用户目录名（默认 default-user）
#   --from-dir <目录>  用本地源码安装（自动识别脚本旁边的 plugin/ extension/）
#   --online           强制从 GitHub 下载最新发布（即使本地有源码）
#   --channel <分支>   发布分支，默认 plugin-dist
#   --plugin-only      只装服务端插件
#   --ext-only         只装前端扩展
#   --fix-config       顺手把 config.yaml 的 enableServerPlugins 打开（会先备份）
#   --restart          装完尝试自动重启酒馆（识别 systemd / pm2 / docker）
#   --uninstall        卸载（移到备份目录，不直接删）
#   --dry-run          演习
#   -h | --help        帮助
set -eu

REPO="wyndam-c/st-data-janitor"
RAW="https://raw.githubusercontent.com/${REPO}/main"
DEFAULT_BRANCH="plugin-dist"
EXT_BRANCH="ext-dist"
PLUGIN_ID="st-data-janitor"
TS="$(date +%Y%m%d-%H%M%S)"

ST_PATH="${ST_HOME:-}"
USER_DIR="default-user"
FROM_DIR=""
BRANCH="$DEFAULT_BRANCH"
DO_PLUGIN=1
DO_EXT=1
FIX_CONFIG=0
RESTART=0
UNINSTALL=0
DRY=0
LOCAL_FIRST=1

c_ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
c_warn() { printf '\033[33m%s\033[0m\n' "$*"; }
c_err()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
hr()     { printf '%s\n' "------------------------------------------------------------"; }

usage() { sed -n '2,25p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true; }

while [ $# -gt 0 ]; do
    case "$1" in
        --st) ST_PATH="${2:-}"; shift 2 ;;
        --user) USER_DIR="${2:-}"; shift 2 ;;
        --from-dir) FROM_DIR="${2:-}"; shift 2 ;;
        --channel) BRANCH="${2:-}"; shift 2 ;;
        --online) LOCAL_FIRST=0; shift ;;
        --plugin-only) DO_EXT=0; shift ;;
        --ext-only) DO_PLUGIN=0; shift ;;
        --fix-config) FIX_CONFIG=1; shift ;;
        --restart) RESTART=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        --dry-run) DRY=1; shift ;;
        -h|--help) usage; exit 0 ;;
        -*) c_err "未知参数：$1（用 --help 看用法）"; exit 2 ;;
        *) ST_PATH="$1"; shift ;;
    esac
done

run() {
    if [ "$DRY" = "1" ]; then printf '  [演习] %s\n' "$*"; else "$@"; fi
}

# 可移植的 sed 就地编辑（macOS 的 sed -i 要带空参数，干脆用临时文件）
sed_edit() { # <文件> <sed 脚本>
    if [ "$DRY" = "1" ]; then printf '  [演习] sed -e %s %s\n' "$2" "$1"; return 0; fi
    _t="$(mktemp)"
    if sed -e "$2" "$1" > "$_t"; then cat "$_t" > "$1"; fi
    rm -f "$_t"
}

# ---------- 找 SillyTavern ----------
is_st_root() {
    [ -n "${1:-}" ] && [ -d "$1" ] && [ -f "$1/config.yaml" ] \
        && { [ -f "$1/package.json" ] || [ -f "$1/src/plugin-loader.js" ] || [ -f "$1/server.js" ]; }
}

detect_st() {
    # 0) 显式指定优先
    if [ -n "${ST_PATH:-}" ] && is_st_root "$ST_PATH"; then printf '%s\n' "$ST_PATH"; return 0; fi
    # 1) 脚本自身所在目录往上找（本地源码安装 / 脚本被放进 ST 里跑）
    local d="$1"
    while [ -n "$d" ] && [ "$d" != "/" ]; do
        if is_st_root "$d"; then printf '%s\n' "$d"; return 0; fi
        # 脚本旁边是 plugin-dist 风格（index.mjs+lib）→ 上一级也可能就是 ST
        d="$(dirname "$d")"
    done
    # 2) 常见路径
    for d in \
        "$PWD" "$PWD/SillyTavern" "$PWD/sillytavern" \
        "/root/SillyTavern" "/opt/SillyTavern" "/usr/local/SillyTavern" \
        "$HOME/SillyTavern" "$HOME/sillytavern" "$HOME/SillyTavern-release" \
        "/volume1/SillyTavern" "/volume2/SillyTavern" \
        "/vol1/SillyTavern" "/vol2/SillyTavern" \
        "/mnt/user/appdata/SillyTavern" "/app" "/home/node/app"
    do
        if is_st_root "$d"; then printf '%s\n' "$d"; return 0; fi
    done
    return 1
}

# ---------- 下载 ----------
fetch() { # <url> <out>
    if command -v curl >/dev/null 2>&1; then
        curl -fL --connect-timeout 20 --retry 2 --retry-delay 2 -m 600 -o "$2" "$1" 2>/dev/null
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$2" --timeout=60 --tries=3 "$1"
    else
        c_err "没找到 curl 或 wget，请先装一个（apt install curl / opkg install curl）"; return 1
    fi
}

# 依次试：直连 → gh-proxy 镜像 → ghfast 镜像（国内网络友好）
fetch_mirrors() { # <github路径> <out>   例：codeload.github.com/x/y/tar.gz/refs/heads/z
    for base in "https://" "https://gh-proxy.com/https://" "https://ghfast.top/https://"; do
        url="${base}${1}"
        if fetch "$url" "$2"; then printf '  ↓ %s\n' "$url"; return 0; fi
        [ "$DRY" = "1" ] && { printf '  [演习] 尝试 %s\n' "$url"; return 0; }
    done
    return 1
}

# 把 tar.gz 里的 <repo>-<branch>/ 平铺出来：<tar> <要拷贝的相对路径...> 到 <dst>
extract_into() { # <tarfile> <innerTopDir> <dst>
    tmp="$(mktemp -d)"
    tar -xzf "$1" -C "$tmp" 2>/dev/null || { rm -rf "$tmp"; return 1; }
    top="$(find "$tmp" -maxdepth 1 -mindepth 1 -type d | head -n1)"
    [ -n "$top" ] || { rm -rf "$tmp"; return 1; }
    run mkdir -p "$3"
    run cp -R "$top"/. "$3"/
    rm -rf "$tmp"
}

do_plugin_files() { # <srcDir(含 index.mjs[,lib])>  <dstDir>
    src="$1"; dst="$2"
    [ -f "$src/index.mjs" ] || { c_err "源里没有 index.mjs：$src"; return 1; }
    if [ -d "$dst" ]; then
        c_warn "→ 已存在旧版本，先备份：$dst.bak-${TS}.tar.gz"
        run tar -czf "$dst.bak-${TS}.tar.gz" -C "$(dirname "$dst")" "$(basename "$dst")"
    fi
    run mkdir -p "$dst"
    run cp -f "$src/index.mjs" "$dst/index.mjs"
    if [ -d "$src/lib" ]; then run mkdir -p "$dst/lib"; run cp -Rf "$src/lib"/. "$dst/lib"/; fi
    run cp -f "$src/package.json" "$dst/package.json" 2>/dev/null || true
    v="$(grep -m1 -oE "version: '[0-9]+\.[0-9]+\.[0-9]+'" "$src/index.mjs" 2>/dev/null | head -n1 | sed "s/.*'\(.*\)'/\1/")"
    c_ok "  ✓ 服务端插件 → $dst  ${v:+(v$v)}"
}

do_ext_files() { # <srcDir(含 manifest.json)> <dstDir>
    src="$1"; dst="$2"
    [ -f "$src/manifest.json" ] || { c_err "源里没有 manifest.json：$src"; return 1; }
    if [ -d "$dst" ]; then
        c_warn "→ 已存在旧版本，先备份：$dst.bak-${TS}.tar.gz"
        run tar -czf "$dst.bak-${TS}.tar.gz" -C "$(dirname "$dst")" "$(basename "$dst")"
    fi
    run mkdir -p "$dst"
    run cp -f "$src/manifest.json" "$src/index.js" "$src/style.css" "$dst/" 2>/dev/null || true
    c_ok "  ✓ 前端扩展 → $dst"
}

fix_config() {
    f="$ST_PATH/config.yaml"
    [ -f "$f" ] || { c_warn "没有 config.yaml，跳过"; return 0; }
    if grep -qE '^[[:space:]]*enableServerPlugins:[[:space:]]*true' "$f"; then
        c_ok "  ✓ config.yaml 已开启 enableServerPlugins"
    else
        c_warn "  ! config.yaml 没开 enableServerPlugins（不改的话插件不会加载）"
        run cp -f "$f" "$f.bak-${TS}"
        if grep -qE '^[[:space:]]*enableServerPlugins:' "$f"; then
            sed_edit "$f" "s/^\\([[:space:]]*enableServerPlugins:\\).*/\\1 true/"
        else
            run sh -c "printf '\nenableServerPlugins: true\n' >> '$f'"
        fi
        c_ok "  ✓ 已改为 enableServerPlugins: true（备份 $f.bak-${TS}）"
    fi
    if grep -qE '^[[:space:]]*enableServerPluginsAutoUpdate:' "$f" && ! grep -qE '^[[:space:]]*enableServerPluginsAutoUpdate:[[:space:]]*true' "$f"; then
        sed_edit "$f" "s/^\\([[:space:]]*enableServerPluginsAutoUpdate:\\).*/\\1 true/"
        c_ok "  ✓ 已开启 enableServerPluginsAutoUpdate（以后启动自动更新插件）"
    fi
}

try_restart() {
    c_warn "→ 尝试自动重启酒馆…"
    if command -v systemctl >/dev/null 2>&1; then
        unit="$(systemctl list-units --type=service --no-legend --no-pager 2>/dev/null | awk '{print $1}' | grep -i -m1 sillytavern || true)"
        if [ -n "$unit" ]; then
            run systemctl restart "$unit" && { c_ok "  ✓ systemd 已重启：$unit"; return 0; }
        fi
    fi
    if command -v pm2 >/dev/null 2>&1; then
        name="$(pm2 jlist 2>/dev/null | tr ',' '\n' | grep -oE '"name":"[^"]*[Ss]illy[^"]*"' | head -n1 | sed 's/.*:"//;s/"//' || true)"
        if [ -n "$name" ]; then
            run pm2 restart "$name" && { c_ok "  ✓ pm2 已重启：$name"; return 0; }
        fi
    fi
    if command -v docker >/dev/null 2>&1; then
        cname="$(docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null | grep -i silly | head -n1 | cut -f1 || true)"
        if [ -n "$cname" ]; then
            run docker restart "$cname" && { c_ok "  ✓ docker 已重启容器：$cname"; return 0; }
        fi
    fi
    c_warn "  ! 没识别出怎么启动的，请自己重启一次酒馆（关掉进程重开 / 重启面板里点重启）"
    return 1
}

# ============ 主流程 ============
hr
echo "  数据清洁工 (ST Data Janitor) — 一键安装"
hr

if ! ST_PATH="$(detect_st "${FROM_DIR:-$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo "$PWD")}" 2>/dev/null)" || [ -z "$ST_PATH" ]; then
    c_err "找不到 SillyTavern 根目录（要看得到 config.yaml 的那一层）。"
    echo "  请手动指定，例如："
    echo "    bash install.sh --st /root/SillyTavern"
    exit 1
fi
echo "  SillyTavern：$ST_PATH"
echo "  用户目录：  data/$USER_DIR"

PLUGIN_DST="$ST_PATH/plugins/$PLUGIN_ID"
EXT_DST="$ST_PATH/data/$USER_DIR/extensions/$PLUGIN_ID"

if [ "$UNINSTALL" = "1" ]; then
    hr; echo "  卸载（只移走，不删除）"
    for d in "$PLUGIN_DST" "$EXT_DST"; do
        if [ -d "$d" ]; then
            run mv "$d" "$d.removed-${TS}"
            c_ok "  ✓ 已移走：$d → $d.removed-${TS}"
        fi
    done
    c_warn "  重启酒馆后生效。要彻底删掉：rm -rf '$ST_PATH/plugins/${PLUGIN_ID}.removed-${TS}'"
    hr; exit 0
fi

SRC=""
if [ "$LOCAL_FIRST" = "1" ]; then
    for cand in "${FROM_DIR:-}" "$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo)" ; do
        [ -n "$cand" ] || continue
        if [ "$DO_PLUGIN" = "1" ] && [ -f "$cand/plugin/index.mjs" ]; then SRC="$cand"; break; fi
        if [ "$DO_EXT" = "1" ] && [ -f "$cand/extension/manifest.json" ] && [ -f "$cand/extension/index.js" ]; then SRC="$cand"; break; fi
    done
fi

TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

# --- 服务端插件 ---
if [ "$DO_PLUGIN" = "1" ]; then
    hr; echo "  ① 服务端插件 → plugins/$PLUGIN_ID"
    if [ -n "$SRC" ]; then
        c_ok "  使用本地文件：$SRC/plugin"
        do_plugin_files "$SRC/plugin" "$PLUGIN_DST"
    else
        c_warn "  从 GitHub 下载最新发布（分支 $BRANCH）…"
        if fetch_mirrors "codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}" "$TMPD/plugin.tgz"; then
            if [ "$DRY" = "1" ]; then printf '  [演习] 解包并安装到 %s\n' "$PLUGIN_DST"
            else
                t="$TMPD/psrc"; mkdir -p "$t"
                extract_into "$TMPD/plugin.tgz" x "$t" || { c_err "解包失败"; exit 1; }
                # plugin-dist 根 = index.mjs + lib/
                do_plugin_files "$t" "$PLUGIN_DST"
            fi
        else
            c_err "  下载失败。网络不通的话试试："
            echo "    curl -fsSL https://gh-proxy.com/${RAW}/install.sh | bash -s -- --st \"$ST_PATH\""
            exit 1
        fi
    fi
fi

# --- 前端扩展 ---
if [ "$DO_EXT" = "1" ]; then
    hr; echo "  ② 前端扩展 → data/$USER_DIR/extensions/$PLUGIN_ID"
    if [ -n "$SRC" ] && [ -f "$SRC/extension/manifest.json" ]; then
        c_ok "  使用本地文件：$SRC/extension"
        do_ext_files "$SRC/extension" "$EXT_DST"
    else
        c_warn "  从 GitHub 下载（分支 $EXT_BRANCH）…"
        if fetch_mirrors "codeload.github.com/${REPO}/tar.gz/refs/heads/${EXT_BRANCH}" "$TMPD/ext.tgz"; then
            if [ "$DRY" = "1" ]; then printf '  [演习] 解包并安装到 %s\n' "$EXT_DST"
            else
                t="$TMPD/esrc"; mkdir -p "$t"
                extract_into "$TMPD/ext.tgz" x "$t" || { c_err "解包失败"; exit 1; }
                do_ext_files "$t" "$EXT_DST"
            fi
        else
            c_warn "  扩展下载失败 —— 别急，你也可以在酒馆里手动装："
            echo "    扩展 → 安装扩展 → URL 填 https://github.com/${REPO} ，分支填 ${EXT_BRANCH}"
        fi
    fi
fi

# --- config.yaml ---
hr; echo "  ③ 检查 config.yaml"
if [ "$FIX_CONFIG" = "1" ]; then fix_config
else
    if grep -qE '^[[:space:]]*enableServerPlugins:[[:space:]]*true' "$ST_PATH/config.yaml" 2>/dev/null; then
        c_ok "  ✓ enableServerPlugins 已开启"
    else
        c_warn "  ! config.yaml 没开 enableServerPlugins → 服务端插件不会加载"
        echo "    执行一次： bash install.sh --st \"$ST_PATH\" --fix-config      # 自动改（会备份）"
        echo "    或手动把 config.yaml 里 enableServerPlugins 改成 true"
        echo "    另外建议 enableServerPluginsAutoUpdate: true（启动时自动更新插件）"
    fi
fi

# --- 重启 ---
hr
if [ "$RESTART" = "1" ]; then try_restart
else
    c_warn "  最后一步：重启酒馆（关掉再打开 / 面板重启）插件才会加载"
    echo "    想让脚本自己重启： bash install.sh --st \"$ST_PATH\" --restart"
fi
hr
c_ok "  装好了 🌱"
echo "  · 重启后在酒馆「扩展」面板里能看到「数据清洁工 / ST Data Janitor」"
echo "  · 没看到就 Ctrl+F5 强刷一下页面"
echo "  · 卸载： bash install.sh --st \"$ST_PATH\" --uninstall"
hr
