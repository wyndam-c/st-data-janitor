#!/usr/bin/env bash
# 重新生成发布分支 plugin-dist / ext-dist
# 说明：SillyTavern 的「更新插件」要求 插件目录本身就是 git 仓库根，
#      而本仓库源码是 plugin/ + extension/ 两个子目录 → 用 subtree split 摊平到独立分支。
set -e
cd "$(dirname "$0")"
echo "== 生成 plugin-dist（服务端插件）=="
git subtree split -P plugin -b plugin-dist
echo "== 生成 ext-dist（前端扩展）=="
git subtree split -P extension -b ext-dist
echo "== 推送 =="
git push -f origin plugin-dist ext-dist
echo "== 完成 =="
git ls-remote origin | grep dist
