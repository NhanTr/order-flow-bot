# BE004 Integration Fixtures

Run these fixtures when a backend developer or the Telegram Bot needs stable
accounts and menu data without manually preparing the database.

```bash
npm run seed:be004
```

Menu/orders use the `BE004` namespace. All user-producing demo seeds reuse
one shared account for each role. On an empty database this creates exactly
three users; rerunning any demo seed does not create additional accounts.
Existing unrelated or old seeded users are not deleted automatically.

## Users

Set `SEED_OWNER_PASSWORD` (at least 12 characters) in the repository `.env.local`
before running a user-producing seed. There is no fallback password. Only its
bcrypt hash is stored; neither password nor hash is included in seed output.

| Purpose | Username | Telegram user ID default | DB role | Status | Bot role |
| --- | --- | --- | --- | --- | --- |
| Admin manager | `SEED_OWNER_USERNAME` (default `owner`) | `94004001` | `OWNER` | `ACTIVE` | `MANAGER` |
| Service staff | `service_staff` | `94004002` | `SERVICE_STAFF` | `ACTIVE` | `SERVICE_STAFF` |
| Barista | `barista` | `94004003` | `BARISTA` | `ACTIVE` | `BARISTA` |

User UUIDs are generated on first creation and reused by identity. OWNER uses
password authentication; SERVICE_STAFF and BARISTA use Telegram and have no
password. Configure real Telegram IDs using `SEED_OWNER_TELEGRAM_USER_ID`,
`SEED_SERVICE_STAFF_TELEGRAM_USER_ID`, and `SEED_BARISTA_TELEGRAM_USER_ID`.
The three IDs must differ. The seed refuses identity conflicts and implicit
role changes, rolling back the user transaction on failure.

Run `npm run seed:users` to create only these three accounts. `db:seed` continues
to initialize only OWNER. For inactive-employee smoke tests, deactivate the
shared staff account via the admin API and reactivate it afterward; no fourth
fixture account is created. Database `OWNER` maps to Bot `MANAGER`.

## Menu

| Purpose | ID | Name | State | Price |
| --- | --- | --- | --- | --- |
| Active category | `00000000-0000-4000-8000-000000004101` | `BE004 Drinks` | `isActive=true` | n/a |
| Inactive category | `00000000-0000-4000-8000-000000004102` | `BE004 Hidden Drinks` | `isActive=false` | n/a |
| Active item | `00000000-0000-4000-8000-000000004201` | `BE004 Iced Latte` | `isAvailable=true` | `45000` |
| Inactive item | `00000000-0000-4000-8000-000000004202` | `BE004 Inactive Mocha` | `isAvailable=false` | `50000` |

Public menu endpoints must include `BE004 Drinks` and `BE004 Iced Latte`, and
must exclude `BE004 Hidden Drinks` and `BE004 Inactive Mocha`.

## Orders

| Purpose | ID | Order code | Payment status | Fulfillment status | Creator | Payment code |
| --- | --- | --- | --- | --- | --- | --- |
| Barista smoke-test queue order | `00000000-0000-4000-8000-000000004301` | `BE004-QUEUED-001` | `PAID` | `QUEUED` | `service_staff` | `PAY-BE004-QUEUED-001` |

The queued order has one `BE004 Iced Latte`, total `45000`, and is unassigned
so `barista` can see it in the queue before claiming.

## Required Headers

Bot and Telegram-owned operational routes require:

| Header | Value |
| --- | --- |
| `x-bot-internal-secret` | same value configured in API and Bot environment |
| `x-telegram-user-id` | one of the stable Telegram user IDs above |

`POST /api/v1/telegram/bot/session` uses `x-bot-internal-secret` and a JSON
body:

```json
{ "telegramUserId": 94004002 }
```

Expected smoke-test results:

| Fixture | Request | Expected result |
| --- | --- | --- |
| `94004002` | `/telegram/bot/session` | `200` with role `SERVICE_STAFF` |
| `94004001` | `/telegram/bot/session` | `200` with role `MANAGER` |
| deactivated shared staff | `/telegram/bot/session` | `403` with code `EMPLOYEE_INACTIVE` |
| `94004003` | `/barista/queue` | queue can include `BE004-QUEUED-001` |
