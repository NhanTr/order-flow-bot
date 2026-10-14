# Order Flow — Bruno collection

Mở **Bruno → Open Collection**, chọn thư mục `backend/bruno` (chứa `bruno.json`). Không cần import OpenAPI lại.

Collection gồm **73 request**: 48 operation từ `backend/docs/openapi.yaml`, health và 5 route bổ sung đang có trong source, cùng 19 request cho luồng Telegram nội bộ. Đây là bộ request kiểm thử thủ công, không phải bộ test đã chạy qua backend.

## Khởi động và đăng nhập

1. Chạy PostgreSQL Docker, cấu hình `.env.local` và seed OWNER theo hướng dẫn backend. Chạy API từ thư mục gốc: `npm --prefix backend run dev:api`.
2. Sao chép `environments/Local.bru` thành `environments/Private.bru` rồi chọn **Private** trong Bruno. File Private được Git bỏ qua. Local chỉ chứa placeholder, không chứa thông tin từ `.env.local`.
3. Đặt `baseUrl = http://localhost:3001`, `username` theo `SEED_OWNER_USERNAME`. Trong môi trường Bruno, nhập `password` ở phần **Secret** (bản cũ: checkbox Secret), trùng `SEED_OWNER_PASSWORD` đã seed; không nhập mật khẩu trực tiếp vào body request.
4. Chạy `00 Health → health`, sau đó `01 Admin Auth → adminLogin` và `getCurrentAdmin`.

Login tự lưu `accessToken`, `refreshToken`, `userId` vào biến runtime Bruno để các request Bearer dùng tiếp. Refresh cập nhật token; logout xóa token runtime. Khi mở lại Bruno hoặc API restart, đăng nhập lại. Script không ghi token vào file môi trường. `password`, `botInternalSecret` và `sepayWebhookApiKey` được khai báo dưới `vars:secret`: file chỉ giữ tên biến. Xem [Bruno Secret Variables](https://docs.usebruno.com/secrets-management/secret-variables).

## Tài khoản seed dùng chung

Sau khi cấu hình `.env.local`, chạy `npm --prefix backend run seed:users`. Trên database trống sẽ có một OWNER (`owner` hoặc username cấu hình), một SERVICE_STAFF (`service_staff`) và một BARISTA (`barista`); mọi seed demo dùng lại ba tài khoản này. Mật khẩu OWNER do bạn đặt (ít nhất 12 ký tự), không có mật khẩu mặc định. Staff/barista đăng nhập qua Telegram. Seed không tự xóa user cũ.

## Kiểm thử quản trị

- Dashboard, employees, menu, orders, finance và audit dùng Bearer token OWNER. Chọn từng request và nhấn Send.
- `createMenuCategory`, `createMenuItem`, `createEmployee`, `createOrder` tự lấy ID tương ứng sau khi thành công. `addOrderItem` lấy ID món trong đơn; QR lấy `paymentCode`.
- Để dùng dữ liệu có sẵn, chạy request danh sách rồi điền `categoryId`, `menuItemId`, `employeeId`, `orderId`, `orderItemId`, `baristaId`, `transactionId`, `reconciliationId` từ response vào môi trường. ID runtime do script tạo sẽ ưu tiên hơn ID môi trường; có thể chỉnh/xóa trong Runtime Variables.
- Query không bắt buộc được tắt sẵn trong tab Params; bật và nhập giá trị khi cần. `from` / `to` là ngày mẫu, cần đổi theo khoảng dữ liệu muốn xem. Export mặc định là XLSX.
- Body giữ đúng các trường API hiện tại, gồm `createdByUserId`, `confirmedByUserId`, `requestedByUserId`, `resolvedByUserId`, `refundedByUserId`. Các request claim/ready/deliver vẫn chịu điều kiện phân quyền và trạng thái đơn.

## Luồng Telegram không cần mở Telegram

Đặt `botInternalSecret` trùng `BOT_INTERNAL_SECRET` của API. Đặt `staffTelegramUserId` và `baristaTelegramUserId` theo các employee ACTIVE có đúng role SERVICE_STAFF / BARISTA trong database; giá trị 0 trong template phải được thay. Đây là Telegram user ID dạng số, không phải UUID employee.

1. `14 Telegram Staff`: categories → items (điền `categoryId`, chọn `menuItemId`) → createDraft → addItem → confirmCash hoặc createQr → detail.
2. `15 Telegram Barista`: queue → detail → claim → ready, dùng cùng `orderId`.
3. `14 Telegram Staff → deliver` để hoàn tất giao đơn.

Hai nhóm này tự gửi `x-bot-internal-secret` và `x-telegram-user-id`; không cần đăng nhập OWNER. Body draft/thanh toán khác với các request web. Khi API bật Bot router, public-menu/barista routes có thể bị router Telegram xử lý trước; dùng nhóm Telegram tương ứng nếu request web trả lỗi Bot credentials.

`12 Telegram Auth → createTelegramBotSession` dùng `telegramUserId` riêng để kiểm tra employee. `createTelegramSession` cần `telegramInitData` thật, còn hạn và được Telegram ký; chuỗi tùy ý sẽ bị từ chối.

## QR và SePay

`checkQrPayment` yêu cầu backend cấu hình token/API URL SePay đúng môi trường. Webhook mẫu dùng `Authorization: Apikey {{sepayWebhookApiKey}}`; điền khóa trùng cấu hình backend, `paymentCode` của đơn QR và `amount` bằng số tiền cần thử. Script tự đặt thời gian giao dịch hiện tại.

`sepayTransactionId` mặc định là ID giả cho kiểm thử local. Gửi lại cùng ID kiểm tra idempotency; đổi ID khi muốn mô phỏng giao dịch mới. Không dùng webhook giả với dữ liệu thật.

Chạy **từng request theo luồng**. Không dùng Run Collection cho cả bộ: collection có thao tác tạo, sửa, hủy, hoàn tiền và override trạng thái, với các nhánh CASH/QR khác nhau.
