# 奶酪大盗 · 「夜晚」阶段终版设计（数夜 + 偷看骰子 + 偷奶酪 + 桌子可视化）

> 由多智能体设计工作流综合产出（3 套设计 + 评委打分 + 综合）。日期 2026-06-28。

## 中文摘要（给用户确认）

「夜晚」做成由房主自动主持的数夜仪式：屏幕统一从「第1晚」数到「第6晚」，每晚节奏完全一致，所有人看到同一张「四只老鼠围着中间奶酪」的桌子。轮到你的那一晚（你的骰子点数 = 当前晚数）你的手机才会单独弹出操作：大盗只能「偷走奶酪」（不能看骰子），睡鼠可以「偷看任意一名玩家的初始点数」或「装睡」。别人完全看不出今晚谁醒了、谁动了手 —— 每一晚长得一模一样，座位不会因为谁醒了而发光或变化。数完第6晚自动天亮，进入白天，大家轮流报点数（可以撒谎），偷看过的睡鼠就能抓现行。真正的点数只在最后揭晓时公开，那时奶酪才会飞到大盗座位上作为结局彩蛋。整套机制只新增 2 个广播消息、2 个私发消息、1 个客户端动作。

## 1. 规则裁定（决定性）

- 每人发牌时摇的骰子点数 = 醒来的那一晚。房主数 第1晚…第6晚。
- **节奏固定**：每一晚在每台设备上占用相同的可见时长（无论空夜、偷看、偷奶酪）。这是保密的关键。`NIGHT_MIN_MS=4000`，软上限 `NIGHT_MAX_MS=20000`。
- **大盗**：自己那晚只能偷奶酪（设置 host 状态），永远不提供偷看。
- **睡鼠**：自己那晚可偷看「一名其他玩家的原始骰子点数(1-6)」或装睡。偷看只返回数字 —— 不含身份、不含奶酪、不含 effective-7、不含时间信息。
- **可以偷看大盗**，返回大盗的原始点数（如 3），不是 7。这正是抓谎的途径。
- 偷看是无状态查表 `dice[target]`（顺序无关）。
- 骰子碰撞是常态（~72%）：点数=N 的所有人同一晚一起醒，各自独立私密行动。
- 空夜：无人醒，节奏照走。
- **大盗永不阻塞流程**：effectivePoint 已让大盗=7（host 状态），偷奶酪不需要客户端确认；循环只等待当晚醒来的「睡鼠」。
- 偷看可选；超时/掉线 = 装睡（对外无差别）。
- 非法偷看（大盗发的 / 非本人之夜 / 看自己 / 目标不存在）host 静默丢弃。
- 白天：提示「轮流公布你的初始点数（可以撒谎）」，所有人（含大盗）一样。App 不裁判、不自动揭穿。偷看结果作为私密提示卡留到白天。
- 真实点数/身份只在最终 result 揭晓。
- 胜负判定不变：resolveElimination 仍用 effectivePoint（大盗=7，平票必被翻 —— 奶酪出卖了你）。偷看到的原始点数不参与平票。`cheeseHolder` 仅用于结算画面彩蛋，不影响胜负。

## 2. 夜晚流程

**房主（裁判，也是玩家）**：点 `btn-to-night` → `startNight()`（重置 currentNight/cheeseHolder/nightAwait/nightTimer，broadcast phase:'night'，renderTable，tickNight）。
`tickNight()`：currentNight++；>6 → `dawn()`（broadcast phase:'day'）。否则 broadcast `{type:'night-tick', night:N}`（只含整数，无 id）；算 `wakersOn(dice,N)`：大盗 → 设 cheeseHolder、私发 `{type:'wake',action:'steal'}`（不入 nightAwait）；睡鼠 → 入 nightAwait、私发 `{type:'wake',action:'peek'}`。起计时：当 nightAwait 空且过了 NIGHT_MIN_MS，或到 NIGHT_MAX_MS，进入下一晚。

**各玩家所见**：人人每晚相同 —— 「🌙 第 N 晚 / 6」+ 6 颗月亮进度点 + 静态 4 座桌子（奶酪居中）+ 「大家都睡着了…」。轮到的睡鼠（仅本机）弹出偷看面板；轮到的大盗（仅本机）弹出偷奶酪面板（奶酪在公共桌面**不**移动）；没轮到的人看到完全相同的静态画面。

## 3. 四人围桌可视化（纯 HTML/CSS）

替换 `screen-night` 里的 `<p id="night-text">`：加 `#night-counter`、`#moon-pips`、`#night-table`（内含 `#cheese-token` 居中 + JS 注入的座位）、`#night-caption`、`#night-action`（私密面板）、`#night-host-status`（host-only，只显示计数不显示名字）。

`renderTable()`（进入夜晚时调用一次，非每晚）：座位角度 `angle=-90+i*360/n`，`left=50%+42%cos`,`top=50%+42%sin`,translate(-50%,-50%)。每个座位都是睡觉老鼠 😴（绝不显示大盗图标），自己座位加 `--cheese` 光环（**唯一**的座位区别，且每晚恒定）。

> **隐私不变量（写进代码注释）**：座位必须静态，醒来时绝不可发光/加徽标/变暗/脉动/动画；夜晚公共奶酪绝不移动。违反即重新引入「醒来顺序泄漏」，游戏作废。

result 画面（身份已公开后）克隆 `#night-table`，把奶酪滑入大盗座位（CSS transition），「原来奶酪在你这儿！」。

## 4. 消息协议（基于现有 join/players/role/phase/vote/result）

- 新增广播 `night-tick {night}`：host→all，不含身份。
- 新增私发 `wake {night, action:'steal'|'peek'}`：host→当晚唯一行动者。
- 新增私发 `peek-result {target, name, die}`：host→偷看的那只睡鼠。绝不广播。
- 新增 client→host `night-action {kind:'peek'|'skip'|'steal', target?}`：host 走 `recordNightAction`，本人自行动作时直接本地调用（仿 self-vote）。
- net.js 消息层无需改动（sendTo/broadcast 已够）。`btn-to-day` 从夜晚流程移除。

## 5. game.js 纯逻辑改动 + 单测

```js
export function wakersOn(dice, n) {
  return Object.keys(dice).filter((id) => dice[id] === n).sort();
}
export function resolvePeek(dice, roles, requesterId, targetId, currentNight) {
  if (roles[requesterId] === ROLES.THIEF) return null;   // 奶酪属鼠不行
  if (dice[requesterId] !== currentNight) return null;   // 非本人之夜
  if (targetId == null || targetId === requesterId) return null;
  if (dice[targetId] === undefined) return null;         // 目标不存在/掉线
  return dice[targetId];                                  // 只返回原始点数
}
```

其余函数不变。新增测试：wakersOn 碰撞/空夜/全碰撞/划分覆盖；resolvePeek 看大盗返回原始点数(非7)、大盗发起返回 null、非本人之夜 null、看自己/未知目标 null；回归：平票仍按 effective-7 判定且与 resolvePeek 独立。

## 6. app.js 状态机改动

- 停留在 `'night'` 阶段，加 host 子计数器（不新增顶层 phase）。
- 扩展 G：currentNight、cheeseHolder、nightAwait(Set)、nightTimer、myWake、myPeek。
- 新增 host 函数：startNight、tickNight、onNightTick、recordNightAction、dawn。
- 新增渲染：renderTable（一次）、重写 renderNight（按 G.myWake 分支私密面板）、renderNightCounter。
- hostHandle 加 night-action；clientHandle 加 night-tick/wake/peek-result。
- renderDay 加「公布初始点数（可以撒谎）」提示（所有人一致），并重显 myPeek 卡片。
- onDisconnect：nightAwait.delete + 重新判定推进；大盗中途掉线沿用 v1 结束本局。
- replay（btn-replay→startGame）：重置上述夜晚状态并 clearTimeout(nightTimer)。

### 先修的 bug（设计评审发现）

`net.js` 客户端 `onConnected()` 未传参，但 `app.js` 期望 `onConnected(myId)` → 客户端 `G.myId` 恒为 undefined。修复：`conn.on('open', () => onConnected && onConnected(peer.id));`

## 7. 隐私分析

- 自己身份+点数：仅本人（sendTo role，沿用）。
- 谁在第 N 晚醒：仅该行动者（wake 私发；其余人可本地由 myDie===N 自行判断，从不发送）。night-tick 广播只含整数。
- 他人原始点数：仅合法偷看的那只睡鼠（peek-result 私发，resolvePeek 校验，只给原始点数）。
- 奶酪持有者/大盗身份：result 前无人知（cheeseHolder 仅 host 本地，夜晚公共奶酪不动）。
- 时间侧信道：NIGHT_MIN_MS 钳制使每晚等长；桌子不反应；host 状态只计数不报名。

## 8. 实现清单（依赖顺序）

1. 修 net.js `onConnected(peer.id)`。
2. game.js 加 wakersOn + resolvePeek + 单测，`node --test` 绿。
3. index.html 夜晚 markup；移除 btn-to-day。
4. style.css 桌子/座位/计数/月相/twinkle + 隐私注释。
5. app.js 扩展 G + startGame 重置（含 clearTimeout）。
6. app.js host 循环 startNight/tickNight（NIGHT_MIN/MAX 钳制、自动记录偷奶酪、只等 nightAwait）/dawn/recordNightAction。
7. app.js 接线 hostHandle/clientHandle。
8. app.js 渲染 renderTable/renderNight/renderNightCounter/偷看面板/偷奶酪面板/私密奶酪动画。
9. app.js 白天提示 + myPeek 卡。
10. app.js result 奶酪滑入大盗座位。
11. app.js 掉线处理。
12. 4 标签页手动测：空夜/偷奶酪/偷看/碰撞视觉与时长不可区分；睡鼠看大盗见原始点数；replay 干净无双触发。

常量：`NIGHT_MIN_MS=4000`、`NIGHT_MAX_MS=20000`。
