#!/bin/bash
# Chuyển đến thư mục chứa file script này
cd "$(dirname "$0")"

echo "🚀 Đang khởi động Antigravity Hub v2.0..."

# Tắt các tiến trình cũ đang chiếm cổng hoặc ứng dụng Menu Bar cũ
lsof -t -i :3000,3001 | xargs kill -9 2>/dev/null || true
pkill -f antigravity-menu-bar 2>/dev/null || true

# Khởi động ứng dụng Menu Bar chạy ẩn
./antigravity-menu-bar &

# Khởi động máy chủ Node.js (Web Server + WebSocket) chạy ẩn
npm start > server.log 2>&1 &

# Chờ 2 giây để máy chủ khởi động hoàn tất
sleep 2

# Tự động mở trình duyệt truy cập giao diện điều khiển bảo mật
open https://localhost:3001

echo "===================================================="
echo "✅ Khởi động thành công!"
echo "- 🖥️  Menu Bar đang chạy trên thanh trạng thái."
echo "- 🌐 Dashboard đang mở trên trình duyệt (https://localhost:3001)."
echo "- 📝 Xem log máy chủ tại: server.log"
echo "===================================================="
