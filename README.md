# INKWAVE · 墨浪对战

5v5 涂墨对战，最多10人，每队5人，空位由机器人补齐。保留原游戏画面、武器、地图、规则和中文界面。

## 联机方式

- 浏览器直连入口：`/?mode=public&lobby=1`。加载原游戏后自动打开大厅；分享链接携带 `mode=public&room=...&lobby=1`，朋友不会误入 WSS。使用真实 PeerJS Cloud 信令与 WebRTC；信令超时会显示错误并允许手动重试，不保证所有 NAT 都能连接。
- WSS：`socket-server.app.teable.cn:8443/ws`，独立 `inkwave` 房间协议，邀请携带 `mode=wss&server=...&room=...&key=...&lobby=1`。显式 WSS 邀请不会静默降级。
- 未指定模式时，应用只查询固定默认服务器的 `/status`；`inkwaveProtocol:1` 才选择 WSS，否则选中浏览器直连并明确区分服务器待部署与状态未知。默认选择不是连接成功声明。服务器和口令字段只在 WSS 模式显示。
- WebRTC 使用独立无序、不重传位置通道，按角色只保留最新值；战斗事件可靠发送。
- 局域网：大厅选择局域网服务器；下载 `/downloads/inkwave-local.zip`，解压执行 `node server.mjs`，所有人访问同一台电脑。下载包也支持10人，直连失败可回退HTTP中转。

WSS 保留浏览器游戏模拟，房主计算机器人。服务器转发消息，客户端跳过旧的房主二次广播。开局将完整10角色名单随请求原子提交。位置按角色合并，涂墨每包最多256项、48KiB。断线明确退出，不声明完整墨迹恢复。服务器地址可在大厅修改。

对局左下角显示帧率、延迟、实际通道和拥堵提示。键盘1–4跳向四位队友，5返回基地。

## 验证与边界

- `node tests/ten-player-wss.cjs`：模拟WebSocket的10席位协议测试、原子开局、位置合并与转换、涂墨拆包、断线和旧服务器拒绝；真实本地API测试10人、拒绝第11人与满5人队伍。模拟协议不等于生产端到端验证。
- `node tests/multiplayer-smoke.cjs`：真实公共信令双客户端WebRTC、独立位置通道、拥堵合并、旧包拒绝与房间操作。
- `node tests/relay-smoke.cjs`：本地HTTP中转。
- `node tests/lobby-entry.cjs`：邀请模式优先级、能力状态、WSS字段显隐、URL清理，以及客人先完成加载和切地图后的涂墨绑定。
- `node tests/public-scene.cjs`：原游戏完整加载、真实公共信令与WebRTC双浏览器分享加入、10角色开局、就绪同步、角色位置与一次涂墨同步；软件GPU下手动步进模拟，不代表设备帧率评测。
- `node tests/game-smoke.cjs`：软件GPU加载游戏、局域网建房、10角色开局。

WSS 服务器部署由 PLAYROOM 应用单独处理。此网页发布不代表服务器已部署或10台真实设备性能验收通过。游戏模拟与GPU负载仍取决于玩家设备，尤其是机器人所在房主。
