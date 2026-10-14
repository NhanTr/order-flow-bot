# Cài đặt và chạy Order Flow

Tài liệu này dành cho người clone repository từ GitHub và muốn chạy ứng dụng
trên máy cá nhân. PostgreSQL và Redis chạy bằng Docker; API, Admin Web,
Telegram Bot và notification worker chạy từ source code.

## 1. Yêu cầu

Cài sẵn:

- Git
- Node.js 22 và npm
- Docker Desktop hoặc Docker Engine có Docker Compose
- Bruno nếu muốn kiểm thử API bằng collection có sẵn
- Telegram Bot token từ BotFather nếu muốn chạy Bot hoặc notification worker

Kiểm tra công cụ:

```bash
git --version
node --version
npm --version
docker --version
docker compose version
```

Các lệnh nhiều dòng có dấu `\` dùng cho macOS, Linux hoặc Git Bash. Nếu dùng
PowerShell, sử dụng các lệnh một dòng được ghi riêng bên dưới.

## 2. Clone và cài dependency

```bash
git clone https://github.com/NhanTr/order-flow-bot.git
cd order-flow-bot

npm ci
npm --prefix backend ci
npm --prefix backend/apps/api ci
npm --prefix frontend ci
```

Repository không dùng npm workspace. Bốn lệnh `npm ci` cài dependency cho root
runner, backend/Telegram Bot, API và frontend.

## 3. Chạy PostgreSQL và Redis bằng Docker

Tạo file `.env.db.local` tại thư mục gốc:

```dotenv
POSTGRES_DB=order_flow
POSTGRES_USER=order_flow
POSTGRES_PASSWORD=thay_bang_mat_khau_database_url_safe
```

Không commit file này. Mật khẩu nên dài và chỉ dùng ký tự URL-safe vì nó sẽ
được đặt trong PostgreSQL connection URL.

Build PostgreSQL image của dự án. Image này tự nạp baseline schema khi volume
được tạo lần đầu:

```bash
docker build -f backend/Dockerfile.postgres -t order-flow-postgres:dev backend
```

Tạo PostgreSQL container:

```bash
docker run -d \
  --name order-flow-dev-db \
  --env-file .env.db.local \
  -p 127.0.0.1:55432:5432 \
  -v order_flow_dev_data:/var/lib/postgresql/data \
  order-flow-postgres:dev
```

PowerShell:

```powershell
docker run -d --name order-flow-dev-db --env-file .env.db.local -p 127.0.0.1:55432:5432 -v order_flow_dev_data:/var/lib/postgresql/data order-flow-postgres:dev
```

Tạo Redis container:

```bash
docker run -d \
  --name order-flow-dev-redis \
  -p 127.0.0.1:6379:6379 \
  -v order_flow_dev_redis:/data \
  redis:7-alpine \
  redis-server --appendonly yes
```

PowerShell:

```powershell
docker run -d --name order-flow-dev-redis -p 127.0.0.1:6379:6379 -v order_flow_dev_redis:/data redis:7-alpine redis-server --appendonly yes
```

Kiểm tra hai dịch vụ:

```bash
docker exec order-flow-dev-db pg_isready -U order_flow -d order_flow
docker exec order-flow-dev-redis redis-cli ping
```

PostgreSQL phải báo `accepting connections`; Redis phải trả `PONG`.

Những lần chạy sau không cần build hoặc tạo lại container:

```bash
docker start order-flow-dev-db order-flow-dev-redis
```

Xem trạng thái và log:

```bash
docker ps --filter name=order-flow-dev
docker logs order-flow-dev-db
docker logs order-flow-dev-redis
```

## 4. Cấu hình API

Sao chép template:

```bash
cp .env.example .env.local
```

Trên PowerShell dùng:

```powershell
Copy-Item .env.example .env.local
```

Mở `.env.local` và thay các giá trị tối thiểu sau. Phần mật khẩu trong hai URL
phải giống `POSTGRES_PASSWORD` của `.env.db.local`.

Có thể tạo các secret ngẫu nhiên bằng `openssl rand -hex 32`. Hãy dùng kết quả
khác nhau cho JWT access, JWT refresh và `BOT_INTERNAL_SECRET`.

```dotenv
DATABASE_URL="postgresql://order_flow:MAT_KHAU_DATABASE@localhost:55432/order_flow"
DIRECT_URL="postgresql://order_flow:MAT_KHAU_DATABASE@localhost:55432/order_flow"

JWT_ACCESS_SECRET="chuoi-ngau-nhien-rieng-thu-nhat-dai-it-nhat-32-ky-tu"
JWT_REFRESH_SECRET="chuoi-ngau-nhien-rieng-thu-hai-dai-it-nhat-32-ky-tu"
BOT_INTERNAL_SECRET="chuoi-bi-mat-dung-chung-giua-api-va-telegram-bot"

SEED_OWNER_FULL_NAME="Store Owner"
SEED_OWNER_USERNAME="owner"
SEED_OWNER_PASSWORD="mat-khau-owner-it-nhat-12-ky-tu"
SEED_PASSWORD_ROUNDS=12

SEED_OWNER_TELEGRAM_USER_ID=94004001
SEED_SERVICE_STAFF_TELEGRAM_USER_ID=94004002
SEED_BARISTA_TELEGRAM_USER_ID=94004003

HOST="0.0.0.0"
PORT=3001
```

Không commit `.env.local`. Hai loại mật khẩu có mục đích khác nhau:

- `POSTGRES_PASSWORD` bảo vệ PostgreSQL.
- `SEED_OWNER_PASSWORD` dùng để đăng nhập Admin Web và API bằng tài khoản OWNER.

SERVICE_STAFF và BARISTA không có mật khẩu; họ xác thực bằng Telegram user ID.
Khi chạy Bot thật, thay ba Telegram ID mẫu bằng ID thật và giữ chúng khác nhau.

## 5. Khởi tạo Prisma, tài khoản và menu

```bash
npm --prefix backend run db:generate
npm --prefix backend run seed:users
npm --prefix backend run seed:menu
```

`seed:users` tạo hoặc cập nhật đúng một tài khoản cho mỗi role trên database
trống:

| Role | Username mặc định | Cách xác thực |
| --- | --- | --- |
| OWNER | `owner` | `SEED_OWNER_PASSWORD` |
| SERVICE_STAFF | `service_staff` | Telegram user ID |
| BARISTA | `barista` | Telegram user ID |

Mật khẩu OWNER chỉ được lấy từ `.env.local`. Database lưu bcrypt hash và seed
không in mật khẩu hoặc hash ra log. Các lệnh seed có tính lặp lại; chúng không
tự xóa user cũ hoặc user không liên quan.

## 6. Chạy API và Admin Web

Mở hai terminal tại thư mục gốc.

Terminal 1 — API:

```bash
npm --prefix backend run dev:api
```

Terminal 2 — Admin Web:

```bash
npm --prefix frontend run dev
```

Truy cập:

- Admin Web: <http://localhost:3000>
- API health: <http://localhost:3001/health>
- API base URL: <http://localhost:3001/api/v1>

Đăng nhập Admin Web bằng `SEED_OWNER_USERNAME` và `SEED_OWNER_PASSWORD` trong
`.env.local`.

Kiểm tra nhanh API:

```bash
curl http://localhost:3001/health
```

Nếu thay `.env.local`, hãy dừng và chạy lại API.

## 7. Chạy Telegram Bot và notification worker (tùy chọn)

Tạo file cấu hình Bot:

```bash
cp backend/apps/telegram-bot/.env.example backend/apps/telegram-bot/.env
```

Trên PowerShell:

```powershell
Copy-Item backend/apps/telegram-bot/.env.example backend/apps/telegram-bot/.env
```

Điền các giá trị:

```dotenv
TELEGRAM_BOT_TOKEN=token-lay-tu-BotFather
API_BASE_URL=http://localhost:3001/api/v1
BOT_INTERNAL_SECRET=phai-giong-chinh-xac-gia-tri-trong-env-local
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgresql://order_flow:MAT_KHAU_DATABASE@localhost:55432/order_flow

TELEGRAM_WEBHOOK_DOMAIN=
TELEGRAM_WEBHOOK_PATH=/telegram/webhook
TELEGRAM_WEBHOOK_SECRET_TOKEN=
PORT=3002
```

Để phát triển local, để trống `TELEGRAM_WEBHOOK_DOMAIN`; Bot sẽ dùng long
polling. Chạy Bot và worker ở hai terminal khác:

```bash
npm --prefix backend run dev:bot
```

```bash
npm --prefix backend run dev:notification-worker
```

Sau khi đã cấu hình đầy đủ Bot, có thể chạy cả bốn tiến trình trong một
terminal:

```bash
npm run live
```

## 8. Kiểm thử API bằng Bruno

1. Mở Bruno và chọn **Open Collection**.
2. Chọn thư mục `backend/bruno`.
3. Chọn environment `Local`.
4. Nhập `password` trong phần Secret bằng `SEED_OWNER_PASSWORD`.
5. Chạy `00 Health → health`.
6. Chạy `01 Admin Auth → adminLogin`; collection tự giữ token trong runtime.

Xem [hướng dẫn Bruno](backend/bruno/README.md) để biết chi tiết. Không ghi
password trực tiếp vào request hoặc commit secret vào Git.

## 9. Kiểm tra code

```bash
npm --prefix backend run check:api
npm --prefix backend run test:api
npm --prefix backend run check:bot
npm --prefix backend run test:bot
npm --prefix frontend run lint
npm --prefix frontend run build
```

Hai test export biểu mẫu thuế cần các DOCX template tương ứng trong
`backend/docs`. Nếu các file template không có trong bản clone, hai test đó sẽ
báo `ENOENT`; phần còn lại của API vẫn có thể chạy.

## 10. Dừng dịch vụ

Dừng API/Web/Bot/worker bằng `Ctrl+C`. Dừng Docker nhưng giữ dữ liệu:

```bash
docker stop order-flow-dev-db order-flow-dev-redis
```

Xóa container nhưng vẫn giữ volume dữ liệu:

```bash
docker rm order-flow-dev-db order-flow-dev-redis
```

Không xóa các volume `order_flow_dev_data` hoặc `order_flow_dev_redis` nếu còn
cần dữ liệu. Khi tạo PostgreSQL container mới với volume cũ, schema và dữ liệu
được giữ nguyên.

## 11. Lỗi thường gặp

### `ECONNREFUSED`

API không kết nối được PostgreSQL. Kiểm tra container đang chạy và
`DATABASE_URL` dùng đúng cổng `55432`:

```bash
docker ps --filter name=order-flow-dev-db
docker exec order-flow-dev-db pg_isready -U order_flow -d order_flow
```

### PostgreSQL trả `28P01`

Username hoặc password trong `DATABASE_URL` không giống `.env.db.local`. Đồng
bộ `DATABASE_URL` và `DIRECT_URL`, sau đó khởi động lại API.

### Login trả `401`

Chạy lại seed sau khi đặt đúng `SEED_OWNER_PASSWORD`:

```bash
npm --prefix backend run seed:users
```

Sau đó đăng nhập bằng `SEED_OWNER_USERNAME`; mặc định là `owner`.

### Redis không kết nối được

```bash
docker exec order-flow-dev-redis redis-cli ping
```

Nếu container đã tồn tại nhưng đang dừng, chạy
`docker start order-flow-dev-redis`.

## Chạy toàn bộ bằng image đã phát hành

Máy triển khai chỉ cần Docker. Xem
[hướng dẫn triển khai container](DOCKER_DEPLOYMENT.md) để dùng root
`compose.yaml`, `.env.docker` và các image GHCR đã publish. Luồng đó phù hợp
cho người vận hành; các bước phía trên phù hợp cho phát triển từ source.
