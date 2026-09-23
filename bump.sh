#!/usr/bin/env bash
# bump.sh —— 版本号「一次性」全量更新
#
# 用法：
#   ./bump.sh 1.3.0                 # 只改文件（版本号 + CHANGELOG 标题），打印 diff，不提交
#   ./bump.sh 1.3.0 --commit        # 改完顺便 git commit
#   ./bump.sh 1.3.0 --commit --publish   # 再跑 publish.sh 生成 dist 分支
#   ./bump.sh --check               # 只体检：4 处版本号是否一致
#   ./bump.sh v1.2.0 --release      # 给已有 tag 建 GitHub Release（需 GITHUB_TOKEN 环境变量）
#
# 会同步的地方（4 处 / 单一事实来源 = plugin/index.mjs）：
#   1. plugin/index.mjs          version: 'x.y.z'
#   2. extension/manifest.json   "version": "x.y.z"
#   3. README.md                 徽章 version-x.y.z
#   4. CHANGELOG.md              ## [未发布] -> ## [x.y.z] — 今天
#
# 说明：dist 分支（plugin-dist / ext-dist）的版本号会由 publish.sh 从源码目录重建，
#       不需要单独改，改完源码跑一次 publish.sh 即可。
set -euo pipefail
cd "$(dirname "$0")"

SRC_VER_FILE="plugin/index.mjs"
MANIFEST="extension/manifest.json"
README="README.md"
CHANGELOG="CHANGELOG.md"

read_src_version() { grep -m1 "version:" "$SRC_VER_FILE" | sed -E "s/.*'([^']+)'.*/\1/"; }
read_manifest_version() { grep -m1 '"version"' "$MANIFEST" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'; }
read_readme_version() { grep -m1 -oE 'version-[0-9]+\.[0-9]+\.[0-9]+' "$README" | sed 's/version-//'; }

check() {
  local a b c
  a=$(read_src_version); b=$(read_manifest_version); c=$(read_readme_version)
  printf 'plugin/index.mjs        : %s\n' "$a"
  printf 'extension/manifest.json: %s\n' "$b"
  printf 'README.md 徽章          : %s\n' "$c"
  if [ "$a" = "$b" ] && [ "$b" = "$c" ]; then
    echo "✅ 版本号一致：$a"
  else
    echo "❌ 版本号不一致！请用 ./bump.sh <版本> 同步" >&2
    return 1
  fi
}

# ---------- --check ----------
if [ "${1:-}" = "--check" ] || [ "${1:-}" = "-c" ]; then
  check
  exit $?
fi

# ---------- --release（给已有 tag 建 Release） ----------
if [ "${1:-}" = "--release" ]; then
  VER="${2:-$(read_src_version)}"; VER="${VER#v}"
  : "${GITHUB_TOKEN:?需要 GITHUB_TOKEN 环境变量}"
  REPO="${GITHUB_REPO:-wyndam-c/st-data-janitor}"
  BODY=$(python3 - "$VER" "$CHANGELOG" <<'PY'
import re, sys
ver, path = sys.argv[1], sys.argv[2]
txt = open(path, encoding='utf-8').read()
m = re.search(r'^## \[' + re.escape(ver) + r'\][^\n]*\n(.*?)(?=^## \[|\Z)', txt, re.S | re.M)
print((m.group(1).strip() if m else f'v{ver}').strip())
PY
)
  PAYLOAD=$(python3 -c 'import json,sys;print(json.dumps({"tag_name":"v"+sys.argv[1],"name":"v"+sys.argv[1],"body":sys.argv[2],"draft":False,"prerelease":False},ensure_ascii=False))' "$VER" "$BODY")
  echo "== 创建 GitHub Release v$VER ($REPO) =="
  curl -sS -o /tmp/_rel_out.json -w 'HTTP %{http_code}\n' \
    -X POST "https://api.github.com/repos/$REPO/releases" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -d "$PAYLOAD"
  python3 -c 'import json;d=json.load(open("/tmp/_rel_out.json"));print(d.get("html_url") or d.get("message","(无消息)"))'
  rm -f /tmp/_rel_out.json
  exit 0
fi

# ---------- 正常 bump ----------
NEW="${1:-}"
COMMIT=0; PUBLISH=0
for a in "${@:2}"; do
  case "$a" in
    --commit) COMMIT=1 ;;
    --publish) PUBLISH=1 ;;
    *) echo "未知参数：$a" >&2; exit 2 ;;
  esac
done

NEW="${NEW#v}"
if ! printf '%s' "$NEW" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "用法：./bump.sh <x.y.z> [--commit] [--publish]" >&2
  echo "      ./bump.sh --check | ./bump.sh [vX.Y.Z] --release" >&2
  exit 2
fi

OLD=$(read_src_version)
echo "== 版本：$OLD -> $NEW =="

# 1) plugin/index.mjs
sed -i -E "0,/version:[[:space:]]*'[^']*'/s//version: '$NEW'/" "$SRC_VER_FILE"
# 2) extension/manifest.json
sed -i -E "0,/\"version\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/s//\"version\": \"$NEW\"/" "$MANIFEST"
# 3) README 徽章
sed -i -E "s/version-[0-9]+\.[0-9]+\.[0-9]+/version-$NEW/" "$README"
# 4) CHANGELOG：把「未发布」变成正式版本（若该版本标题已存在则不动）
if grep -qE "^## \[$NEW\]" "$CHANGELOG"; then
  echo "   CHANGELOG：已存在 [${NEW}] 小节，保持原样"
elif grep -qE '^## \[未发布\]' "$CHANGELOG"; then
  TODAY=$(date +%F)
  sed -i -E "0,/^## \[未发布\]/s//## [$NEW] — $TODAY/" "$CHANGELOG"
  echo "   CHANGELOG：[未发布] -> [$NEW] — $TODAY"
else
  echo "   ⚠️ CHANGELOG 里没有 [未发布] 也没有 [$NEW]，请手动补一节" >&2
fi

echo
echo "== 改动 =="
git --no-pager diff --stat
echo
check

if [ "$COMMIT" = 1 ]; then
  git add -A "$SRC_VER_FILE" "$MANIFEST" "$README" "$CHANGELOG"
  git commit -q -m "chore(release): v$NEW"
  echo "== 已提交：v$NEW =="
  git --no-pager log --oneline -1
fi

if [ "$PUBLISH" = 1 ]; then
  echo "== ./publish.sh =="
  ./publish.sh
fi

cat <<EOF

下一步（可选）：
  git push origin main
  git tag -a v$NEW -m "v$NEW" && git push origin v$NEW
  GITHUB_TOKEN=xxx ./bump.sh v$NEW --release    # 建 GitHub Release
EOF
