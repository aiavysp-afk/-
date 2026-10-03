-- Run with a PostgreSQL administrator, not the existing business database account.
-- psql -X -v ON_ERROR_STOP=1 -d postgres -f infra/database-init.sql
\set ON_ERROR_STOP on
SELECT 'CREATE ROLE zydj_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zydj_app') \gexec
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zydj_app' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
    RAISE EXCEPTION 'Existing zydj_app role has elevated privileges; manual review required';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = 'zhongyuan_daojia' AND pg_get_userbyid(datdba) <> 'zydj_app') THEN
    RAISE EXCEPTION 'Existing database belongs to another account; refusing initialization';
  END IF;
END $$;
SELECT 'CREATE DATABASE zhongyuan_daojia OWNER zydj_app ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'zhongyuan_daojia') \gexec
\connect zhongyuan_daojia
-- Required by the reservation overlap exclusion constraint.
CREATE EXTENSION IF NOT EXISTS btree_gist;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO zydj_app;
-- Set a strong password separately using interactive \password zydj_app.
-- Tables, indexes, constraints and triggers come ONLY from prisma migrate deploy.
-- Never run this against a database owned by another application.
