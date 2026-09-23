#!/usr/bin/env bash
# 重新生成发布分支 plugin-dist / ext-dist
#
# 背景：
#   1) SillyTavern 的「更新插件/扩展」走 `git pull`（simple-git 的 pull()），
#      一旦历史被 force-push 改写，就会报 “Not possible to fast-forward, aborting” → 更新失败。
#   2) 插件/扩展目录本身要作为 git 仓库根，而本仓库源码是 plugin/ + extension/ 两个子目录。
#
# 做法：不用 `git subtree split`（它会产生与旧分支无关的新历史，只能 force-push），
#      而是把 plugin/ 或 extension/ 的**目录树**直接做成一个新提交，父提交指向
#      **远端该分支当前的 tip** —— 于是每次推送天然 fast-forward，ST 的 `git pull` 永远不会失败。
#
# 可用环境变量覆盖（主要给测试用）：
#   PUBLISH_REMOTE   远端名/URL（默认 origin）
#   PUBLISH_TARGETS  "前缀:分支" 列表（默认 "plugin:plugin-dist extension:ext-dist"）
set -euo pipefail
cd "$(dirname "$0")"

REMOTE="${PUBLISH_REMOTE:-origin}"
TARGETS="${PUBLISH_TARGETS:-plugin:plugin-dist extension:ext-dist}"

VER=$(grep -m1 "version:" plugin/index.mjs | sed -E "s/.*'([^']+)'.*/\1/")
MSG="release: v${VER:-?}"

echo "== fetching $REMOTE =="
# 显式抓取所有分支到临时命名空间：既把对象拉到本地（后面要 rev-parse 远端 tip 的 tree），
# 也避免对 path/URL 远端时因缺 HEAD 而报错。
git fetch "$REMOTE" -q '+refs/heads/*:refs/remotes/_publish/*' || true

publish() {
  local prefix="$1" branch="$2"
  local tree tip tip_tree commit
  tree=$(git rev-parse "HEAD:${prefix}")

  tip=$(git ls-remote "$REMOTE" "refs/heads/${branch}" 2>/dev/null | cut -f1)
  if [ -n "$tip" ]; then
    tip_tree=$(git rev-parse --verify -q "${tip}^{tree}") || tip_tree=""
    if [ "$tree" = "$tip_tree" ]; then
      echo "== ${branch}：内容未变，跳过 =="
      return 0
    fi
    commit=$(git commit-tree "$tree" -p "$tip" -m "$MSG")   # 父提交 = 远端 tip → fast-forward
  else
    echo "== ${branch}：远端分支不存在，建新分支 =="
    commit=$(git commit-tree "$tree" -m "$MSG")
  fi

  git update-ref "refs/heads/${branch}" "$commit"
  git push "$REMOTE" "refs/heads/${branch}:refs/heads/${branch}"   # 不加 -f：不是 FF 就报错
  echo "== ${branch} -> ${commit:0:9}  (parent: ${tip:0:9}) =="
}

for t in $TARGETS; do
  publish "${t%%:*}" "${t##*:}"
done

# 清理临时抓取命名空间（对象会留着，不影响后面的 rev-parse）
git for-each-ref --format='%(refname)' 'refs/remotes/_publish/*' 2>/dev/null | while read -r r; do git update-ref -d "$r"; done

echo "== 完成 =="
git ls-remote "$REMOTE" | grep dist || true
