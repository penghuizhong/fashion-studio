#!/bin/sh
# v1.16.0: 从 base64 文本还原头像；v0.2.2: 改为 WebP（128px）
# GitHub MCP 只能推送文本文件，二进制 WebP 以 .b64 形式存于 client/avatar-src/
# npm run build 的 prebuild 钩子调用本脚本，还原到 client/public/avatars/
# （同时清理已废弃的 PNG，避免 dist 膨胀）
set -e
SRC_DIR="$(dirname "$0")/../client/avatar-src"
DST_DIR="$(dirname "$0")/../client/public/avatars"
mkdir -p "$DST_DIR"
count=0
for b64 in "$SRC_DIR"/*.b64; do
  [ -f "$b64" ] || continue
  name="$(basename "$b64" .b64)"
  base64 -d "$b64" > "$DST_DIR/$name"
  count=$((count + 1))
done
# 清理旧 PNG（已由 WebP 替代，留着会进 dist）
rm -f "$DST_DIR"/*.png
echo "[avatars] decoded $count WebP to $DST_DIR (old PNGs removed)"
