#!/bin/sh
# v1.16.0: 从 base64 文本还原头像 PNG
# GitHub MCP 只能推送文本文件，二进制 PNG 以 .b64 形式存于 client/avatar-src/
# Dockerfile 构建时调用本脚本，还原到 client/public/avatars/
set -e
SRC_DIR="$(dirname "$0")/../client/avatar-src"
DST_DIR="$(dirname "$0")/../client/public/avatars"
mkdir -p "$DST_DIR"
count=0
for b64 in "$SRC_DIR"/*.b64; do
  [ -f "$b64" ] || continue
  name="$(basename "$b64" .b64).png"
  base64 -d "$b64" > "$DST_DIR/$name"
  count=$((count + 1))
done
echo "[avatars] decoded $count PNGs to $DST_DIR"
