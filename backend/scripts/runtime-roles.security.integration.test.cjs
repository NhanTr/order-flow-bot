const assert = require("node:assert/strict");
const test = require("node:test");
const { Client } = require("pg");

const { bootstrapSecurity } = require("./security-bootstrap.cjs");

const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
const apiUrl = process.env.TEST_API_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
const enabled = Boolean(adminUrl && apiUrl && workerUrl);

function assertDisposableUrl(value) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(host), "test database must use loopback");
  assert.ok(url.port && url.port !== "5432", "test database must use a non-default disposable port");
  assert.match(url.pathname, /security_test/, "test database name must identify a security test database");
}

async function connected(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

async function denied(client, sql) {
  await assert.rejects(client.query(sql), /permission denied|must be owner|not permitted/i);
}

test("runtime database roles enforce API and worker boundaries", { skip: !enabled }, async () => {
  [adminUrl, apiUrl, workerUrl].forEach(assertDisposableUrl);
  const api = await connected(apiUrl);
  const worker = await connected(workerUrl);
  try {
    await api.query("SELECT password_hash FROM public.users LIMIT 0");
    await api.query("SELECT * FROM public.audit_logs LIMIT 0");
    await api.query("INSERT INTO public.audit_logs (actor_user_id, action, entity_type, details) VALUES (NULL, 'SECURITY_TEST', 'ORDER', '{}'::jsonb)");
    await denied(api, "DELETE FROM public.audit_logs WHERE false");
    await denied(api, "ALTER TABLE public.orders ADD COLUMN forbidden_test text");
    await denied(api, "CREATE ROLE forbidden_api_role");

    await worker.query("SELECT id, role FROM public.users LIMIT 0");
    await worker.query("SELECT * FROM public.notifications LIMIT 0");
    await worker.query("UPDATE public.notifications SET status = status WHERE false");
    await denied(worker, "SELECT password_hash FROM public.users LIMIT 0");
    await denied(worker, "DELETE FROM public.notifications WHERE false");
    await denied(worker, "ALTER TABLE public.notifications ADD COLUMN forbidden_test text");
    await denied(worker, "CREATE DATABASE forbidden_worker_database");
  } finally {
    await Promise.allSettled([api.end(), worker.end()]);
  }
});

test("worker role can dispatch, fail, requeue, and send notifications with limited grants", { skip: !enabled }, async () => {
  [adminUrl, workerUrl].forEach(assertDisposableUrl);
  const admin = await connected(adminUrl);
  const worker = await connected(workerUrl);
  const userId = "61000000-0000-4000-8000-000000000001";
  const notificationId = "62000000-0000-4000-8000-000000000001";
  try {
    await admin.query("DELETE FROM public.notifications WHERE id = $1", [notificationId]);
    await admin.query("DELETE FROM public.users WHERE id = $1", [userId]);
    await admin.query(
      "INSERT INTO public.users (id, full_name, telegram_user_id, telegram_chat_id, role) VALUES ($1, 'Limited worker barista', 991001, 991001, 'BARISTA')",
      [userId],
    );
    await admin.query(
      "INSERT INTO public.notifications (id, event, source_key, recipient_user_id, recipient_telegram_chat_id, message) VALUES ($1, 'ORDER_PAID', 'limited-worker-flow', $2, 991001, 'Prepare order')",
      [notificationId, userId],
    );

    const dispatch = await worker.query(
      "SELECT n.id, n.status, u.role FROM public.notifications n JOIN public.users u ON u.id = n.recipient_user_id WHERE n.id = $1",
      [notificationId],
    );
    assert.deepEqual(dispatch.rows, [{ id: notificationId, status: "PENDING", role: "BARISTA" }]);
    await worker.query("UPDATE public.notifications SET status = 'RETRYING', attempt_count = 1 WHERE id = $1", [notificationId]);
    await worker.query("UPDATE public.notifications SET status = 'FAILED', last_error = 'test failure' WHERE id = $1", [notificationId]);
    await worker.query("UPDATE public.notifications SET status = 'PENDING', last_error = NULL WHERE id = $1", [notificationId]);
    await worker.query("UPDATE public.notifications SET status = 'SENT', sent_at = now() WHERE id = $1", [notificationId]);
    const sent = await worker.query("SELECT status, attempt_count, last_error, sent_at IS NOT NULL AS sent FROM public.notifications WHERE id = $1", [notificationId]);
    assert.deepEqual(sent.rows, [{ status: "SENT", attempt_count: 1, last_error: null, sent: true }]);
    await denied(
      worker,
      "INSERT INTO public.notifications (event, source_key, recipient_user_id, recipient_telegram_chat_id, message) VALUES ('ORDER_READY', 'forbidden-worker-insert', '61000000-0000-4000-8000-000000000001', 991001, 'Forbidden')",
    );
  } finally {
    await admin.query("DELETE FROM public.notifications WHERE id = $1", [notificationId]).catch(() => undefined);
    await admin.query("DELETE FROM public.users WHERE id = $1", [userId]).catch(() => undefined);
    await Promise.allSettled([admin.end(), worker.end()]);
  }
});

test("security bootstrap is safe to rerun", { skip: !enabled }, async () => {
  await bootstrapSecurity({
    ADMIN_DATABASE_URL: adminUrl,
    API_DATABASE_PASSWORD: process.env.API_DATABASE_PASSWORD,
    WORKER_DATABASE_PASSWORD: process.env.WORKER_DATABASE_PASSWORD,
  });
  const admin = await connected(adminUrl);
  try {
    const result = await admin.query(
      "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname IN ('order_flow_api', 'order_flow_worker') ORDER BY rolname",
    );
    assert.deepEqual(result.rows, [
      { rolname: "order_flow_api", rolsuper: false, rolcreatedb: false, rolcreaterole: false },
      { rolname: "order_flow_worker", rolsuper: false, rolcreatedb: false, rolcreaterole: false },
    ]);
  } finally {
    await admin.end();
  }
});
