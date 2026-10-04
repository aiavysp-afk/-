#!/usr/bin/env bash
# Retire only the verified old mtsc.top applications after explicit owner authorization.
set -euo pipefail
umask 077
[[ $EUID == 0 && ${CONFIRM_RETIRE_LEGACY_MALL:-} == mtsc.top ]] || { echo 'Explicit mtsc.top retirement authorization required'; exit 1; }
script_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
archive_root=/var/backups/zhongyuan-daojia-legacy-retirement
run_id=${RETIREMENT_RUN_ID:?Pass a unique audit run id}
[[ $run_id =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || exit 1
backup="$archive_root/$run_id"
old_release=/opt/jingxiang-platform/releases/20261003-14
[[ $(readlink -f /opt/jingxiang-platform/current) == "$old_release" ]] || { echo 'Legacy active release changed'; exit 1; }
[[ $(realpath -e /www/wwwroot/mtsc.top/current) == /www/wwwroot/mtsc.top/current ]] || exit 1
[[ -f "$old_release/.env.production" && -f /www/wwwroot/mtsc.top/shared/.env.production ]] || exit 1
[[ ! -e "$backup" ]] || { echo 'Audit run already exists; inspect before retrying'; exit 1; }
for target in /opt/jingxiang-platform/releases /opt/jingxiang-platform/staging /www/wwwroot/mtsc.top/backups /www/wwwroot/mtsc.top/releases /www/wwwroot/mtsc.top/current /var/lib/jingxiang/uploads /www/wwwroot/mtsc.top/shared/uploads; do
  [[ -d "$target" && ! -L "$target" && $(realpath -e "$target") == "$target" ]] || { echo "Unexpected target: $target"; exit 1; }
done
[[ $(systemctl show jingxiang-api.service -p WorkingDirectory --value) == /opt/jingxiang-platform/current ]] || exit 1
node_bin=/opt/zhongyuan-daojia-acceptance/runtime/node-v24.19.0-linux-x64/bin/node
runuser -u admin -- env PM2_HOME=/home/admin/.pm2 pm2 jlist | "$node_bin" --input-type=module -e "let t='';for await(const c of process.stdin)t+=c;const p=JSON.parse(t).filter(x=>x.name==='mtsc-campus-api');if(p.length!==1||p[0].pm2_env.pm_cwd!=='/www/wwwroot/mtsc.top/current')process.exit(1);"
[[ $(runuser -u postgres -- psql -X -At -d postgres -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='jingxiang';") == jingxiang ]] || exit 1
[[ $(mysql --protocol=socket -uroot -N -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='mtsc_campus' AND TABLE_TYPE='BASE TABLE';") == 33 ]] || exit 1
[[ -f "$script_root/infra/maintenance/index.html" && -f "$script_root/infra/maintenance/mtsc.top.conf" ]] || exit 1
mkdir -p "$archive_root"
chmod 0700 "$archive_root"
mkdir -m 0700 "$backup"
cp -L /etc/nginx/sites-enabled/mtsc.top "$backup/nginx-mtsc.top.before"
cp -L /etc/nginx/sites-enabled/jingxiang-platform "$backup/nginx-subdomains.before"
cp "$old_release/.env.production" "$backup/jingxiang.env"
cp /www/wwwroot/mtsc.top/shared/.env.production "$backup/campus.env"
cp "$old_release/.env.production" /opt/jingxiang-platform/shared/legacy-api.env
chmod 0600 /opt/jingxiang-platform/shared/legacy-api.env
tar -czf "$backup/jingxiang-current-source.tgz" --exclude=node_modules --exclude=.next --exclude=.git --exclude=dist --exclude=uploads --exclude=.env.production -C "$old_release" .
tar -czf "$backup/campus-current-source.tgz" --exclude=node_modules --exclude=.git --exclude=dist --exclude=uploads --exclude=.env.production -C /www/wwwroot/mtsc.top/current .
tar -tzf "$backup/jingxiang-current-source.tgz" >/dev/null
tar -tzf "$backup/campus-current-source.tgz" >/dev/null
install -d -m 0755 /var/www/zhongyuan-daojia-maintenance
install -m 0644 "$script_root/infra/maintenance/index.html" /var/www/zhongyuan-daojia-maintenance/index.html
install -m 0644 "$script_root/infra/maintenance/mtsc.top.conf" "$(readlink -f /etc/nginx/sites-enabled/mtsc.top)"
install -m 0644 "$script_root/infra/maintenance/legacy-subdomains.conf" "$(readlink -f /etc/nginx/sites-enabled/jingxiang-platform)"
if ! nginx -t; then
  cp "$backup/nginx-mtsc.top.before" "$(readlink -f /etc/nginx/sites-enabled/mtsc.top)"
  cp "$backup/nginx-subdomains.before" "$(readlink -f /etc/nginx/sites-enabled/jingxiang-platform)"
  exit 1
fi
systemctl reload nginx
for attempt in {1..10}; do
  [[ $(curl --silent --output /dev/null --write-out '%{http_code}' https://mtsc.top/) == 503 ]] && break
  sleep 1
done
[[ $(curl --silent --output /dev/null --write-out '%{http_code}' https://mtsc.top/) == 503 ]] || exit 1
systemctl disable --now jingxiang-api.service jingxiang-admin.service jingxiang-backup.timer
runuser -u admin -- env PM2_HOME=/home/admin/.pm2 pm2 delete mtsc-campus-api
runuser -u admin -- env PM2_HOME=/home/admin/.pm2 pm2 save --force
for port in 3000 3001 8787; do
  if ss -lntH | awk '{print $4}' | grep -Eq ":${port}$"; then echo "Old port still active: $port"; exit 1; fi
done
runuser -u postgres -- pg_dump -Fc -d jingxiang > "$backup/jingxiang.dump"
pg_restore --list "$backup/jingxiang.dump" >/dev/null
mysqldump --protocol=socket -uroot --single-transaction --no-tablespaces mtsc_campus | gzip -c > "$backup/mtsc_campus.sql.gz"
gzip -t "$backup/mtsc_campus.sql.gz"
for db in zy_prd_test_20261003_{01..12}; do
  [[ $(runuser -u postgres -- psql -X -At -d "$db" -c "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('UserRole','StaffProfile','Order','ServiceCategory');") == 4 ]] || exit 1
  [[ $(runuser -u postgres -- psql -X -At -d postgres -c "SELECT count(*) FROM pg_stat_activity WHERE datname='$db';") == 0 ]] || exit 1
  runuser -u postgres -- pg_dump -Fc -d "$db" > "$backup/$db.dump"
  pg_restore --list "$backup/$db.dump" >/dev/null
done
tar -czf "$backup/uploads.tgz" -C / var/lib/jingxiang/uploads www/wwwroot/mtsc.top/shared/uploads www/wwwroot/mtsc.top/current/uploads
tar -tzf "$backup/uploads.tgz" >/dev/null
runuser -u postgres -- psql -X -At -v ON_ERROR_STOP=1 -d jingxiang > "$backup/postgres-before-counts.txt" <<'SQL'
SELECT format('SELECT %L,count(*) FROM %I.%I;',tablename,schemaname,tablename) FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY tablename \gexec
SQL
mysql --protocol=socket -uroot -N -e "SELECT CONCAT('SELECT ',QUOTE(TABLE_NAME),',COUNT(*) FROM \`mtsc_campus\`.\`',TABLE_NAME,'\`;') FROM information_schema.TABLES WHERE TABLE_SCHEMA='mtsc_campus' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME;" > "$backup/mysql-counts.sql"
mysql --protocol=socket -uroot -N < "$backup/mysql-counts.sql" > "$backup/mysql-before-counts.txt"
[[ $(wc -l < "$backup/postgres-before-counts.txt") == 52 ]] || exit 1
[[ $(wc -l < "$backup/mysql-before-counts.txt") == 33 ]] || exit 1
pg_restore_db=zydj_legacy_retirement_restore_20261004
mysql_restore_db=mtsc_legacy_retirement_restore_20261004
[[ -z $(runuser -u postgres -- psql -X -At -d postgres -c "SELECT datname FROM pg_database WHERE datname='$pg_restore_db';") ]] || exit 1
[[ $(mysql --protocol=socket -uroot -N -e "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='$mysql_restore_db';") == 0 ]] || exit 1
runuser -u postgres -- createdb "$pg_restore_db"
runuser -u postgres -- pg_restore --exit-on-error --no-owner -d "$pg_restore_db" < "$backup/jingxiang.dump"
runuser -u postgres -- psql -X -At -v ON_ERROR_STOP=1 -d "$pg_restore_db" > "$backup/postgres-restored-counts.txt" <<'SQL'
SELECT format('SELECT %L,count(*) FROM %I.%I;',tablename,schemaname,tablename) FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY tablename \gexec
SQL
cmp "$backup/postgres-before-counts.txt" "$backup/postgres-restored-counts.txt"
mysql --protocol=socket -uroot -e "CREATE DATABASE \`$mysql_restore_db\` CHARACTER SET utf8mb4;"
gzip -dc "$backup/mtsc_campus.sql.gz" | mysql --protocol=socket -uroot "$mysql_restore_db"
mysql --protocol=socket -uroot -N -e "SELECT CONCAT('SELECT ',QUOTE(TABLE_NAME),',COUNT(*) FROM \`$mysql_restore_db\`.\`',TABLE_NAME,'\`;') FROM information_schema.TABLES WHERE TABLE_SCHEMA='$mysql_restore_db' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME;" > "$backup/mysql-restored-counts.sql"
mysql --protocol=socket -uroot -N < "$backup/mysql-restored-counts.sql" > "$backup/mysql-restored-counts.txt"
cmp "$backup/mysql-before-counts.txt" "$backup/mysql-restored-counts.txt"
runuser -u postgres -- dropdb "$pg_restore_db"
mysql --protocol=socket -uroot -e "DROP DATABASE \`$mysql_restore_db\`;"
echo 'Both old database backups restored and row counts verified before deletion'
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d jingxiang <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '10s';
SELECT 'TRUNCATE TABLE ' || string_agg(format('%I.%I',schemaname,tablename),', ') || ' RESTART IDENTITY;' FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' \gexec
COMMIT;
SQL
{
  printf 'SET FOREIGN_KEY_CHECKS=0;\nSTART TRANSACTION;\n'
  mysql --protocol=socket -uroot -N -e "SELECT CONCAT('DELETE FROM \`mtsc_campus\`.\`',TABLE_NAME,'\`;') FROM information_schema.TABLES WHERE TABLE_SCHEMA='mtsc_campus' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME;"
  printf 'COMMIT;\nSET FOREIGN_KEY_CHECKS=1;\n'
} > "$backup/mysql-delete.sql"
mysql --protocol=socket -uroot < "$backup/mysql-delete.sql"
"$node_bin" --input-type=module - "$backup/jingxiang.env" <<'NODE'
import {readFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';
const t=readFileSync(process.argv[2],'utf8');const m=/^REDIS_URL\s*=\s*(.*)$/m.exec(t);if(!m)throw Error('Redis scope missing');
const u=new URL(m[1].trim().replace(/^['"]|['"]$/g,''));if(u.hostname!=='127.0.0.1'||u.port!=='6379'||!['','/0'].includes(u.pathname))throw Error('Unexpected Redis scope');
const env={...process.env,REDISCLI_AUTH:decodeURIComponent(u.password)};
const args=['-h',u.hostname,'-p',u.port];
const keys=execFileSync('redis-cli',[...args,'--scan','--pattern','refresh:*'],{encoding:'utf8',env}).trim().split('\n').filter(Boolean);
if(keys.some(k=>!/^refresh:[a-f0-9]{64}$/.test(k)))throw Error('Unexpected legacy refresh key');
if(keys.length)execFileSync('redis-cli',[...args,'DEL',...keys],{env,stdio:'ignore'});
console.log(JSON.stringify({legacyRefreshSessionsDeleted:keys.length}));
NODE
runuser -u postgres -- psql -X -At -v ON_ERROR_STOP=1 -d jingxiang > "$backup/postgres-after-counts.txt" <<'SQL'
SELECT format('SELECT %L,count(*) FROM %I.%I;',tablename,schemaname,tablename) FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY tablename \gexec
SQL
mysql --protocol=socket -uroot -N < "$backup/mysql-counts.sql" > "$backup/mysql-after-counts.txt"
awk -F '|' '$2!=0 {bad=1} END {exit bad}' "$backup/postgres-after-counts.txt"
awk '$2!=0 {bad=1} END {exit bad}' "$backup/mysql-after-counts.txt"
for db in zy_prd_test_20261003_{01..12}; do runuser -u postgres -- dropdb "$db"; done
for target in /var/lib/jingxiang/uploads /www/wwwroot/mtsc.top/shared/uploads; do
  [[ ! -L "$target" && $(realpath -e "$target") == "$target" ]] || exit 1
  find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
done
for target in /opt/jingxiang-platform/releases /opt/jingxiang-platform/staging /www/wwwroot/mtsc.top/backups /www/wwwroot/mtsc.top/releases; do
  [[ ! -L "$target" && $(realpath -e "$target") == "$target" ]] || exit 1
  find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
done
[[ -L /opt/jingxiang-platform/current ]] && unlink /opt/jingxiang-platform/current
[[ $(realpath -e /www/wwwroot/mtsc.top/current) == /www/wwwroot/mtsc.top/current ]] || exit 1
rm -rf -- /www/wwwroot/mtsc.top/current
# Preserve Certbot's existing webroot path for automatic renewal.
install -d -m 0755 /www/wwwroot/mtsc.top/current/dist
[[ -f /opt/jingxiang-platform/source-final.tar.gz ]] && rm -- /opt/jingxiang-platform/source-final.tar.gz
chmod -R go-rwx "$backup"
find "$backup" -maxdepth 1 -type f ! -name SHA256SUMS -exec sha256sum {} + > "$backup/SHA256SUMS"
nginx -t
[[ $(curl --silent --output /dev/null --write-out '%{http_code}' https://mtsc.top/) == 503 ]] || exit 1
[[ $(curl --fail --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3210/v1/health) == 200 ]] || exit 1
for unit in api admin h5; do systemctl is-active --quiet "zhongyuan-daojia-acceptance-$unit.service"; done
echo "Retired old mtsc.top data; protected recovery archive: $backup"
echo 'PostgreSQL 52 business tables empty; MySQL 33 tables empty; old refresh sessions and uploads removed.'
df -Pk /opt
