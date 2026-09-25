# INKWAVE · 墨浪对战

从用户提供的 `inkwave-local.zip` 导入，保留原游戏、素材和中文界面。

- 首页全屏加载游戏，游戏资源位于 `public/game/`。
- 在线大厅默认使用 PeerJS Cloud 交换信令，游戏消息通过 WebRTC 在房主和玩家间传输；不依赖部署实例内存保存公网房间。
- 最多 8 人，空位由机器人补齐。支持武器、阵营、地图、时长、难度设置及下一局。
- 公共信令不提供 TURN 或 HTTP 中转。严格 NAT、网络隔离或信令服务不可用时可能无法连接；大厅会显示错误。
- 大厅提供原始局域网包下载，按包内《联机说明.md》执行 `node server.mjs`，同一网络玩家连接同一服务器，可自动回退 HTTP 中转。
- `app/api/rooms` 仅在本地开发服务器启用。公开部署不会把进程内房间当作共享持久服务。

## 验证

- `node tests/multiplayer-smoke.cjs`：真实公共信令和两客户端 WebRTC、设置同步、权限、离房检查，需要本机已有 3000 端口开发服务器。
- `node tests/game-smoke.cjs`：Chromium 软件渲染下加载游戏并截屏；软件 GPU 的首次着色器编译可能较慢。

PeerJS 浏览器发行文件来自 `peerjs@1.5.5`，位于 `public/game/vendor/peerjs.min.js`。原局域网游戏包可从 `/downloads/inkwave-local.zip` 下载。
