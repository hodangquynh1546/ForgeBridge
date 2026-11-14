# Dùng Claude với SmartSpec (MCP)

Claude (Claude Code, Claude Desktop, mọi client MCP) đọc và ghi đặc tả trực tiếp vào SmartSpec: use case, sơ đồ use case/tuần tự/hoạt động, CSDL, test case. SmartSpec **không cần khoá API LLM** cho luồng này — Claude chính là bộ phân tích. Mọi thay đổi vào **bản nháp**; chủ dự án duyệt trong SmartSpec, rồi đồng bộ sang WorkHub như bình thường.

## Yêu cầu
- SmartSpec và ForgeBridge đang chạy; máy chạy Claude truy cập được ForgeBridge (`/mcp/smartspec`). Dùng qua mạng thì đặt sau HTTPS.
- Mỗi người có **token cá nhân** riêng (`ssp_…`): SmartSpec → menu tài khoản → **Kết nối Claude** → Tạo token. Token chỉ hiện một lần, lưu dạng băm, thu hồi bất cứ lúc nào, và chỉ có quyền của chủ token trong các dự án của họ (không có quyền quản trị, không tạo thêm token).
- Biến môi trường: ForgeBridge `SMARTSPEC_API_URL`; frontend `VITE_BRIDGE_URL` (địa chỉ ForgeBridge người dùng thấy).

## Cài đặt
HTTP từ xa (khuyến nghị):
```
claude mcp add --transport http smartspec <BRIDGE_URL>/mcp/smartspec --header "Authorization: Bearer ssp_xxx"
```
Stdio (không cần mở cổng): cấu hình
```json
{ "mcpServers": { "smartspec": { "command": "npx", "args": ["tsx", "<đường-dẫn>/ForgeBridge/src/smartspec-mcp-stdio.ts"],
  "env": { "SMARTSPEC_URL": "http://localhost:8000", "SMARTSPEC_TOKEN": "ssp_xxx" } } } }
```

## Công cụ
`smartspec_schema` (định dạng, gọi đầu tiên), `smartspec_list_projects`, `smartspec_get_project`, `smartspec_create_project`, `smartspec_get_spec`, `smartspec_add_usecases`, `smartspec_import_database`, `smartspec_import_usecase_diagram`, `smartspec_import_sequence_diagram`, `smartspec_import_activity_diagram`, `smartspec_add_testcases`, `smartspec_record_test_result`, `smartspec_approve_version` (chỉ chủ dự án, chỉ khi được yêu cầu rõ).

Quy tắc: gửi lại cùng `name` thì **thay thế** (an toàn khi thử lại); dữ liệu sai trả danh sách lỗi cụ thể để Claude tự sửa; bản đã chốt tự nhân bản thành bản nháp khi ghi.

## Riêng tư
Nội dung đặc tả đi từ máy Claude tới SmartSpec của bạn; ForgeBridge chỉ chuyển tiếp, không lưu token. Token nằm trong cấu hình MCP của máy người dùng — đừng commit.

## Kiểm thử
`node scripts/e2e-claude-mcp.cjs` (SmartSpec chạy với `MAIL_ENABLED=false AUTH_RATE_LIMIT=1000`, Bridge trên cổng 8095).
