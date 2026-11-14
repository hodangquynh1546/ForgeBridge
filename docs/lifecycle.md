# Vòng đời phần mềm: SmartSpec ↔ WorkHub ↔ VS Code

Nguyên tắc: **mỗi loại dữ liệu có đúng một chủ sở hữu**, bên kia chỉ phản chiếu.

| Giai đoạn | Làm ở đâu | Dữ liệu sinh ra | Sang WorkHub | Chiều | Ai sở hữu |
|---|---|---|---|---|---|
| 1. Thu thập đầu vào (audio, ảnh, DOCX, PDF, text) | SmartSpec | Input, bản trích xuất | — (nguyên liệu, không đồng bộ) | — | SmartSpec |
| 2. Phân tích yêu cầu (use case, module, luồng, quy tắc, tiêu chí) | SmartSpec | Use case theo version | **Epic** (module) + **User Story** (use case) + tiêu chí chấp nhận; tài liệu **SRS** | → | SmartSpec (nội dung) |
| 2b. Phân tích gia tăng, xung đột, version | SmartSpec | Version `processing/has_conflicts/completed` | Chỉ version **completed** mới đồng bộ; use case bị xoá khỏi spec → cờ + bình luận, không xoá task | → | SmartSpec |
| 3. Thiết kế UML (use case, activity, sequence) | SmartSpec | Sơ đồ dạng dữ liệu (node/edge) | Tài liệu Markdown + **Mermaid**, thư mục `SmartSpec/Sơ đồ/…`, gắn vào task của use case | → | SmartSpec |
| 3b. Thiết kế CSDL (ERD, từ điển, SQL) | SmartSpec | Bảng, cột, quan hệ | Tài liệu **Thiết kế CSDL**: erDiagram + từ điển dữ liệu + DDL PostgreSQL, gắn vào task | → | SmartSpec |
| 3c. Thiết kế UI/UX | *(SmartSpec chưa có chức năng này)* | — | Chưa hỗ trợ; có thể đính kèm wireframe vào tài liệu WorkHub thủ công | — | — |
| 4. Giao việc, sprint, ưu tiên, hạn | **WorkHub** | Người làm, sprint, điểm, hạn, bị chặn | — | ← (SmartSpec chỉ hiển thị) | WorkHub |
| 4b. Thành viên dự án | SmartSpec (mời/gỡ) | owner/editor/viewer | Project member (Developer/Stakeholder); chỉ người Bridge đã mời mới bị gỡ | → | SmartSpec |
| 5. Lập trình | **VS Code** (extension / MCP) | Branch, commit, PR | Trạng thái task (bắt đầu → Đang làm; PR mở → Review; merge → Kiểm thử) | ↔ | WorkHub |
| 6. Kiểm thử (sinh test case, chạy, báo cáo) | SmartSpec | Test case + kết quả | Tài liệu **Kế hoạch & kết quả kiểm thử**; thất bại → **Bug** (tạo/bình luận/mở lại) | → | SmartSpec (test), WorkHub (bug) |
| 6b. Xử lý bug | WorkHub *hoặc* test case ở SmartSpec | Trạng thái bug | Đổi trạng thái ở đâu cũng đi qua WorkHub rồi phản chiếu lại | ↔ | WorkHub |
| 7. Theo dõi tiến độ | SmartSpec (tab Tasks) + WorkHub (board/báo cáo) | % hoàn thành theo module, sprint | — | ← | WorkHub |
| 8. Quản trị (API key LLM, thống kê token, log, Copilot) | SmartSpec | — | Không đồng bộ (nội bộ SmartSpec) | — | SmartSpec |

## Quy tắc quan trọng
- **Khoá ổn định qua version**: SmartSpec clone use case/test case sang `_id` mới ở mỗi version, nên đồng bộ dùng `lineage_id`; sơ đồ/ERD dùng `loại:slug(tên)`. Đổi tên sơ đồ ⇒ coi là tài liệu mới, tài liệu cũ được **lưu trữ** (không xoá).
- **Không ghi đè tiến độ**: spec đổi chỉ cập nhật mô tả/tiêu chí và bình luận cảnh báo; trạng thái, người làm, sprint, hạn không bao giờ bị đụng.
- **Tài liệu thiết kế** chỉ cập nhật khi nội dung đổi (so sánh hash; DDL không có timestamp); mỗi lần là một phiên bản mới trong lịch sử tài liệu WorkHub.
- **Task bị xoá ở WorkHub** không tự tạo lại; SmartSpec hiện "Đã xoá" + nút *Tạo lại task*.
- **Quyền**: viewer của SmartSpec không đổi được trạng thái; hành động ghi nhận theo tài khoản WorkHub của người làm nếu họ đã liên kết, nếu không thì theo chủ dự án.
- **Độ bền**: WorkHub ghi outbox bền, Bridge đọc lại trạng thái thật, và quét đối soát mỗi 5 phút.

## Vòng đời của liên kết
- **Tài liệu do SmartSpec quản lý là chỉ đọc ở WorkHub.** Bridge gửi `X-Integration-Key` (cùng giá trị `INTEGRATION_WEBHOOK_SECRET`/`WORKHUB_WEBHOOK_SECRET`) và gắn `externalRef = smartspec:design/<dự án>/<khoá>`; WorkHub từ chối sửa/lưu trữ/xoá/soạn thảo cộng tác bởi người (403 `DOCUMENT_MANAGED`). Vẫn xem được lịch sử phiên bản và **đính kèm tệp** (ví dụ wireframe). Chưa đặt secret thì khoá tắt (dev).
- **Tạm dừng đồng bộ một dự án** (chỉ chủ dự án, menu ⋯ trên chip WorkHub): hai chiều dừng, không xoá gì ở WorkHub; tiếp tục thì áp dụng mọi thay đổi đang chờ.
- **Thùng rác SmartSpec**: dự án WorkHub chuyển **ARCHIVED** (chỉ đọc, nhớ trạng thái cũ); **khôi phục** thì trả lại trạng thái cũ rồi đồng bộ tiếp. Xoá hẳn ở SmartSpec không xoá gì ở WorkHub.
- **Huỷ liên kết tài khoản WorkHub** (menu ⋯): token tích hợp bị thu hồi ở WorkHub, task/tài liệu đã tạo giữ nguyên; dự án người đó từng sở hữu chờ người khác liên kết hoặc họ liên kết lại.

## Chưa bao phủ / cần quyết định
1. **UI/UX** — SmartSpec chưa có module thiết kế giao diện nên chưa có gì để đồng bộ (wireframe có thể đính kèm tay vào tài liệu WorkHub).
2. **Mermaid trong VS Code** — preview Markdown mặc định không vẽ Mermaid (cần extension); mở trong WorkHub để xem sơ đồ.
3. **PlantUML** — WorkHub chỉ vẽ Mermaid.
4. **Nội dung issue** (tiêu đề/mô tả của task sinh từ spec) vẫn sửa tay được ở WorkHub và sẽ bị ghi đè khi spec đổi (có banner cảnh báo); chưa khoá như tài liệu.
