-- Runtime least-privilege roles. Passwords are assigned by security-bootstrap.cjs
-- and must never be stored in this file.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'order_flow_api') THEN
    CREATE ROLE order_flow_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'order_flow_worker') THEN
    CREATE ROLE order_flow_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

ALTER ROLE order_flow_api NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE order_flow_worker NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM order_flow_api, order_flow_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM order_flow_api, order_flow_worker;

GRANT USAGE ON SCHEMA public TO order_flow_api, order_flow_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO order_flow_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO order_flow_api;

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.audit_logs FROM order_flow_api;
GRANT SELECT, INSERT ON TABLE public.audit_logs TO order_flow_api;

GRANT SELECT, UPDATE ON TABLE public.notifications TO order_flow_worker;
GRANT SELECT (id, role) ON TABLE public.users TO order_flow_worker;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO order_flow_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO order_flow_api;

DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO order_flow_api, order_flow_worker', current_database());
END
$$;
