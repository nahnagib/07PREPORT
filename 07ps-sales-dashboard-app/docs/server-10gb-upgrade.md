# etl-api 10G memory limit — production rollout

What changes (`docker-compose.yml`, production only):

| Service | Limit | Reservation | Other |
|---|---|---|---|
| etl-api | **10G** (was 3G) | **4G** (soft: never blocks startup) | each job logs its `peak memory` at the end |
| backend | 768M (unchanged) | — | `NODE_OPTIONS=--max-old-space-size=512` |
| etl-worker | 512M (unchanged) | — | `NODE_OPTIONS=--max-old-space-size=256` |
| frontend | 768M (unchanged) | — | — |
| redis | 256M (unchanged) | — | `--maxmemory 192mb --maxmemory-policy noeviction` (BullMQ requires `noeviction`) |

The laptop stacks (`docker-compose.local.yml`, `docker-compose.test-stack.yml`) override etl-api back to 3G with no
reservation. A plain `docker compose up` on the laptop (no override file) would use the production 10G. A limit is
only a ceiling, so it reserves no memory.

Why 10G: the 02:00 full refresh and the long-lane sales build (`sales_build`, queue `etl-long`) run as **two Python
processes side by side** in the etl-api container, and their peaks add up. With the old 3G limit a run that needed
more was OOM-killed. After the rollout, every job logs its real peak (see "After the next 02:00 refresh"), so the
limit can come down once that peak is known.

## 1. MySQL settings to check (do not change blindly)

MySQL is not in Docker; its settings live in the server's `my.cnf`. Look first:

```bash
# Which option files mysqld reads
mysqld --verbose --help 2>/dev/null | grep -A1 "Default options"

# Current values
mysql -e "SELECT @@innodb_buffer_pool_size/1048576 AS buffer_pool_mb, @@max_connections,
          @@tmp_table_size/1048576 AS tmp_table_mb, @@max_heap_table_size/1048576 AS max_heap_mb,
          @@sort_buffer_size/1024 AS sort_kb, @@join_buffer_size/1024 AS join_kb;"

# Data size (the buffer pool is sized from this)
mysql -e "SELECT table_schema, ROUND(SUM(data_length+index_length)/1048576) AS mb
          FROM information_schema.tables GROUP BY table_schema ORDER BY mb DESC;"

# Is the pool big enough today? reads / read_requests should be well under 1%; free pages near 0 = pool is full
mysql -e "SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_buffer_pool_pages_total','Innodb_buffer_pool_pages_free',
          'Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads','Max_used_connections',
          'Created_tmp_tables','Created_tmp_disk_tables');"
```

Recommended values (`[mysqld]` section):

```ini
[mysqld]
innodb_buffer_pool_size = <powerBI_Data MB x 1.2, rounded up to a multiple of 128M>   # e.g. 2,000 MB data -> 2432M
max_connections         = 100     # backend pool is 10, ETL needs a few more; each connection can use the buffers below
tmp_table_size          = 64M     # keep tmp_table_size = max_heap_table_size (MySQL uses the smaller of the two)
max_heap_table_size     = 64M
sort_buffer_size        = 256K    # per connection: keep small
join_buffer_size        = 256K    # per connection: keep small
```

`innodb_buffer_pool_size` can be changed online (`SET GLOBAL innodb_buffer_pool_size = ...;`), but put it in
`my.cnf` too or it is lost on restart. The other values need a MySQL restart to apply from `my.cnf`. Make sure the
server still has room for the containers: etl-api can use up to 10G, plus about 2.3G for the other containers and
about 1.5G for the OS.

## 2. Deploy

1. **Back up the warehouse**

   ```bash
   mysqldump --single-transaction --routines --triggers powerBI_Data | gzip > ~/powerBI_Data_$(date +%Y%m%d_%H%M).sql.gz
   ls -lh ~/powerBI_Data_*.sql.gz      # non-zero size
   ```

2. **Pick a moment when no ETL is running.** Building images (`next build` especially) takes 1.5–2 GB on top of
   the running stack. Avoid the 02:00 full refresh and the minutes around each 30-minute refresh. Check that no run
   is active in the ETL Control Center, or:

   ```bash
   docker compose logs --since 5m etl-worker | tail -20
   ```

3. **Deploy:** `git push` (deploys main), or on the server:

   ```bash
   docker compose up -d --build
   ```

## 3. Checks right after the deploy

```bash
# Limits applied: etl-api shows "/ 10GiB"
docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}"

# Nothing was OOM-killed, nothing is restarting
docker inspect --format '{{.Name}} OOMKilled={{.State.OOMKilled}} restarts={{.RestartCount}}' $(docker compose ps -q)

# Schedules registered and both queues consumed
docker compose logs backend    | grep "Registered 30-minute refresh schedule"
docker compose logs etl-worker | grep "queues etl and etl-long"

# Redis settings
docker compose exec redis redis-cli config get maxmemory          # 201326592
docker compose exec redis redis-cli config get maxmemory-policy   # noeviction

# Node heap caps
docker compose exec backend    sh -c 'echo $NODE_OPTIONS'   # --max-old-space-size=512
docker compose exec etl-worker sh -c 'echo $NODE_OPTIONS'   # --max-old-space-size=256
```

In the dashboard: the ETL Control Center shows **no red banner**, and the next 30-minute refresh completes.

## 4. After the next 02:00 refresh: find the real peak

Start the 70-minute logger before 02:00 (for example at 01:55):

```bash
nohup timeout 70m sh -c 'while true; do date; free -m | sed -n 2p; docker stats --no-stream --format "{{.Name}} {{.MemUsage}}"; sleep 30; done' > ~/mem-0200.log 2>&1 &
```

Then read the per-job peaks the ETL logged itself (one line per job: `Job <name> peak memory: <n> MB`):

```bash
# Per-run log files inside the etl-api container (kept until the container is recreated)
docker compose exec etl-api sh -c 'grep -H "peak memory" /repo/data/etl/logs/platform_*.log' | tail -40
```

The same line is the last line of each run's log in the ETL Control Center.

How to read it:

- The container peak in `~/mem-0200.log` is the **sum** of the processes that ran at the same time. The `peak
  memory` lines show each job on its own.
- A job killed for memory logs no `peak memory` line. Look for `OOMKilled=true` or `dmesg -T | grep -i "killed process"`.
- If the highest container peak stays well below 10G for a week, lower the etl-api limit to about peak × 1.5 and
  the reservation to about the normal peak.
