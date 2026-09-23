#!/usr/bin/env bash
# 数据清洁工 (ST Data Janitor) — Docker 版一键安装
# 适用于「酒馆跑在 Docker 容器里」（官方镜像 / linuxserver / 群晖·飞牛·威联通 的容器套件）
#
# 用法：
#   bash install-docker.sh                          # 自动找容器名和容器内路径
#   bash install-docker.sh sillytavern              # 指定容器名
#   bash install-docker.sh sillytavern /app         # 再指定容器内 ST 路径
#   bash install-docker.sh sillytavern /home/node/app default-user --dry-run
set -eu

CNAME="${1:-}"
ST_IN="${2:-}"
USER_DIR="${3:-default-user}"
DRY=0
BRANCH="plugin-dist"
EXT_BRANCH="ext-dist"
REPO="wyndam-c/st-data-janitor"
TS="$(date +%Y%m%d-%H%M%S)"

for a in "$@"; do [ "$a" = "--dry-run" ] && DRY=1; done
run() { if [ "$DRY" = "1" ]; then printf '  [演习] %s\n' "$*"; else "$@"; fi; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
err()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
hr()   { printf '%s\n' "------------------------------------------------------------"; }

command -v docker >/dev/null 2>&1 || { err "这台机器上没有 docker 命令"; exit 1; }
hr; echo "  数据清洁工 — Docker 一键安装"; hr

if [ -z "$CNAME" ]; then
    CNAME="$(docker ps --format '{{.Names}}' | grep -i -E 'silly|tavern' | head -n1 || true)"
fi
[ -n "$CNAME" ] || { err "没找到疑似酒馆的容器，请手动指定：bash install-docker.sh <容器名>"; docker ps --format '  {{.Names}}\t{{.Image}}'; exit 1; }
echo "  容器：$CNAME"

if [ -z "$ST_IN" ]; then
    for p in /home/node/app /app /opt/SillyTavern /sillytavern /SillyTavern; do
        if docker exec "$CNAME" sh -c "test -f $p/config.yaml" 2>/dev/null; then ST_IN="$p"; break; fi
    done
fi
[ -n "$ST_IN" ] || { err "没在容器里找到 config.yaml，请手动指定容器内路径：bash install-docker.sh $CNAME <容器内ST路径>"; exit 1; }
echo "  容器内 ST：$ST_IN"
echo "  用户目录：  data/$USER_DIR"

TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT
fetch_gh() { # <github路径> <out>
    for base in "https://" "https://gh-proxy.com/https://" "https://ghfast.top/https://"; do
        if [ "$DRY" = "1" ]; then printf '  [演习] 下载 %s%s\n' "$base" "$1"; return 0; fi
        if command -v curl >/dev/null 2>&1; then
            curl -fL --connect-timeout 20 --retry 2 -m 600 -o "$2" "${base}${1}" 2>/dev/null && { echo "  ↓ ${base}${1}"; return 0; }
        elif command -v wget >/dev/null 2>&1; then
            wget -q -O "$2" "${base}${1}" 2>/dev/null && { echo "  ↓ ${base}${1}"; return 0; }
        fi
    done
    return 1
}

# 服务端插件
hr; echo "  ① 服务端插件 → $ST_IN/plugins/st-data-janitor"
if fetch_gh "codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}" "$TMPD/p.tgz"; then
    if [ "$DRY" = "1" ]; then echo "  [演习] 解包 + docker cp 进容器"
    else
        mkdir -p "$TMPD/p"; tar -xzf "$TMPD/p.tgz" -C "$TMPD/p"
        PSRC="$(find "$TMPD/p" -maxdepth 2 -name index.mjs | head -n1 | xargs -r dirname)"
        [ -n "$PSRC" ] || { err "  解包异常"; exit 1; }
        docker exec "$CNAME" sh -c "mkdir -p '$ST_IN/plugins/st-data-janitor'"
        if docker exec "$CNAME" sh -c "test -d '$ST_IN/plugins/st-data-janitor'"; then
            warn "  （旧版本保留在原处；如需回滚请自行备份）"
        fi
        docker cp "$PSRC/." "$CNAME:$ST_IN/plugins/st-data-janitor/"
        ok "  ✓ 已放进容器"
    fi
else err "  下载失败（网络不通可先配代理）"; exit 1; fi

# 前端扩展
hr; echo "  ② 前端扩展 → $ST_IN/data/$USER_DIR/extensions/st-data-janitor"
if fetch_gh "codeload.github.com/${REPO}/tar.gz/refs/heads/${EXT_BRANCH}" "$TMPD/e.tgz"; then
    if [ "$DRY" = "1" ]; then echo "  [演习] 解包 + docker cp 进容器"
    else
        mkdir -p "$TMPD/e"; tar -xzf "$TMPD/e.tgz" -C "$TMPD/e"
        ESRC="$(find "$TMPD/e" -maxdepth 2 -name manifest.json | head -n1 | xargs -r dirname)"
        docker exec "$CNAME" sh -c "mkdir -p '$ST_IN/data/$USER_DIR/extensions/st-data-janitor'"
        docker cp "$ESRC/." "$CNAME:$ST_IN/data/$USER_DIR/extensions/st-data-janitor/"
        ok "  ✓ 已放进容器（扩展目录在 data 里，可能被云同步带走，注意别和 git 打架）"
    fi
else warn "  扩展下载失败 —— 也可在酒馆里手动装：扩展 → 安装扩展 → URL $REPO，分支 $EXT_BRANCH"; fi

# config.yaml
hr; echo "  ③ 检查 enableServerPlugins"
if docker exec "$CNAME" sh -c "grep -qE '^[[:space:]]*enableServerPlugins:[[:space:]]*true' '$ST_IN/config.yaml'" 2>/dev/null; then
    ok "  ✓ 已开启"
else
    warn "  ! 容器里 config.yaml 没开 enableServerPlugins"
    echo "    容器外改（推荐，改的是你映射出来的那份）："
    echo "      docker exec $CNAME sed -i 's/^\\\\([[:space:]]*enableServerPlugins:\\\\).*/\\\\1 true/' $ST_IN/config.yaml"
    echo "      再执行： docker restart $CNAME"
fi

hr
warn "  最后一步：重启容器 → docker restart $CNAME"
echo "  重启后在酒馆「扩展」面板能看到「数据清洁工」，没看到就 Ctrl+F5"
hr
