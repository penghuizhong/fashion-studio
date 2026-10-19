#!/bin/sh
# v1.16.0: 从 base64 文本还原头像；v0.2.2: 改为 WebP（128px）
# GitHub MCP 只能推送文本文件，二进制 WebP 以 .b64 形式存于 client/avatar-src/
# npm run build 的 prebuild 钩子调用本脚本，还原到 client/public/avatars/
# 保留已有 PNG，避免构建改变受跟踪文件。
set -e
SRC_DIR="$(dirname "$0")/../client/avatar-src"
DST_DIR="$(dirname "$0")/../client/public/avatars"
mkdir -p "$DST_DIR"
count=0
for b64 in "$SRC_DIR"/*.b64; do
  [ -f "$b64" ] || continue
  name="$(basename "$b64" .b64)"
  # macOS/BSD base64 uses -D; GNU/Linux uses -d.
  tmp="$DST_DIR/$name.tmp"
  if [ "$(uname -s)" = "Darwin" ]; then
    if ! base64 -D -i "$b64" -o "$tmp"; then
      rm -f "$tmp"
      exit 1
    fi
  else
    if ! base64 -d < "$b64" > "$tmp"; then
      rm -f "$tmp"
      exit 1
    fi
  fi
  mv "$tmp" "$DST_DIR/$name"
  count=$((count + 1))
done
# Preserve legacy tracked PNGs; decoding must never delete repository assets.
echo "[avatars] decoded $count WebP to $DST_DIR (legacy PNGs preserved)"
