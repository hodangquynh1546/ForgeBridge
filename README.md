# ForgeBridge

Dịch vụ trung gian giữa **SmartSpec** (đặc tả) và **WorkHub** (công việc). Có DB riêng (SQLite, `data/bridge.db`), không đụng DB của hai hệ thống kia.

```
SmartSpec ──(đẩy snapshot đặc tả)──► ForgeBridge ──(REST, token của user)──► WorkHub
SmartSpec ◄──(tiến độ issue)──────── ForgeBridge ◄──(webhook ký HMAC)──────── WorkHub
VS Code extension / MCP ──(token WorkHub whk_…)──► /ide/* ──► WorkHub
```

Repo này gồm dịch vụ Bridge (gốc) và extension VS Code (`vscode-extension/`: `node --test lib.test.js`, chạy bằng *Run Extension* trong VS Code).

## Đồng bộ hai chiều (hiện tại)
- **WorkHub → SmartSpec**: mọi thay đổi ở một dự án có issue liên kết được ghi vào *outbox bền* của WorkHub (gộp nhiều thay đổi thành một thông báo, gửi lại có backoff) → Bridge **đọc trạng thái thật** của dự án (không tin payload) → SmartSpec lưu lên từng use case: trạng thái, người được giao, sprint, hạn, điểm, bị chặn, ngày xong, task bị xoá. Thêm **đối soát định kỳ** (`RECONCILE_SECONDS`, mặc định 300) để tự chữa lệch khi mất webhook/restart.
- **SmartSpec → WorkHub**: đặc tả (tên, mô tả, tiêu chí) đẩy tự động; đổi trạng thái ở SmartSpec đi qua WorkHub (WorkHub vẫn là nơi sở hữu dữ liệu + lịch sử) rồi phản chiếu lại ngay. Thành viên dự án SmartSpec được mời/thêm vào dự án WorkHub (editor → Developer, viewer → Stakeholder) để giao việc được ngay; ai chưa có tài khoản WorkHub sẽ được tự thêm khi họ liên kết.
- **Giao việc / sprint / hạn chót chỉ làm ở WorkHub**, SmartSpec chỉ hiển thị. Task bị xoá ở WorkHub được đánh dấu ở SmartSpec và có nút "Tạo lại task" (không tự tạo lại).

## Thiết kế → Tài liệu WorkHub
Mỗi lần đồng bộ, SmartSpec gửi kèm các tài liệu sinh từ thiết kế (xem `docs/lifecycle.md`): **SRS**, từng **use case/activity/sequence diagram** (Mermaid), **thiết kế CSDL** (ERD + từ điển + DDL PostgreSQL), **kế hoạch & kết quả kiểm thử**. Bridge tạo thư mục `SmartSpec/…` trong tab Tài liệu, tạo/cập nhật theo hash (mỗi lần đổi là một phiên bản), gắn tài liệu vào task của use case liên quan, lưu trữ tài liệu của sơ đồ đã bị xoá. WorkHub vẽ sơ đồ Mermaid ngay trong tài liệu. Mọi thay đổi sơ đồ/CSDL/test case trong SmartSpec (mọi đường ghi, nhờ hook ở model) tự kích hoạt đồng bộ có debounce. IDE: `GET /ide/issues/:key/design`, MCP `forge_get_design`, lệnh *Forge: Xem thiết kế*.

## Tài khoản dùng chung
Bridge chuyển hai lời hỏi giữa hai hệ thống (không lưu mật khẩu): `POST /v1/identity/workhub/verify` và `/v1/identity/workhub/set-password` (SmartSpec → WorkHub), `POST /identity/smartspec/verify` và `/identity/smartspec/set-password` (WorkHub → SmartSpec, xác thực bằng `X-Integration-Key`). WorkHub cần `INTEGRATION_IDENTITY_URL=http://localhost:8090/identity/smartspec/verify`. Đăng ký ở một bên thì đăng nhập được ở bên kia (tài khoản được tạo khi đăng nhập lần đầu); đổi mật khẩu ở một bên được đẩy sang bên kia ngay, và dấu thời gian `password_changed_at` ngăn mật khẩu cũ sống lại. Kiểm thử: `scripts/e2e-accounts.cjs`.

## Vòng đời liên kết (khoá tài liệu, tạm dừng, thùng rác, huỷ liên kết)
`POST /v1/projects/:id/pause`, `/archive`, `/restore`, `DELETE /v1/users/:id` — chi tiết trong `docs/lifecycle.md`. Tài liệu do SmartSpec quản lý chỉ đọc ở WorkHub (khoá bằng `X-Integration-Key`; hai bên phải dùng **cùng** secret webhook).

## Test case → Bug, thành viên, Git
- **Test case thất bại → Bug** (`POST /v1/testcases/report`, SmartSpec gọi sau mỗi lần chạy): tạo Bug trong WorkHub (ưu tiên theo severity, nằm dưới Epic của module, có các bước/kỳ vọng/thực tế, trỏ về use case liên quan). Chạy lại vẫn lỗi → bình luận vào bug đó (không tạo trùng); bug đã DONE mà test lại lỗi → **mở lại** về TO_DO; test đạt → ghi chú để người xác nhận đóng bug. Có thể đổi trạng thái bug ngay trên test case (`POST /v1/projects/:id/testcases/:key/status`, đi qua WorkHub). Trạng thái bug hiện ngay trên test case (badge) và trên thẻ task của use case.
- **Thành viên**: chỉ những người Bridge đã mời mới bị gỡ/đổi vai trò khi họ rời hoặc đổi vai trò ở SmartSpec; người được thêm tay trong WorkHub không bị đụng tới.
- **GitHub** (`POST /webhooks/github`, event *Pull requests*, `GITHUB_WEBHOOK_SECRET` bắt buộc): branch/tiêu đề/mô tả PR chứa mã task (`SHOP-12`) → mở PR: **Review**; merge: **Kiểm thử** (hoặc DONE nếu `GIT_MERGED_STATUS=DONE`); PR nháp bị bỏ qua; task đã DONE không bị kéo lùi. Chỉ tác động tới task sinh từ SmartSpec.

## Quy tắc đồng bộ
| Dữ liệu | Chủ sở hữu | Chiều |
|---|---|---|
| Tên, mô tả, luồng, quy tắc, tiêu chí chấp nhận | SmartSpec | → WorkHub |
| Trạng thái, người làm, sprint, điểm, bị chặn | WorkHub | → SmartSpec (hiện cạnh use case) |

- Module (`context.module`) → **Epic**; use case → **User Story** (`externalRef = smartspec:usecase/<project>/<lineage>`).
- Use case được nhận diện bằng `lineage_id` (không đổi qua các version; SmartSpec clone use case sang `_id` mới mỗi version).
- Spec đổi → cập nhật mô tả + tiêu chí chấp nhận và bình luận cảnh báo (không đụng status/người làm). Use case bị xoá khỏi spec → chỉ gắn cờ + bình luận một lần, không xoá issue.
- Lần đầu: tự tạo Workspace (`SmartSpec · <tên>`, một lần cho mỗi người) → Team (tên dự án) → Project (SCRUM) → Epic/Story.

## Chạy
```sh
cp .env.example .env   # đặt BRIDGE_SECRET, WORKHUB_WEBHOOK_SECRET
npm install
npm start              # :8090   (Node ≥ 22.13, dùng node:sqlite)
npm test && npm run typecheck
node scripts/e2e-full.cjs && node scripts/e2e-bugs.cjs && node scripts/e2e-design.cjs && node scripts/e2e-lifecycle.cjs && node scripts/e2e-accounts.cjs # kiểm tra toàn bộ luồng, cần cả 4 dịch vụ đang chạy (xem bên dưới)
npm run mcp            # MCP server (stdio) cho Claude Code / Copilot
```

**Cách nhanh:** `scripts/dev-all.sh start` (bật Mongo/Redis/Postgres bằng Docker + 5 dịch vụ; `stop`, `status`, `logs <tên>`). Dữ liệu nằm trong volume Docker và `ForgeBridge/data` nên còn sau khi tắt. Đổi secret mặc định bằng biến môi trường trước khi chạy ở môi trường thật.

Thứ tự bật thủ công (local):
1. `SmartSpec`: `docker compose up -d`, backend `npm run dev` (:8000), frontend `npm run dev` (:**5174**).
2. `WorkHub`: `INTEGRATION_WEBHOOK_URL=http://localhost:8090/webhooks/workhub INTEGRATION_WEBHOOK_SECRET=<cùng WORKHUB_WEBHOOK_SECRET> ./mvnw spring-boot:run` (:8080), frontend (:5173).
3. `ForgeBridge`: `npm start` (:8090). `BRIDGE_SECRET` phải trùng `BRIDGE_SECRET` của SmartSpec backend.

## API
- `/v1/*` (header `X-Bridge-Key`, chỉ backend SmartSpec gọi): `GET/POST /v1/users/:id[/link]`, `POST /v1/sync`, `GET /v1/projects/:id`.
- `POST /webhooks/workhub` (chữ ký `X-WorkHub-Signature`).
- `/ide/*` (Bearer token tích hợp WorkHub): `GET /ide/tasks`, `GET /ide/issues/:key` (kèm đặc tả gốc), `PUT /ide/issues/:key/status`, `POST /ide/issues/:key/comments`.

## MCP (Claude Code)
```json
{ "mcpServers": { "forge": { "command": "npx", "args": ["tsx", "src/mcp.ts"], "cwd": "<đường dẫn>/ForgeBridge",
  "env": { "FORGE_BRIDGE_URL": "http://localhost:8090", "FORGE_TOKEN": "whk_…" } } } }
```
Tools: `forge_my_tasks`, `forge_get_task` (task + đặc tả), `forge_set_status`, `forge_comment`. Token lấy bằng `POST /api/integrations/connect` của WorkHub hoặc đăng nhập trong extension.

## Giới hạn hiện tại
- Chưa nhận sự kiện push/commit của Git (chỉ pull request), chưa hỗ trợ GitLab.
- Người được mời bằng email SmartSpec mà đăng ký WorkHub bằng email khác sẽ được mời lại theo email WorkHub sau khi họ liên kết.
- Spec đổi trong lúc task đã bị xoá ở WorkHub thì không tự tạo lại (chỉ tạo lại khi bấm nút).
- Giao diện SmartSpec chỉ có light theme.
