// Chinese UI localization. English is the default language.
//
// The game's menu/HUD text is spread across thousands of lines of DOM code, so instead of editing every call site
// we watch DOM mutations and replace text nodes (plus placeholder/title/aria-label) that match the dictionary with
// Chinese. Switching back to English restores the original text.
// Fonts: the bundled fonts only cover Latin; CJK characters fall back to system Chinese fonts via unicode-range.

const ZH = {
  // ---- Main menu / common
  'PLAY': '开始游戏', 'Turf War · 5 v 5': '涂地对战 · 5 对 5', 'MULTIPLAYER': '联机对战', 'Online · up to 10 players': '在线联机 · 最多 10 人',
  'LOADOUT': '装备', 'SETTINGS': '设置', 'HOW TO PLAY': '玩法说明', 'CREDITS': '制作名单',
  'Jump into a 5 v 5 Turf War against bots': '与机器人进行 5 对 5 涂地对战',
  'Play with friends on the same network (needs node server.mjs)': '和同一网络的朋友一起玩（需运行 node server.mjs）',
  'Pick your weapon and name your squidkid': '选择武器、给角色起名',
  'Controls, video, audio and gameplay options': '操作、画面、声音和玩法选项',
  'The rules in 30 seconds, plus every control': '30 秒看懂规则和全部操作',
  'The squidkids and code behind INKWAVE': 'INKWAVE 的角色与制作',
  'PRESS ANY KEY': '按任意键开始', 'PRESS ANY BUTTON': '按任意键开始', 'OR CLICK TO START': '或点击开始',
  'Turf Riot': '涂地大乱斗', 'TURF WAR': '涂地对战', 'Turf War': '涂地对战',
  'BACK': '返回', 'Back': '返回', 'START!': '开始！', 'Start': '开始', 'READY': '准备就绪', 'SELECTED': '已选择',
  'CURRENT LOADOUT': '当前装备', 'YOUR WEAPON': '你的武器', 'SQUIDKID NAME': '角色名字', 'CHANGE': '更换',
  'Player': '玩家', 'You': '你', 'YOU': '你', 'NEXT RANK': '下一段位', 'LV': '等级',
  'Played': '场次', 'Wins': '胜场', 'PLAYED': '场次', 'WINS': '胜场',
  'Saved!': '已保存！', 'Changes save automatically': '修改会自动保存', 'Changes apply instantly': '修改立即生效',
  'RESET TO DEFAULTS': '恢复默认', 'Reset': '重置', 'Restore every setting to its original value.': '把所有设置恢复为初始值。',
  'PRESS AGAIN TO CONFIRM': '再按一次确认', 'ON': '开', 'OFF': '关', 'Default': '默认',
  // ---- Match setup
  'MAP': '地图', 'Map': '地图', 'MATCH': '对局', 'DIFFICULTY': '难度', 'Difficulty': '难度', 'BOTS': '机器人', 'Bots': '机器人',
  'LENGTH': '时长', 'Length': '时长', 'DAY': '白天', 'DUSK': '黄昏', '90 SEC': '90 秒', '3 MIN': '3 分钟',
  'Chill': '轻松', 'Fresh': '普通', 'Fierce': '困难',
  'Relaxed bots with shaky aim. Great for learning the ropes.': '机器人比较佛系、枪法不准，适合熟悉操作。',
  'Balanced bots that push turf and fight back.': '机器人会抢地盘也会还手，难度适中。',
  'Sharp, aggressive bots that punish mistakes. Bring your A-game.': '机器人凶猛精准，一失误就会被惩罚，拿出真本事吧。',
  'Tidewater Plaza': '潮汐广场', 'Kelpline Terminal': '海带码头', 'Tidewater at Dusk': '黄昏潮汐广场',
  'A sun-bleached harbor plaza on the edge of the sea.': '海边一座被阳光晒得发白的港口广场。',
  'Container yard with grate catwalks, a sunken trench and a steel gantry deck.': '集装箱堆场，有格栅走道、下沉沟渠和钢制龙门平台。',
  'Same plaza, golden hour. Lights coming on across the bay.': '同一座广场，黄金时刻，海湾对岸亮起了灯。',
  // ---- Weapons
  'Spritzer': '喷溅枪', 'Swell Roller': '滚筒刷', 'Glint Charger': '蓄力狙', 'Popper Blaster': '爆破枪',
  'Splat Bomb': '溅射炸弹', 'Tidal Slam': '潮汐重击', 'Ink Tempest': '墨水风暴',
  'Shooter': '射击枪', 'Roller': '滚筒', 'Charger': '狙击枪', 'Blaster': '爆破枪',
  'Rapid-fire all-rounder. Sprays a steady stream of ink blobs.': '高射速全能型，持续喷出墨弹。',
  'Roll out wide stripes of turf. Flick for a crushing splash.': '滚出宽阔的涂地带，甩动时泼出致命墨浪。',
  'Hold to charge, release for a long piercing line. Full charge splats.': '按住蓄力，松开射出贯穿长线，满蓄力一击必杀。',
  'Slow shots that burst mid-air. Direct hits splat instantly.': '弹速慢，会在空中爆开，直接命中一击必杀。',
  'Leap up and slam down in a huge ink shockwave.': '跃起后重重砸地，掀起巨大墨水冲击波。',
  'Hurl a rain cloud that soaks the turf below.': '抛出一朵雨云，把下方地面淋满墨水。',
  'Range': '射程', 'Damage': '伤害', 'Fire rate': '射速', 'Mobility': '机动性', 'Ink coverage': '涂地能力',
  'SPECIAL': '大招', 'Special': '大招', 'SUB': '副武器', 'Sub': '副武器',
  'Pick your weapon — your squidkid shows it off on the right': '选择武器，右边的角色会展示给你看',
  // ---- Settings
  'Controls': '操作', 'Video': '画面', 'Audio': '声音', 'Gameplay': '玩法',
  'Mouse sensitivity': '鼠标灵敏度', 'How far the camera turns for each bit of mouse movement.': '鼠标移动时镜头转动的幅度。',
  'Controller sensitivity': '手柄灵敏度', 'Camera turn speed with the right stick.': '右摇杆转动镜头的速度。',
  'Invert vertical look': '上下视角反转', 'Push up to look down, like a flight stick.': '像飞行摇杆一样，往上推是往下看。',
  'Aim assist (controller)': '辅助瞄准（手柄）', 'Gently slows and steers your aim onto nearby rivals when you play with a controller.': '使用手柄时，准星靠近对手会轻微减速并吸附。',
  'Aim assist for mouse': '鼠标辅助瞄准', 'Also apply a lighter aim assist when aiming with a mouse. Off by default.': '鼠标瞄准时也启用较轻的辅助瞄准，默认关闭。',
  'Controls reference': '按键一览', 'Every keyboard, mouse and controller binding in one place.': '键盘、鼠标、手柄的所有按键。',
  'Graphics quality': '画质', 'Low': '低', 'Med': '中', 'Medium': '中', 'High': '高', 'Ultra': '极高',
  'Resolution scale, shadow detail, anti-aliasing and particle counts.': '分辨率缩放、阴影细节、抗锯齿和粒子数量。',
  'Field of view': '视野', 'Wider shows more of the turf around you.': '越大能看到周围越多的地面。',
  'Shadows': '阴影', 'Soft sun shadows. Turn off for extra speed on older machines.': '柔和的阳光阴影，旧电脑可以关掉以提升流畅度。',
  'Bloom glow': '泛光', 'A soft glow around bright ink and specials.': '亮色墨水和大招周围的柔光。',
  'Show FPS counter': '显示帧率', 'Displays frames per second in the corner during matches.': '对局时在角落显示每秒帧数。',
  'Master volume': '总音量', 'Overall loudness of everything.': '所有声音的整体音量。',
  'Music': '音乐', 'Menu and battle soundtrack.': '菜单和战斗配乐。',
  'Sound effects': '音效', 'Weapons, splats, voices and menu sounds.': '武器、击倒、语音和菜单音效。',
  'Camera shake': '镜头震动', 'Screen shake from explosions, slams and hits.': '爆炸、砸地和被击中时的画面震动。',
  'Vibration': '手柄震动', 'Controller rumble for hits, splats, bombs and specials. Only while you play with a controller.': '命中、击倒、炸弹和大招时手柄震动，仅在使用手柄时生效。',
  'Colorblind-safe inks': '色盲友好配色', 'Always use high-contrast yellow vs. blue team inks.': '始终使用高对比度的黄色与蓝色墨水。',
  'Minimap': '小地图', 'Show the turf minimap in the corner during matches.': '对局时在角落显示小地图。',
  'Default bot skill': '默认机器人难度', 'Starting difficulty for new matches.': '新对局的初始难度。',
  'Default match length': '默认对局时长', 'How long each Turf War lasts.': '每局涂地对战的时长。',
  'Look speed, invert, aim assist and the full control reference.': '视角速度、反转、辅助瞄准以及完整按键说明。',
  'Quality tier, field of view and screen effects.': '画质档位、视野和屏幕特效。',
  'Master, music and sound-effect levels.': '总音量、音乐和音效。',
  'Shake, vibration, colour-safe inks, minimap and match defaults.': '震动、色盲配色、小地图和对局默认值。',
  // ---- Control names
  'Move': '移动', 'Aim': '瞄准', 'Fire': '射击', 'Jump': '跳跃', 'Pause': '暂停', 'View': '视角', 'VIEW': '视角',
  'Swim · squid form': '潜墨（乌贼形态）', 'SUPER JUMP': '超级跳', 'Super Jump': '超级跳',
  'MOUSE': '鼠标', 'INPUT': '输入', 'BUTTON': '按键', 'LEFT': '左', 'SPACE': '空格',
  // ---- How to play
  'Turf War in 30 seconds': '30 秒看懂涂地对战',
  'Paint the ground in your team’s color. When time runs out, the team with the most turf wins.': '把地面涂成你队伍的颜色。时间结束时，涂地面积最大的队伍获胜。',
  'Swim in your own ink to zip around and refill your tank.': '在自己的墨水里潜游，移动更快，还能补充墨量。',
  'Enemy ink slows you down and hurts. Paint over it to take the ground back.': '敌方墨水会让你减速并受伤，把它涂回来就能夺回地盘。',
  'Swim up any wall you have inked to reach high ground.': '涂过的墙可以直接游上去，抢占高处。',
  'Your special gauge fills as you ink. Press [F] when it glows!': '涂地会积攒大招，发光时按 [F] 释放！',
  'Only turf counts when time runs out. Splats just buy you space.': '最终只算涂地面积，击倒对手只是帮你争取空间。',
  'Ink the turf': '涂地', 'Swim to refill': '潜墨补充', 'Avoid enemy ink': '避开敌方墨水', 'Climb inked walls': '爬涂过的墙',
  'Ink the most turf in 5 v 5 against bots': '在 5 对 5 中涂出最多地盘',
  // ---- Match HUD
  'READY?': '准备好了吗？', 'READY!': '准备！', 'Ready!': '准备！', 'GO!': '开始！', 'GO': '开始',
  "TIME'S UP!": '时间到！', '1 minute left!': '还剩 1 分钟！', 'LOW INK': '墨量不足', 'TURF': '涂地', 'SPLATS': '击倒', 'SPLATTED': '被击倒',
  'SPLATTED BY': '击倒你的是', 'SPLATTED!': '被击倒！', 'RESPAWN': '复活', 'Times splatted': '被击倒次数', 'Turf inked': '涂地面积', 'Splats': '击倒',
  'Hold SHIFT to swim in your ink and refill': '按住 SHIFT 潜入墨水补充墨量',
  'Low ink! Hold SHIFT in your ink to refill': '墨量不足！在自己的墨里按住 SHIFT 补充',
  'Special ready! Press F': '大招就绪！按 F 释放',
  'Paint the ground — most turf wins!': '涂地吧——涂得最多的一方获胜！',
  'Press 1 – 4 to Super Jump to a teammate  ·  5 to jump home': '按 1–4 超级跳到队友身边  ·  按 5 跳回基地',
  'Hold [TAB] to plan a Super Jump': '按住 [TAB] 规划超级跳', 'Pick a landing spot': '选择落点',
  'Aim bomb · release to throw': '瞄准炸弹 · 松开投掷', 'The whole team is splatted': '全队都被击倒了',
  'FIRST SPLAT!': '首杀！', 'DOUBLE SPLAT!': '双杀！', 'TRIPLE SPLAT!': '三杀！', 'QUAD SPLAT!': '四杀！', 'WIPEOUT!': '团灭！',
  'SHUTDOWN!': '终结！', 'REVENGE!': '复仇！', 'LEVEL UP!': '升级！', 'TIP': '提示',
  // ---- Pause / results
  'PAUSED': '已暂停', 'RESUME': '继续', 'QUIT MATCH': '退出对局', 'QUIT MATCH?': '退出对局？', 'QUIT': '退出',
  'You will leave this Turf War and head back to the lobby. Your turf will not count.': '你将离开本局并返回大厅，本局涂地不计入成绩。',
  'YOUR MATCH': '本局', 'YOUR TEAM': '我方', 'RIVALS': '对手',
  'JUDGING': '判定中', 'VICTORY!': '胜利！', 'DEFEAT': '失败', 'WIN BONUS': '胜利奖励', 'REMATCH': '再来一局', 'MAIN MENU': '主菜单',
  'KEEP PLAYING': '继续游戏', 'STAY FRESH!': '保持状态！', 'VS': 'VS', "IT'S A TIE!": '平局！',
  'Alpha': '阿尔法队', 'Bravo': '布拉沃队',
  'Tangerine': '橘子队', 'Cobalt': '钴蓝队', 'Bubblegum': '泡泡糖队', 'Mint': '薄荷队', 'Lemon': '柠檬队', 'Grape': '葡萄队',
  'Aqua': '水蓝队', 'Cherry': '樱桃队', 'Lime': '青柠队', 'Magenta': '洋红队', 'Sun': '太阳队', 'Sea': '海洋队',
  // ---- Loading
  'Building the plaza…': '正在搭建广场…', 'Filling the harbor…': '正在给港口注水…', 'Mixing ink…': '正在调配墨水…', 'Mixing the ink…': '正在调配墨水…',
  'Teaching squids to swim…': '正在教乌贼游泳…', 'Tuning the tentacles…': '正在调校触手…', 'Warming up…': '热身中…',
  'Rollers paint huge stripes. Flick the roller to splash foes at range.': '滚筒能涂出宽宽的一大片，甩动还能远程泼到敌人。',
  'Chargers splat in one fully-charged shot. Keep moving and use cover.': '狙击枪满蓄力一枪就能击倒你，记得移动并利用掩体。',
  'A Splat Bomb costs most of your tank — throw it where it claims the most turf.': '炸弹会消耗大半墨量，扔在能涂最多地盘的地方。',
  'Low on ink? Dive in, refill, then push again.': '墨不够了？潜进墨里补满再冲。',
  'Enemy ink slows you down and chips away at your health. Paint over it!': '敌方墨水会减速并持续掉血，把它涂掉！',
  'Dive into your own ink as a squid to move fast, hide and refill your ink tank.': '变成乌贼潜入自家墨水，移动更快、能隐藏还能补墨。',
  'Hold [SHIFT] to dive into your ink — you are nearly invisible while swimming.': '按住 [SHIFT] 潜入墨水——潜游时几乎看不见你。',
  'Hold [TAB] to open the big map and spot unpainted turf.': '按住 [TAB] 打开大地图，找找没涂的地方。',
  'Ink a wall, then swim straight up it as a squid to reach high ground.': '先把墙涂上，再变成乌贼直接游上去抢高处。',
  // ---- Ranks / awards / button hints
  'Fresh Recruit': '新兵', 'Turf Scrapper': '地盘争夺者', 'Ink Slinger': '墨水投手', 'Splat Veteran': '击倒老兵', 'Tide Legend': '潮汐传说',
  'MATCHES': '场次', 'Matches': '场次', 'Select': '选择', 'Title': '标题', 'Change': '切换', 'Equip': '装备', 'Adjust': '调整', 'Tabs': '分页',
  'Switch controls': '切换操作方式', 'Hold to speed up': '按住加速', 'Resume': '继续', 'Skip': '跳过', 'Move': '移动',
  'MVP': 'MVP', 'LANDSLIDE': '压倒性胜利', 'PHOTO FINISH': '险胜', 'PURE PAINTER': '纯粹画家', 'SURVIVOR': '幸存者', 'TOP INKER': '涂地王',
  'TOP SPLATTER': '击倒王', 'TURF KING': '地盘之王', 'UNTOUCHABLE': '无人能挡',
  'Most splats in the match': '全场击倒最多', 'Most turf inked in the match': '全场涂地最多', 'Most turf inked on their team': '队内涂地最多',
  'Never got splatted': '一次都没被击倒', 'Never splatted': '零击倒', 'Splatted the fewest times': '被击倒次数最少',
  'Ambient occlusion': '环境光遮蔽', 'Ink detail': '墨水细节', 'Particles': '粒子', 'Pixel density': '像素密度', 'Shadow map': '阴影贴图',
  // ---- Credits
  'Made with': '制作工具', 'Special thanks': '特别感谢', 'Starring the squidkids': '主演：墨鱼小子们', 'Typography': '字体',
  'And you, for playing': '以及正在玩的你', 'Everyone who ever painted a wall': '每一个涂过墙的人', 'Every bot that got splatted in testing': '测试中被击倒的每一个机器人',
  'Procedural everything — squidkids, weapons, stage, ink, music and sound are all generated in code.': '一切皆程序生成——角色、武器、场地、墨水、音乐和音效全部由代码生成。',
  // ---- Multiplayer lobby
  'Checking multiplayer servers…': '正在检查联机服务器…',
  'One player creates a room and shares the room code. Up to 10 players; bots fill empty slots.': '一人创建房间，把房间码告诉朋友。最多 10 人，空位由机器人补齐。',
  'Connection': '连接方式', 'WSS dedicated server (10 players)': 'WSS 专用服务器（10人）', 'Browser direct (up to 10 players)': '浏览器直连（最多10人）',
  'LAN server (with relay)': '局域网服务器（支持中转）', 'Server': '服务器', 'Room key': '房间口令', 'Required to join a WSS room': '加入 WSS 房间时填写',
  'The default dedicated server supports the INKWAVE protocol.': '默认专用服务器已公布墨浪协议支持。',
  'The INKWAVE build of the dedicated server is not deployed yet.': '专用服务器待部署墨浪版本。',
  'Unable to confirm the dedicated server status.': '暂时无法确认专用服务器状态。',
  'Browser direct play needs the public signaling server and may not connect across every network. You can also': '浏览器直连需要先成功连接公共信令并建房，不保证不同网络都能直连。也可',
  'download the LAN version': '下载局域网版', 'to self-host.': '自托管。',
  'Nickname': '昵称', 'Weapon': '武器', 'Create Room': '创建房间', 'Room code': '房间码', 'Join Room': '加入房间',
  'Export Connection Log': '导出连接日志', 'Please enter a room code': '请输入房间码', 'Connecting…': '正在连接…',
  'The host left. Match over.': '房主已离开，对局结束', 'Via host': '经房主', 'Direct': '直连', 'Relay': '中转', 'Host': '房主',
  'Blue Team': '蓝方', 'Red Team': '红方', '(All slots filled by bots)': '（全部由机器人补位）', 'Room': '房间',
  'Send the room code or link to friends:': '把房间码或链接发给朋友：', 'Copy': '复制', 'Copied': '已复制', 'Leave Room': '离开房间',
  'Start Match': '开始对战', 'Waiting for everyone to connect…': '等待所有人连接…', 'Match in progress…': '对战进行中…', 'Waiting for the host to start…': '等待房主开始…',
  "Controls: WASD move · Mouse aim · Left click shoot · Shift swim · Space jump · Right click/E bomb · F/Q special · Tab map · Esc menu (online matches don't pause)": '操作：WASD 移动 · 鼠标瞄准 · 左键射击 · Shift 潜墨 · 空格跳 · 右键/E 炸弹 · F/Q 大招 · Tab 地图 · Esc 菜单（联机时比赛不会暂停）',
  'Enter match controls': '进入对战控制', 'Enter the Match': '进入对战', 'Click to Enter the Match': '点击进入对战',
  'Click the button below to enable mouse aiming, then hold left click to shoot. Press Esc to open the menu.': '点击下方按钮启用鼠标瞄准，然后按住左键开枪。按 Esc 可打开菜单。',
  'Enabling mouse control…': '正在启用鼠标控制…',
  'The browser has not allowed mouse control yet. Click back into the game page and try again, or open the game in its own tab.': '浏览器尚未允许鼠标控制。请先点回游戏页面，再点一次；也可在独立页面中打开游戏。',
  // ---- Connection status and errors
  'Please enter a 6-character room code': '请输入 6 位房间码', 'Waiting for public signaling exchange': '等待公共信令交换',
  'Connecting to the public signaling server…': '正在连接公共信令服务器…', 'Public signaling connected': '公共信令已连接',
  'Connected to public signaling, but could not reach the host directly. Make sure the host is online; you can switch to the same network and retry.': '公共信令已连接，但未能与房主建立直连。请确认房主在线；可换到同一网络后手动重试。',
  'Could not reach the public signaling server (0.peerjs.com) within 30 seconds. Check your network and retry, or export the connection log.': '30 秒内未能连接公共信令服务器（0.peerjs.com）。请检查网络后手动重试，或导出连接日志。',
  'Signaling ready, contacting the host…': '信令已就绪，正在联系房主…',
  'Room not found. Check the room code and make sure the host is still online.': '找不到房间，请检查房间码，并确认房主仍在线。',
  'That room code is already taken. Please create a new room.': '房间码已被占用，请重新创建。',
  'Signaling disconnected; existing direct connections continue. Retrying up to 3 times': '信令连接中断；已建立的直连可继续，最多尝试恢复 3 次',
  'Received player connection request': '收到玩家连接请求', 'Checking direct path to player': '正在检测玩家直连路径',
  'Direct connection to player timed out; data channel did not open': '玩家直连超时，数据通道未打开',
  'Signaling exchanged, but the direct connection failed. Try the same network, or have both players export connection logs.': '信令已交换，但玩家直连失败。请尝试同一网络，或双方导出连接日志。',
  'WebRTC data channel connected': 'WebRTC 数据通道已连接', 'The match has already started. Please wait for the next one.': '对战已开始，请等下一局。',
  'The room is full (10 players).': '房间已满（10 人）。', 'Player connection error. Please check your network.': '玩家连接异常，请检查网络。',
  'The host left or the connection dropped. Please rejoin the room.': '房主已离开或连接中断，请重新加入房间。',
  'Your room session has expired': '房间身份已失效', 'Change your loadout after this match ends': '请在本局结束后更换配置',
  'That team is full (5 players)': '该队伍已满（5 人）', 'Only the host can do that': '只有房主可以执行此操作',
  'Wait for all players to connect': '请等待所有玩家连接', 'Unknown action': '未知操作', 'Room connection closed': '房间连接已关闭',
  'The host did not respond. Please retry': '房主响应超时，请重试', 'Connection closed': '连接已关闭',
  'Please enter a valid secure server address': '请输入有效的安全服务器地址', 'WSS dedicated server': 'WSS 专用服务器',
  'Timed out connecting to the server. Check your network and the server address.': '连接服务器超时，请检查网络和服务器地址。',
  'This server does not support INKWAVE yet. Please wait for a compatible version to be deployed.': '服务器尚未支持墨浪，请等待兼容版本部署。',
  'The server rejected a game message. Please rejoin the room.': '服务器拒绝了游戏消息，请重新加入房间。',
  'Could not connect to the WSS server. Check your network or wait for the service to come online.': '无法连接 WSS 服务器，请检查网络或等待服务上线。',
  'Lost connection to the server. You have left the match; please rejoin the room.': '与服务器连接中断，本局已退出，请重新加入房间。',
  'Server heartbeat timed out. You have left the match; please rejoin the room.': '服务器心跳超时，本局已退出，请重新加入房间。',
  'The server returned an incompatible game room.': '服务器返回不兼容的游戏房间。', 'Server connection lost': '服务器连接已断开',
  'The server did not respond': '服务器响应超时',
  'Send queue congested or message too large. You have left the room; check your network and retry.': '发送队列拥堵或消息过大，已退出房间，请检查网络后重试。',
  'Position message too large. You have left the room.': '位置消息过大，已退出房间。',
  'Cannot reach the room server. Make sure it was started with node server.mjs': '连不上房间服务器，请确认是用 node server.mjs 启动的',
  'Waiting to exchange connection info': '等待交换连接信息', 'WebRTC direct connection established': 'WebRTC 直连成功',
  'Exchanging network addresses': '正在交换网络地址', 'Checking direct path': '正在检测直连路径',
  'Direct connection interrupted, recovering': '直连中断，正在恢复', 'No direct connection; switching to server relay': '直连未建立，正在切换服务器中转',
  'Relay connection failed': '中转连接失败', 'Server relay · higher latency than direct': '服务器中转 · 延迟高于直连',
  'Room server temporarily unreachable, retrying…': '房间服务器暂时连不上，正在重试…',
  'Please enter a nickname': '请输入昵称', 'Too many rooms right now. Please try again later': '房间数量已满，请稍后再试',
  'Room not found or closed. Check the room code': '房间不存在或已关闭，请检查房间码',
  'The match has already started. Please wait for it to end': '对战已开始，请等这局结束',
  'The room is closed. Go back to the lobby and create a new one': '房间已关闭，请返回大厅重新创建',
  'Invalid connection target': '无效连接目标', 'Invalid relay target': '无效中转目标',
  'Only the host can change match settings': '只有房主可以修改对局设置', 'Only the host can start the match': '只有房主可以开始',
  'Too many relay messages': '中转消息过多', 'Invalid request format': '请求格式无效', 'Request too large': '请求过大',
  'The public site uses free direct signaling. Download the LAN version for server relay.': '公开站点请使用免费信令直连模式。服务器中转请下载局域网版。',
};

// Dynamic text containing numbers/names
const PATTERNS = [
  [/^Splatted by (.+)$/i, '被 $1 击倒'],
  [/^(\d+)\s*s$/, '$1 秒'],
  [/^(\d+)\s*min$/i, '$1 分钟'],
  [/^Respawn in (\d+)/i, '$1 秒后复活'],
  [/^(\d+) SEC$/, '$1 秒'], [/^(\d+) MIN$/, '$1 分钟'],
  [/^(.+) WINS?!?$/, '$1 获胜！'],
  [/^(.+) · Turf War$/, (m, a) => `${ZH[a] || a} · 涂地对战`],
  [/^([\d,]+) XP to next level$/i, '距离升级还差 $1 XP'],
  [/^Skip · Select$/, '跳过 · 选择'],
  // multiplayer lobby and connection messages
  [/^(\d+) players?(?: \+ (\d+) bots?)?$/, (m, a, b) => `${a} 人${b ? ` + ${b} 机器人` : ''}`],
  [/^Key (\S+)$/, '口令 $1'],
  [/^Switch to (Blue|Red) Team$/, (m, a) => `换到${a === 'Blue' ? '蓝方' : '红方'}`],
  [/^(Direct|Relay|Connecting…) · (\d+)ms$/, (m, a, b) => `${ZH[a]} · ${b}ms`],
  [/^Failed to load the match: (.+)$/, (m, a) => `对局加载失败：${ZH[a] || a}`],
  [/^The match has ended: (.+)$/, '本局已结束：$1'],
  [/^Connection failed \((.+)\)\. Please retry or use the LAN version\.$/, '联机连接失败（$1），请重试或使用局域网版。'],
  [/^The room is full \((\d+) players\)$/, '房间已满（$1 人）'],
  [/^Room service unavailable \((\d+)\)$/, '房间服务暂不可用（$1）'],
];

const LANG_KEY = 'inkwave.lang';
let lang = 'en';
try { lang = localStorage.getItem(LANG_KEY) || 'en'; } catch { /* private mode */ }   // default: English

const originals = new WeakMap();   // text node → original English
const UPPER = new Map(Object.entries(ZH).map(([k, v]) => [k.toUpperCase(), v]));

function tr(text) {
  const t = text.trim();
  if (!t || !/[A-Za-z]/.test(t)) return null;
  let z = ZH[t] ?? UPPER.get(t.toUpperCase());
  if (z == null) for (const [re, rep] of PATTERNS) if (re.test(t)) { z = t.replace(re, rep); break; }
  if (z == null) return null;
  return text.replace(t, z);
}

function translateNode(n) {
  if (n.nodeType === 3) {
    const cur = n.nodeValue;
    const orig = originals.get(n);
    if (orig && cur === orig._zh) return;                  // already translated
    const z = tr(cur);
    if (z != null && z !== cur) { originals.set(n, { en: cur, _zh: z }); n.nodeValue = z; }
    return;
  }
  if (n.nodeType !== 1) return;
  const tag = n.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'CANVAS' || tag === 'svg' || tag === 'SVG') return;
  for (const a of ['placeholder', 'title', 'aria-label']) {
    const v = n.getAttribute?.(a);
    if (v) { const z = tr(v); if (z != null) { n.dataset['en' + a.replace('-', '')] = v; n.setAttribute(a, z); } }
  }
  for (const c of n.childNodes) translateNode(c);
}

function restoreNode(n) {
  if (n.nodeType === 3) { const o = originals.get(n); if (o && n.nodeValue === o._zh) n.nodeValue = o.en; return; }
  if (n.nodeType !== 1) return;
  for (const a of ['placeholder', 'title', 'aria-label']) { const k = 'en' + a.replace('-', ''); if (n.dataset?.[k]) n.setAttribute(a, n.dataset[k]); }
  for (const c of n.childNodes) restoreNode(c);
}

let observer = null;
export function installI18n() {
  const style = document.createElement('style');
  // The Latin fonts have no CJK glyphs: fall back to system Chinese fonts (bold is closer to the original cartoon style)
  const cjk = "unicode-range: U+2E80-2FFF, U+3000-30FF, U+3400-9FFF, U+F900-FAFF, U+FF00-FFEF;";
  style.textContent = `
    @font-face { font-family: 'Titan One'; src: local('PingFang SC Semibold'), local('PingFangSC-Semibold'), local('Microsoft YaHei Bold'), local('Microsoft YaHei'), local('Noto Sans CJK SC Bold'), local('Source Han Sans SC Bold'); font-weight: 400; ${cjk} }
    @font-face { font-family: 'Rubik'; src: local('PingFang SC'), local('PingFangSC-Regular'), local('Microsoft YaHei'), local('Noto Sans CJK SC'), local('Source Han Sans SC'); font-weight: 300 600; ${cjk} }
    @font-face { font-family: 'Rubik'; src: local('PingFang SC Semibold'), local('PingFangSC-Semibold'), local('Microsoft YaHei Bold'), local('Noto Sans CJK SC Bold'); font-weight: 700 900; ${cjk} }
    .iw-lang { position: fixed; right: 14px; top: 50%; transform: translateY(-50%); z-index: 45; font: 700 13px 'Rubik', 'PingFang SC', sans-serif; color: #fff; background: rgba(20, 16, 50, 0.7);
      border: 2px solid rgba(255,255,255,0.25); border-radius: 10px; padding: 5px 10px; cursor: pointer; pointer-events: auto; }
    body.iw-in-match .iw-lang { display: none; }`;
  document.head.appendChild(style);
  const btn = document.createElement('button');
  btn.className = 'iw-lang';
  const label = () => { btn.textContent = lang === 'zh' ? 'EN' : '中文'; btn.title = lang === 'zh' ? 'Switch to English' : '切换到中文'; };
  label();
  btn.onclick = () => { setLang(lang === 'zh' ? 'en' : 'zh'); label(); };
  document.body.appendChild(btn);
  if (lang === 'zh') start();
}

function start() {
  document.documentElement.lang = 'zh-CN';
  document.title = 'INKWAVE · 墨浪对战';
  translateNode(document.body);
  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') translateNode(m.target);
      else for (const n of m.addedNodes) translateNode(n);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

export function setLang(l) {
  lang = l;
  try { localStorage.setItem(LANG_KEY, l); } catch { /* ignore */ }
  if (l === 'zh') { if (!observer) start(); }
  else { observer?.disconnect(); observer = null; document.documentElement.lang = 'en'; document.title = 'INKWAVE · Turf War'; restoreNode(document.body); }
}
export const getLang = () => lang;
