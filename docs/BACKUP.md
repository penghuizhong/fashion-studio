# fashion-studio 数据备份

DATA_DIR（默认 `/opt/fashion-studio/data`）包含：SQLite 数据库、上传的趋势图/生成图。代码在 GitHub，数据不在——必须备份。

## VPS 每日自动备份（保留 7 天）

```bash
# /opt/fashion-studio/backup.sh
#!/bin/bash
set -e
SRC=/opt/fashion-studio/data
DST=/opt/fashion-studio/backups
mkdir -p "$DST"
# sqlite3 在线热备（服务不中断；库文件名为 fashion-studio.db）
sqlite3 "$SRC/fashion-studio.db" ".backup '$DST/fashion-studio-$(date +%F).db'" 2>/dev/null || cp "$SRC/fashion-studio.db" "$DST/fashion-studio-$(date +%F).db"
tar -czf "$DST/data-$(date +%F).tar.gz" -C /opt/fashion-studio data
find "$DST" -name '*.db' -o -name '*.tar.gz' | sort | head -n -14 | xargs -r rm -f
```

```bash
chmod +x /opt/fashion-studio/backup.sh
crontab -e
# 每天 03:00 执行
0 3 * * * /opt/fashion-studio/backup.sh >> /var/log/fashion-backup.log 2>&1
```

## Mac 手动同步（保留 30 天）

```bash
rsync -avz -e "ssh -p 28989" root@43.130.1.94:/opt/fashion-studio/backups/ ~/backups/fashion-studio/
```

建议每月 1 号执行一次；backups 目录按文件名日期清理 30 天前的。

## 恢复

```bash
systemctl stop fashion-studio
tar -xzf data-YYYY-MM-DD.tar.gz -C /opt/fashion-studio
# 或单独恢复数据库：
cp backups/fashion-studio-YYYY-MM-DD.db /opt/fashion-studio/data/fashion-studio.db
systemctl start fashion-studio
curl -s http://127.0.0.1:3100/api/config
```
