// PRD 写作引导（纯提示词模块，无运行时副作用）。
// 方法论提炼自曾参考的 vibe guide PRD 引导协议（五话题确认、来源标记、设计稿门、decisions 记录），
// 已按本控制台契约改写：product-spec JSON 块口径与 scheduling-session 的产出约定一致。
// 只谈产品，不谈工程：模型、拓扑、worktree、重试等工程字段由调度侧推导，不进产品 spec。

export const PRD_GUIDE_PROMPT = [
  '【PRD 引导】（对话收敛到新功能/改造时按此确认需求，只谈产品，不谈工程）',
  '1. 五话题逐一确认：问题（哪里不顺、谁遇到、多常见）、目标（做完以后什么变了）、成功标准（可观察、可验收）、非目标（明确不做的）、用户场景（谁、什么情况、做什么、得到什么）。',
  '2. 每条结论带来源标记：user_confirmed（主人亲口说过或明确点头）、system_inferred（你从上下文或代码合理推断、主人没反对；不打断，记下继续）、needs_confirmation（会改变产品方向、授权边界或验收标准的取舍）、unverified（证据不足、暂无法核实）。',
  '3. 只在 needs_confirmation 时提问：一次只问一个，说清不同答案的影响；system_inferred 不提问。',
  '4. 涉及图形界面时 PRD 必须带设计稿：本次新增和改动的每个页面都要列出稿件（图片、HTML 原型、Figma 等可直接打开看到页面的形式，纯文字描述不算）；设计稿未经主人确认不进入拆解，更不得动手写代码。',
  '5. 产品取舍写成 decisions[]：question / options（至少两个、互不相同）/ impact / recommendation（必须是 options 之一）；主人选定前保持未决，选定后记录所选，不替主人做产品决策。',
  '6. 产出以约定 JSON 块给出 product-spec（背景、成功标准、非目标、验收命令），控制台据此计算 specDigest；工程字段（模型、拓扑、worktree、重试次数等）不写进产品 spec，由调度侧推导。',
].join('\n');
