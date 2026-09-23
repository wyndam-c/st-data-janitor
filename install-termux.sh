#!/usr/bin/env bash
# 数据清洁工 (ST Data Janitor) 一键安装器 —— 手机 / 安卓 / Termux（含 proot-distro）
#
# 用法（在 Termux 里贴这一行）：
#   pkg install -y curl && curl -fsSL https://raw.githubusercontent.com/wyndam-c/st-data-janitor/main/install-termux.sh | bash
#   bash install-termux.sh --fix-config --restart     # 装好顺手改配置 + 重启酒馆
#   bash install-termux.sh --st /data/data/com.termux/files/home/SillyTavern
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
#   --restart          装完尝试重启酒馆（pm2 / proot / start.sh / node server.js）
#   --wake-lock        申请 Termux 唤醒锁（默认在 Termux 里自动开，防安卓杀后台）
#   --no-wake-lock     不申请唤醒锁
#   --autostart        写一个 Termux:Boot 开机自启脚本（需要装 Termux:Boot 应用）
#   --deps             缺什么就 pkg install 什么（nodejs/curl/tar）
#   --uninstall        卸载（移到备份目录，不直接删）
#   --dry-run          演习，不动任何文件
#   -h | --help        帮助
set -eu

REPO="wyndam-c/st-data-janitor"
RAW="https://raw.githubusercontent.com/${REPO}/main"
DEFAULT_BRANCH="plugin-dist"
EXT_BRANCH="ext-dist"
PLUGIN_ID="st-data-janitor"
TS="$(date +%Y%m%d-%H%M%S)"
TERMUX_PREFIX_DEFAULT="/data/data/com.termux/files/usr"

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
DO_DEPS=0
AUTOSTART=0
WAKE_LOCK=auto   # auto | 1 | 0
PORT=8000

c_ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
c_warn() { printf '\033[33m%s\033[0m\n' "$*"; }
c_err()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
hr()     { printf '%s\n' "------------------------------------------------------------"; }

usage() { sed -n '2,30p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true; }

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
        --wake-lock) WAKE_LOCK=1; shift ;;
        --no-wake-lock) WAKE_LOCK=0; shift ;;
        --autostart) AUTOSTART=1; shift ;;
        --deps) DO_DEPS=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        --dry-run) DRY=1; shift ;;
        --port) PORT="${2:-8000}"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        -*) c_err "未知参数：$1（用 --help 看用法）"; exit 2 ;;
        *) ST_PATH="$1"; shift ;;
    esac
done

run() {
    if [ "$DRY" = "1" ]; then printf '  [演习] %s\n' "$*"; else "$@"; fi
}

# 可移植的 sed 就地编辑（用临时文件，避开各平台 sed -i 差异）
sed_edit() { # <文件> <sed 脚本>
    if [ "$DRY" = "1" ]; then printf '  [演习] sed -e %s %s\n' "$2" "$1"; return 0; fi
    _t="$(mktemp)"
    if sed -e "$2" "$1" > "$_t"; then cat "$_t" > "$1"; fi
    rm -f "$_t"
}

# ---------- 环境判断 ----------
is_termux() {
    [ -n "${PREFIX:-}" ] && case "$PREFIX" in *com.termux*) return 0 ;; esac
    command -v termux-wake-lock >/dev/null 2>&1 && return 0
    [ "${ANDROID_ROOT:-}" = "/system" ] && return 0
    return 1
}

is_proot_rootfs() { # <路径> 是否在 proot-distro 的 rootfs 里
    case "${1:-}" in
        *"/proot-distro/installed-rootfs/"*) return 0 ;;
    esac
    return 1
}

proot_distro_name() { # 从路径里抠出发行版名（ubuntu / debian …）
    printf '%s' "${1:-}" | sed -n 's#.*/installed-rootfs/\([^/]*\)/.*#\1#p' | head -n1
}

# ---------- 依赖 ----------
need_deps() {
    _miss=""
    command -v node >/dev/null 2>&1 || _miss="$_miss nodejs"
    { command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; } || _miss="$_miss curl"
    command -v tar  >/dev/null 2>&1 || _miss="$_miss tar"
    [ -z "$_miss" ] && return 0
    c_warn "  缺少依赖：$_miss"
    if [ "$DO_DEPS" = "1" ]; then
        run pkg install -y $_miss
    else
        echo "    装一下： pkg install -y $_miss   （或重跑本脚本并加 --deps）"
        case "$_miss" in *nodejs*) c_err "  没有 node 就没法跑酒馆，先装 nodejs"; return 1 ;; esac
    fi
    return 0
}

# ---------- 找 SillyTavern ----------
is_st_root() {
    [ -n "${1:-}" ] && [ -d "$1" ] && [ -f "$1/config.yaml" ] \
        && { [ -f "$1/package.json" ] || [ -f "$1/src/plugin-loader.js" ] || [ -f "$1/server.js" ]; }
}

detect_st() {
    # 0) 显式指定优先
    if [ -n "${ST_PATH:-}" ] && is_st_root "$ST_PATH"; then printf '%s\n' "$ST_PATH"; return 0; fi
    # 1) 从脚本所在目录往上找
    local d="$1"
    while [ -n "$d" ] && [ "$d" != "/" ]; do
        if is_st_root "$d"; then printf '%s\n' "$d"; return 0; fi
        d="$(dirname "$d")"
    done
    # 2) 常见路径（Termux 家目录 → 共享存储 → proot rootfs）
    local home="${HOME:-/data/data/com.termux/files/home}"
    for d in \
        "$PWD" "$PWD/SillyTavern" "$PWD/sillytavern" \
        "$home/SillyTavern" "$home/sillytavern" "$home/SillyTavern-release" \
        "$home/st" "$home/apps/SillyTavern" \
        "$TERMUX_PREFIX_DEFAULT/../home/SillyTavern" \
        "/data/data/com.termux/files/home/SillyTavern" \
        "/sdcard/SillyTavern" "/storage/emulated/0/SillyTavern" \
        "/root/SillyTavern" "/opt/SillyTavern"
    do
        if is_st_root "$d"; then printf '%s\n' "$d"; return 0; fi
    done
    # 3) proot-distro 的各个发行版里找
    local base="${PREFIX:-$TERMUX_PREFIX_DEFAULT}/var/lib/proot-distro/installed-rootfs"
    if [ -d "$base" ]; then
        for root in "$base"/*; do
            for d in "$root/root/SillyTavern" "$root/home"/*/SillyTavern "$root/opt/SillyTavern"; do
                if is_st_root "$d"; then printf '%s\n' "$d"; return 0; fi
            done
        done
    fi
    return 1
}

# ---------- 下载 ----------
fetch() { # <url> <out>
    if command -v curl >/dev/null 2>&1; then
        curl -fL --connect-timeout 20 --retry 2 --retry-delay 2 -m 600 -o "$2" "$1" 2>/dev/null
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$2" --timeout=60 --tries=3 "$1"
    else
        c_err "没找到 curl 或 wget： pkg install -y curl"; return 1
    fi
}

# 依次试：直连 → gh-proxy 镜像 → ghfast 镜像（手机流量/国内网络友好）
fetch_mirrors() { # <github路径> <out>
    for base in "https://" "https://gh-proxy.com/https://" "https://ghfast.top/https://"; do
        url="${base}${1}"
        if fetch "$url" "$2"; then printf '  ↓ %s\n' "$url"; return 0; fi
        [ "$DRY" = "1" ] && { printf '  [演习] 尝试 %s\n' "$url"; return 0; }
    done
    return 1
}

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
            sed_edit "$f" "s/^\([[:space:]]*enableServerPlugins:\).*/\1 true/"
        else
            run sh -c "printf '\nenableServerPlugins: true\n' >> '$f'"
        fi
        c_ok "  ✓ 已改为 enableServerPlugins: true（备份 $f.bak-${TS}）"
    fi
    if grep -qE '^[[:space:]]*enableServerPluginsAutoUpdate:' "$f" && ! grep -qE '^[[:space:]]*enableServerPluginsAutoUpdate:[[:space:]]*true' "$f"; then
        sed_edit "$f" "s/^\([[:space:]]*enableServerPluginsAutoUpdate:\).*/\1 true/"
        c_ok "  ✓ 已开启 enableServerPluginsAutoUpdate（以后启动自动更新插件）"
    fi
}

wake_lock() {
    [ "$WAKE_LOCK" = "0" ] && return 0
    is_termux || return 0
    if command -v termux-wake-lock >/dev/null 2>&1; then
        run termux-wake-lock && c_ok "  ✓ 已申请 Termux 唤醒锁（防安卓杀后台）"
    else
        c_warn "  ! 没有 termux-wake-lock（pkg install -y termux-tools 后可用）"
    fi
}

autostart() { # 写 Termux:Boot 自启脚本
    is_termux || { c_warn "  不是 Termux，跳过开机自启"; return 0; }
    d="${HOME}/.termux/boot"
    f="$d/stj-start-st.sh"
    run mkdir -p "$d"
    if [ "$DRY" = "1" ]; then printf '  [演习] 写 %s（termux-wake-lock + cd %s && bash start.sh）\n' "$f" "$ST_PATH"
    else
        cat > "$f" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
# 由「数据清洁工」安装器的 --autostart 生成：开机后拉起酒馆
termux-wake-lock
cd "$ST_PATH" || exit 1
exec bash start.sh
EOF
        chmod +x "$f"
    fi
    c_ok "  ✓ 开机自启脚本：$f"
    c_warn "  ! 需要装「Termux:Boot」应用，并在里面允许 Termux 自启，才会生效"
}

try_restart() {
    c_warn "→ 尝试自动重启酒馆…"
    wake_lock
    # 1) pm2
    if command -v pm2 >/dev/null 2>&1; then
        name="$(pm2 jlist 2>/dev/null | tr ',' '\n' | grep -oE '"name":"[^"]*[Ss]illy[^"]*"' | head -n1 | sed 's/.*:"//;s/"//' || true)"
        if [ -n "$name" ]; then
            run pm2 restart "$name" && c_ok "  ✓ pm2 已重启：$name"
            probe_port; return 0
        fi
    fi
    # 2) proot-distro 里的酒馆
    if is_proot_rootfs "$ST_PATH" && command -v proot-distro >/dev/null 2>&1; then
        distro="$(proot_distro_name "$ST_PATH")"
        inner="/$(printf '%s' "$ST_PATH" | sed "s#.*/installed-rootfs/$distro/##")"
        c_warn "  酒馆在 proot($distro) 里，尝试重启…"
        run proot-distro login "$distro" -- bash -lc "pkill -f 'node .*server.js' || true; sleep 1; cd '$inner' && nohup bash start.sh > st.out.log 2>&1 &" \
            && c_ok "  ✓ 已在 proot($distro) 里重新拉起：$inner"
        probe_port; return 0
    fi
    # 3) 本机：先杀掉旧进程，再用 start.sh / node server.js 拉起
    if command -v node >/dev/null 2>&1 || [ -f "$ST_PATH/start.sh" ]; then
        run sh -c "pkill -f 'node .*server.js' || true"
        if [ "$DRY" = "1" ]; then printf '  [演习] cd %s && nohup bash start.sh > st.out.log 2>&1 &\n' "$ST_PATH"
        else
            sleep 1
            if [ -f "$ST_PATH/start.sh" ]; then
                ( cd "$ST_PATH" && nohup bash start.sh > st.out.log 2>&1 & )
            else
                ( cd "$ST_PATH" && nohup node server.js > st.out.log 2>&1 & )
            fi
        fi
        c_ok "  ✓ 已重新拉起（日志：$ST_PATH/st.out.log）"
        probe_port; return 0
    fi
    c_warn "  ! 没识别出怎么启动的，请自己重启酒馆（切回跑酒馆那个会话，Ctrl+C 再重开）"
    return 1
}

probe_port() {
    [ "$DRY" = "1" ] && return 0
    printf '  … 等酒馆起来'
    i=0
    while [ "$i" -lt 12 ]; do
        i=$((i+1)); sleep 2
        code="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:${PORT}/" 2>/dev/null || true)"
        printf '.'
        if [ "$code" = "200" ] || [ "$code" = "302" ] || [ "$code" = "401" ]; then
            printf '\n'; c_ok "  ✓ 酒馆起来了（HTTP $code，端口 $PORT）"; return 0
        fi
    done
    printf '\n'; c_warn "  ! ${i}0 秒内没等到响应，去看看日志： tail -f \"$ST_PATH/st.out.log\""
    return 1
}

# ============ 主流程 ============
hr
echo "  数据清洁工 (ST Data Janitor) — 手机 / Termux 一键安装"
is_termux && echo "  环境：Termux（PREFIX=${PREFIX:-未设置}）" || echo "  环境：不是 Termux（按普通 Linux 处理）"
hr

need_deps || exit 1

if ! ST_PATH="$(detect_st "${FROM_DIR:-$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo "$PWD")}" 2>/dev/null)" || [ -z "$ST_PATH" ]; then
    c_err "找不到 SillyTavern 根目录（要看得到 config.yaml 的那一层）。"
    echo "  手机上的常见位置：~/SillyTavern、/sdcard/SillyTavern、proot 里的 /root/SillyTavern"
    echo "  手动指定： bash install-termux.sh --st \"\$HOME/SillyTavern\""
    echo "  找不到酒馆根目录？先看看： ls ~ ; ls /sdcard | head"
    exit 1
fi
echo "  SillyTavern：$ST_PATH"
echo "  用户目录：  data/$USER_DIR"
case "$ST_PATH" in
    /sdcard/*|/storage/emulated/*)
        c_warn "  ! 酒馆放在共享存储上，安卓可能在后台杀它；建议挪到 ~/SillyTavern（需要的话先 termux-setup-storage）" ;;
esac

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
    for cand in "${FROM_DIR:-}" "$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo)"; do
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
                do_plugin_files "$t" "$PLUGIN_DST"
            fi
        else
            c_err "  下载失败。流量/网络不通的话试试镜像："
            echo "    curl -fsSL https://gh-proxy.com/${RAW}/install-termux.sh | bash -s -- --st \"$ST_PATH\""
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
            c_warn "  扩展下载失败 —— 也可以在酒馆里手动装："
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
        echo "    执行一次： bash install-termux.sh --st \"$ST_PATH\" --fix-config"
    fi
fi

# --- 保活 / 自启 ---
if is_termux; then
    hr; echo "  ④ 手机保活"
    wake_lock
    [ "$AUTOSTART" = "1" ] && autostart
    echo "    · 想让酒馆关机/重启后自己起来： bash install-termux.sh --st \"$ST_PATH\" --autostart（需装 Termux:Boot）"
    echo "    · 平时别在 Termux 里按「退出」；从通知栏点 Termux 的「Acquire wakelock」也行"
fi

# --- 重启 ---
hr
if [ "$RESTART" = "1" ]; then try_restart
else
    c_warn "  最后一步：重启酒馆插件才会加载"
    echo "    手机上就是：切回跑酒馆那个 Termux 会话，Ctrl+C 停掉，再 bash start.sh"
    echo "    也可以让脚本自己重启： bash install-termux.sh --st \"$ST_PATH\" --restart"
fi
hr
c_ok "  装好了 🌱"
echo "  · 重启后在酒馆「扩展」面板里能看到「数据清洁工 / ST Data Janitor」"
echo "  · 手机浏览器记得强刷一次（Chrome 菜单 → 刷新，或清一下缓存）"
echo "  · 卸载： bash install-termux.sh --st \"$ST_PATH\" --uninstall"
hr
