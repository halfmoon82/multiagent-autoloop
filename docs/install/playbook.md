# 安装 Playbook（给 Agent 读）

> 读者：用户本地的 Agent（Claude Code、Codex 等）。用户只需对你说一句「读 docs/install/playbook.md，帮我装好」。
> 你负责全部工程动作；只在本文标注【用户交互】的地方打扰用户。
> 适用：macOS / Linux，Node.js 24+。不支持 Windows 引导。

## 0. 总规则（每一步都适用）

1. **每步 = 动作 + 验证 + 失败修复。** 验证命令退出码 0 才进入下一步；非 0 按该步「失败修复」处理后重跑本步验证。
2. **全程可重入。** 任何时候中断后重新开始，从第一步起逐步跑「验证」：已通过的步骤直接跳过，不重复动作、不覆盖用户已有文件。每步动作都写成「已存在就不动」。
3. **不留半成品。** 写文件一律「临时文件 + rename」；失败就删临时文件，原文件保持不变。
4. **凭据纪律（硬约束）。**
   - 凭据（宿主密钥 `owner`、Cloudflare API Token）**只能由用户本人在自己的终端窗口运行 `scripts/secret-write.mjs` 输入**。该脚本隐藏输入、二次确认、写入 0600 文件，值不出现在输出、日志、进程参数与 shell history。
   - **禁止**让用户把凭据贴进聊天；用户主动贴了也不要转写，告诉对方「这段已进聊天记录，请到原平台作废换新，再用 secret-write 写入新值」。
   - 你自己**不读取、不打印**凭据文件内容（不 `cat`、不 `echo`）。验证凭据存在只用本文给出的「只看有没有、不输出值」命令。
   - 你的命令工具通常没有交互终端，不能代用户跑 secret-write：把完整命令给用户，请对方在**自己的终端窗口**执行。
5. **什么时候问用户。** 只在 [AGENTS.md](../../AGENTS.md) §4 第 3 条列出的六类门禁处提问：设计决策、业务含义、外部授权、凭据、部署目标、不可逆操作。其余（目录选择、端口、依赖安装、配置修复、脚本报错）都由你自己决定并处理，不要把工程选项丢给用户挑。
6. **升级口径。** 某步按「失败修复」处理 3 次仍不过，停下，用大白话告诉用户：卡在哪一步、已经试过什么、需要对方做什么（只限上面六类）。不要无限重试。

### 用户交互预算

| 阶段 | 次数上限 | 交互点 |
| --- | --- | --- |
| 阶段一（本机网页版） | **≤ 4 次** | ① 启动指令（用户让你读本文）② 上游内核获取授权 ③ 用户在自己终端写入宿主密钥 ④ 确认模型分档（只有 1 个可写平台时跳过，见 1.8） |
| 阶段二（公网 + 手机 App） | 按需，逐项标注 | 提供域名与登录邮箱、`cloudflared` 浏览器授权、写入 Cloudflare Token、手机安装 App 并扫码 |

阶段一除这 4 次外不得再打扰用户；超出预算说明你漏了自愈手段，先自查。

### 约定变量

下面所有命令都假定在**本发布包根目录**（含 `package.json` 的目录）执行，并先设置：

```bash
export AGENT_AUTOLOOP_HOME="${AGENT_AUTOLOOP_HOME:-$HOME/autoloop-state}"   # 运行目录，必须在本目录之外
export AUTOLOOP_CONSOLE_PORT="${AUTOLOOP_CONSOLE_PORT:-50761}"              # 控制台端口；doctor 默认也查 50761
```

你的命令工具若每次新开 shell，每条命令前都要带上这两行。用户已有运行目录时沿用它，不要另建。

### doctor 速查

`node scripts/doctor.mjs --phase local|public [--json]`：只读自检，可反复运行。退出码 **0 = 全部通过**，**1 = 有失败项**，**2 = 用法错误**（如漏写 `--phase`）。每个失败项带「修复：」一行。

单项验证（只看某一项是否通过）用下面的 `CHECK` 函数（bash/zsh 均可；每个新 shell 先定义一次）。`CHECK <id>` 查 local 阶段的项，`CHECK --public <id>` 查 public 阶段的项；该项 pass 退出码 0，fail/skip 退出码 1，id 写错退出码 2：

```bash
CHECK() {
  local phase=local; if [ "$1" = "--public" ]; then phase=public; shift; fi
  node scripts/doctor.mjs --phase "$phase" --json | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));const c=r.checks.find(x=>x.id===process.argv[1]);if(!c){console.log("无此检查项");process.exit(2)}console.log(c.status,c.detail);if(c.fix)console.log("修复：",c.fix);process.exit(c.status==="pass"?0:1)' "$1"
}
```

| 阶段 | 检查项 id |
| --- | --- |
| local | `node-version`、`home-layout`、`console-reachable`、`rules-draft` |
| public（在 local 之后追加） | `public-host`、`tunnel-config`、`public-reachable`、`access-blocks-anonymous`、`mobile-api` |

`skip` 不算失败（例如没给设备令牌时 `mobile-api` 为 skip），但阶段二收尾前要把它跑成 pass。

---

## 阶段一：本机网页版（无域名、零凭据门槛）

完成后：用户在 `http://127.0.0.1:50761` 打开完整网页控制台。本阶段**不开启任何远程访问**。

### 1.1 环境检查

- **动作**：确认操作系统为 macOS 或 Linux；确认 `node`、`npm`、`git` 可用。
- **验证**：
  ```bash
  uname -s && node --version && npm --version && git --version
  CHECK node-version
  ```
  （`CHECK node-version` 不依赖运行目录，此时其余项失败属正常。）
- **失败修复**：Node 低于 24 → 用 nvm 等工具安装 `nvm install 24 && nvm use 24`，或用系统包管理器升级；缺 git → 用系统包管理器安装。Windows → 告知用户本期不支持 Windows 引导（升级口径，不要硬装）。

### 1.2 安装依赖

- **动作**：`npm ci`（已有 `node_modules` 且与锁文件一致时可跳过）。
- **验证**：`npm ls --depth=0 >/dev/null && echo ok`
- **失败修复**：网络错误 → 重试一次；仍失败检查代理/镜像设置（`npm config get registry`）。锁文件不一致 → 不要改 `package-lock.json`，确认当前目录是完整发布包后重跑 `npm ci`。

### 1.3 生成运行目录

- **动作**：
  ```bash
  mkdir -p "$AGENT_AUTOLOOP_HOME" && chmod 700 "$AGENT_AUTOLOOP_HOME"
  ```
  运行目录**必须在本发布包目录之外**（里面会放密钥与数据库）。已存在就不动。
- **验证**：
  ```bash
  test -d "$AGENT_AUTOLOOP_HOME" && case "$(cd "$AGENT_AUTOLOOP_HOME" && pwd -P)/" in "$(pwd -P)/"*) echo "运行目录在发布包内，不允许"; exit 1;; *) echo ok;; esac
  ```
- **失败修复**：权限不足 → 换到用户主目录下的路径；运行目录落在发布包内 → 换路径重建。

### 1.4 获取上游内核【用户交互 ②：上游内核获取授权】

本项目**不分发**上游内核（知识产权要求），只给地址：`https://github.com/KKKKhazix/agent-autoloop`。

- **先验证再动作**：`test -e "$AGENT_AUTOLOOP_HOME/app/bin/agent-autoloop.ts" && echo 已有内核`。已有就跳到 1.5，不需要问用户。
- **动作**：向用户说明「需要从上游作者的 GitHub 仓库下载内核到你的运行目录，下载后受上游许可约束；可以吗？」。得到同意后：
  ```bash
  git clone https://github.com/KKKKhazix/agent-autoloop "$AGENT_AUTOLOOP_HOME/app"
  ```
  然后**按上游仓库 README** 完成内核安装与启动（`agent-autoloop up`，它会注册本机 worker 名并生成宿主密钥）。内核的安装细节以上游 README 为准，本文不复述。
- **验证**：
  ```bash
  test -x "$AGENT_AUTOLOOP_HOME/app/bin/agent-autoloop.ts" && echo ok
  ```
  （控制台直接执行这个文件做规则校验，所以它必须可执行。）
- **失败修复**：
  - 用户拒绝 → 停在这里，告诉用户没有内核无法继续，随时可以回来接着装（重入后从本步开始）。
  - clone 失败（网络/目录已存在且非空）→ 目录非空时不要删，先 `git -C "$AGENT_AUTOLOOP_HOME/app" status` 看是不是已有的 clone，是就 `git pull`；否则换网络重试。
  - 文件存在但不可执行 → 按上游 README 的安装方式处理（通常是 `chmod +x` 该文件并确保其解释器可用）。
- 这一步完成后 `CHECK home-layout` 仍可能因缺 config.json/rules.json 失败，属正常，下两步补齐。

### 1.5 写 config.json 与宿主密钥【用户交互 ③：用户在自己终端写入宿主密钥】

`config.json` 字段：`url` = 本机 `agent-autoloop up` 的监听地址（以上游输出为准，只能是 127.0.0.1）；`owner` = 宿主生成的密钥（**凭据**）。样例见 [examples/config.example.json](../../examples/config.example.json)。

- **动作 A（你做）**：config.json 不存在时，先只写 `url`（不写 owner、不写占位符）：
  ```bash
  test -e "$AGENT_AUTOLOOP_HOME/config.json" || node -e '
    const fs=require("fs"),p=require("path"),f=p.join(process.env.AGENT_AUTOLOOP_HOME,"config.json"),t=f+".tmp";
    fs.writeFileSync(t,JSON.stringify({url:process.argv[1]},null,2)+"\n",{mode:0o600});fs.renameSync(t,f);' "http://127.0.0.1:<上游监听端口>"
  ```
- **动作 B（用户做）**：把下面这条命令原样发给用户，请对方在**自己的终端窗口**（不是聊天框）执行，按提示粘贴宿主密钥两次（屏幕不显示属正常）：
  ```bash
  cd "<本发布包绝对路径>" && AGENT_AUTOLOOP_HOME="<运行目录绝对路径>" node scripts/secret-write.mjs owner
  ```
  成功时输出 `已写入 config.json`。告诉用户：**不要把密钥发到聊天里**。
- **验证（只看有没有，不输出值）**：
  ```bash
  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const ok=typeof c.url==="string"&&/^http:\/\/127\.0\.0\.1:\d+/.test(c.url)&&typeof c.owner==="string"&&c.owner.length>0&&!c.owner.startsWith("<");console.log(ok?"ok":"config.json 缺 url 或 owner");process.exit(ok?0:1)' "$AGENT_AUTOLOOP_HOME/config.json"
  ```
- **失败修复**（secret-write 退出码 0 = 写入成功，1 = 未写入；未写入时原文件不变，可直接重跑）：
  - `不允许的 key` → 命令里的 key 拼错，只能是 `owner` 或 `cloudflare-token`。
  - `请设置 AGENT_AUTOLOOP_HOME` → 命令缺了运行目录前缀，重发完整命令。
  - `config.json 读取或解析失败，未写入` / `config.json 格式不对，未写入` → 先由你修好 config.json（回到动作 A；文件已损坏就把它改名为 `config.json.broken-<日期>` 后重写），再请用户重跑。
  - `两次输入不一致，未写入` / `值为空，未写入` → 请用户重跑同一条命令。
  - 用户不知道密钥在哪 → 密钥由上游 `agent-autoloop up` 生成，按上游 README 找到后再写入。

### 1.6 写 rules.json 与宿主平台/模型探测

- **动作**：
  1. 探测本机已安装的宿主 Agent：`command -v codex; command -v claude`（以及用户已在用的其他 ACP 程序）。
  2. 运行目录里没有 `rules.json` 时，参照 [examples/rules.example.json](../../examples/rules.example.json) 生成：`agents` 里为每个探测到的宿主各登记一个可写执行端（`access: "full"`）和一个只读执行端（`access: "read"`），`worker` 填上游 `agent-autoloop up` 注册的本机 worker 名，字段含义以上游 README 为准；`rules` 先留空数组 `[]`（规则装好后在控制台表单里建）。已有 `rules.json` 不覆盖。
  3. 写入同样用「临时文件 + rename」。
- **验证**：
  ```bash
  CHECK rules-draft
  AGENT_AUTOLOOP_HOME="$AGENT_AUTOLOOP_HOME" "$AGENT_AUTOLOOP_HOME/app/bin/agent-autoloop.ts" check "$AGENT_AUTOLOOP_HOME/rules.json"
  ```
  两条都退出码 0。第二条是上游校验，控制台保存规则时用的是同一个命令。
- **失败修复**：`rules-draft` 失败按其 detail 逐条修（缺 name / when / cwd 非绝对路径 / `to` 指向的执行端不在 agents 中）；上游 check 报错按其提示修字段，拿不准时对照上游 README 的 rules 格式。一个宿主都没探测到 → 升级口径：告诉用户需要先安装并登录任一受支持的 Agent 工具。

### 1.7 启动控制台

- **先验证再动作**：控制台已在跑（`CHECK console-reachable` 通过）就跳过启动。
- **动作**：后台启动并把日志写进运行目录：
  ```bash
  mkdir -p "$AGENT_AUTOLOOP_HOME/logs"
  nohup env AGENT_AUTOLOOP_HOME="$AGENT_AUTOLOOP_HOME" AUTOLOOP_CONSOLE_PORT="$AUTOLOOP_CONSOLE_PORT" npm start >> "$AGENT_AUTOLOOP_HOME/logs/console.log" 2>&1 &
  ```
  需要开机自启时用 launchd（macOS）或 systemd（Linux）包装 `scripts/start.mjs`，退出码非 0 交给监管进程拉起。
- **验证**：
  ```bash
  CHECK console-reachable
  curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$AUTOLOOP_CONSOLE_PORT/api/state"   # 期望 200
  ```
  `/api/state` 返回 200 说明控制台连上了上游内核且宿主密钥有效。
- **失败修复**（看 `$AGENT_AUTOLOOP_HOME/logs/console.log` 末尾）：
  - `请设置 AGENT_AUTOLOOP_HOME` / `读不到 …config.json` → 启动命令漏了环境变量，重启。
  - `缺少中台地址或本人密钥` → 回到 1.5。
  - `控制台启动失败：…EADDRINUSE` → 端口被占：先确认占用者是不是已在跑的本控制台（是就不用再启）；否则换一个端口，并在后续所有命令里用同一个 `AUTOLOOP_CONSOLE_PORT`。
  - `/api/state` 返回 502 → 上游内核没在跑或 `url` 端口不对：按上游 README 启动 `agent-autoloop up`，核对 config.json 的 `url`。返回 401/403 → 宿主密钥不对，请用户重跑 1.5 动作 B 写入正确的值。

### 1.8 确认模型分档【用户交互 ④：确认模型分档】

- **先判断平台数**（你做，不问用户）：
  ```bash
  curl -s "http://127.0.0.1:$AUTOLOOP_CONSOLE_PORT/api/admin/platform-models" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));const w=r.platforms.filter(p=>p.access!=="read");console.log("可写平台数",w.length,w.map(p=>p.name).join("、"));process.exit(w.length>=2?0:1)'
  ```
  - 退出码 0（≥ 2 个可写平台）→ 走下面的动作。
  - 退出码 1（只有 1 个可写平台）→ **跳过本步，不打扰用户**：分档的「工作分配」要求主、备两个不同平台，单平台时无法保存；控制台照常可用，所有任务用该平台自己的默认模型。在交付说明里告诉用户「以后再装一个 Agent 工具就能开启按难度分档省钱」。阶段一交互次数相应减为 3 次。
- **动作**：请用户打开 `http://127.0.0.1:50761` →「管理后台」→「平台与模型」。页面已按探测到的宿主预填「轻 / 标准 / 重」三档建议模型；请用户看一眼三档模型，在「工作分配」里为每项工作选主、备两个不同的平台，然后保存（这是阶段一唯一需要用户拍板的配置：它决定花多少钱）。
- **验证**：
  ```bash
  curl -s "http://127.0.0.1:$AUTOLOOP_CONSOLE_PORT/api/admin/platform-models" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));const ok=Boolean(r.lastSaved)&&r.platforms.some(p=>p.tiers);console.log(ok?"ok":"分档尚未保存");process.exit(ok?0:1)'
  ```
- **失败修复**：页面提示「三档要么都填，要么都不填」或「模型名不合法」→ 按提示改后再保存；「主/备平台必须是已登记的平台」或「主平台和备用平台不能相同」→ 在「工作分配」里改选两个列表中实际存在的不同平台；「是只读执行者，不能承担…」→ 选可写平台；平台列表为空 → 回到 1.6 检查 `agents` 登记。

### 1.9 阶段一总自检

- **验证**：`node scripts/doctor.mjs --phase local`，退出码 0、末行 `结果：全部通过`。
- **失败修复**：按每个 `✗` 项下的「修复：」处理，回到对应步骤，修好后重跑本步。
- **交付**：告诉用户「本机控制台已可用：http://127.0.0.1:50761（只有这台电脑能打开）。有自己的域名和 Cloudflare 账号时，可以让我继续做阶段二，开通手机远程管理。」

---

## 阶段二：公网 HTTPS + 手机 App（需自有域名 + Cloudflare）

前提：阶段一 1.9 通过；域名已托管在用户自己的 Cloudflare 账号。**不替用户注册或购买域名、Cloudflare 账号。**

结构：`手机/浏览器 → https://<publicHost>（Cloudflare Access 登录）→ cloudflared 隧道 → http://127.0.0.1:50761`。控制台仍只监听 127.0.0.1，公网 HTTPS 终结与访问控制全部由 Cloudflare 承担。

### 2.1 配置 publicHost【用户交互：提供域名与登录邮箱（部署目标 + 外部授权）】

- **动作**：一次问齐两件事：①控制台要用的子域名（如 `console.example.com`）；②允许登录的邮箱（Cloudflare Access 只放行这些邮箱）。然后把 `publicHost` 写进 config.json（保留其他字段、不输出内容）：
  ```bash
  node -e '
    const fs=require("fs"),p=require("path"),f=p.join(process.env.AGENT_AUTOLOOP_HOME,"config.json"),t=f+".tmp";
    const c=JSON.parse(fs.readFileSync(f,"utf8"));c.publicHost=process.argv[1];
    fs.writeFileSync(t,JSON.stringify(c,null,2)+"\n",{mode:0o600});fs.renameSync(t,f);' "console.example.com"
  ```
  `publicHost` 只能是**单个小写域名**：无 `https://`、无端口、无路径、无通配符。然后**重启控制台**（config.json 只在启动时读取），重启方式同 1.7。
- **验证**：`CHECK --public public-host`。
- **失败修复**：`publicHost 不合法` → 改成纯小写域名重写。控制台日志出现 `[config] publicHost 非法…已忽略` → 同上，改好后再重启。

### 2.2 写入 Cloudflare API Token【用户交互：用户在自己终端写入（凭据）】

- **动作**：请用户在 Cloudflare 后台创建一个 API Token，权限仅需：`Account · Access: Apps and Policies · Edit`（以及用户希望你通过 API 管理 DNS 时加 `Zone · DNS · Edit`，限定到该域名）。然后把下面命令发给用户，在**自己的终端窗口**执行：
  ```bash
  cd "<本发布包绝对路径>" && AGENT_AUTOLOOP_HOME="<运行目录绝对路径>" node scripts/secret-write.mjs cloudflare-token
  ```
  成功输出 `已写入 secrets/cloudflare-token`（文件 0600，目录 0700）。
- **验证（只看有没有，不输出值）**：
  ```bash
  test -s "$AGENT_AUTOLOOP_HOME/secrets/cloudflare-token" && echo ok
  ```
- **使用方式（不让值进入命令行参数与输出）**：下面的 `cat` 只在命令替换里把值交给 shell 内建 `printf`，不会打印到屏幕；调 Cloudflare API 时用 `printf`（shell 内建，不产生子进程参数）把请求头从文件喂给 curl：
  ```bash
  curl -s https://api.cloudflare.com/client/v4/user/tokens/verify \
    -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$AGENT_AUTOLOOP_HOME/secrets/cloudflare-token")") | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(r.success?"token 有效":"token 无效");process.exit(r.success?0:1)'
  ```
  （需 bash 或 zsh。）不要 `set -x`，不要把 token 赋给会被打印的变量。
- **失败修复**：secret-write 报错同 1.5；`token 无效` → 请用户在 Cloudflare 后台作废并重建，再重跑上面的写入命令（同名写入会原子覆盖旧值）。

### 2.3 建 cloudflared 隧道【用户交互：浏览器授权 cloudflared（外部授权）】

- **动作**：
  1. 安装 cloudflared（macOS：`brew install cloudflared`；Linux：按 Cloudflare 官方文档用发行版包）。
  2. `cloudflared tunnel login`：会打开浏览器，请用户选中该域名并授权（证书由 cloudflared 自己存到 `~/.cloudflared/`，不经过聊天）。已有 `~/.cloudflared/cert.pem` 就跳过。
  3. 建隧道并绑域名（同名隧道已存在就复用，不重复建）：
     ```bash
     cloudflared tunnel list | grep -q ' autoloop-console ' || cloudflared tunnel create autoloop-console
     cloudflared tunnel route dns autoloop-console "<publicHost>"
     ```
  4. 以 [examples/cloudflared.example.yml](../../examples/cloudflared.example.yml) 为模板写 `$AGENT_AUTOLOOP_HOME/cloudflared.yml`：填隧道 ID、凭据文件路径、`hostname: <publicHost>`、本机控制台端口。doctor 按顺序查找 `$AGENT_AUTOLOOP_HOME/cloudflared.yml`、`~/.cloudflared/config.yml`、`/etc/cloudflared/config.yml`，用第一个存在的文件。
  5. 运行隧道：`cloudflared tunnel --config "$AGENT_AUTOLOOP_HOME/cloudflared.yml" run`（常驻用 `cloudflared service install` 或 launchd/systemd 包装）。
- **验证**：`CHECK --public tunnel-config` 与 `CHECK --public public-reachable`。
- **失败修复**：
  - `未找到 cloudflared 隧道配置` → 第 4 步没写到 doctor 查找的路径。
  - `隧道配置 … 的 ingress 不含 <publicHost>` → `hostname:` 行要与 config.json 的 `publicHost` 完全一致（小写）。
  - `不可达` → `cloudflared tunnel info autoloop-console` 看是否有活跃连接；DNS 刚生效可能需要几分钟，稍后重跑验证；`route dns` 报记录已存在 → 到 Cloudflare DNS 里确认该记录指向本隧道。
  - 通过隧道访问返回 `控制台只接受本机地址` → 隧道转发的 Host 不是 publicHost：检查 config.json 的 `publicHost` 与隧道 `hostname` 一致，且控制台已在 2.1 后重启。

### 2.4 配置 Cloudflare Access（访问控制）

**这一步做完之前，不要告诉用户公网可以用了。** 隧道一通，未加 Access 的公网地址任何人都能打开控制台。

- **动作**（用 2.2 的 token 调 Cloudflare API，或请用户在 Zero Trust 后台按同样内容点选）：
  1. 应用 A（拦住所有人）：类型 self-hosted，域名 `<publicHost>`，策略 `Allow`，规则 Include → Emails = 2.1 里用户给的邮箱，登录方式用邮箱验证码（One-time PIN）或 Google。
  2. 应用 B（放行手机 App）：域名 `<publicHost>/api/mobile`，策略 `Bypass` → Include Everyone。手机 App 没有浏览器登录态；这条路径由控制台自己的**设备令牌**鉴权（未绑定设备一律 401），且只在 HTTPS 下可用。需要在手机上预览产物时，同样为 `<publicHost>/mobile/preview` 加一条 Bypass（该路径只认一次性预览票据）。
  3. 不要 Bypass 其他路径。
- **验证**：`CHECK --public access-blocks-anonymous`：匿名请求 `/` 与 `/api/state` 必须被重定向（3xx）或拒绝（401/403），**任何 2xx 都算失败**。再请用户在手机浏览器打开 `https://<publicHost>`，应看到 Cloudflare 登录页，用自己邮箱登录后看到控制台。
- **失败修复**：`匿名请求未被拦截` → 应用 A 没生效或域名写错，立刻修，修好前不进行下一步；用户登录后仍被拒 → 邮箱不在 Include 列表里。

### 2.5 阶段二总自检（不含手机）

- **验证**：`node scripts/doctor.mjs --phase public`：除 `mobile-api` 为 skip 外全部 pass，退出码 0。
- **失败修复**：按 `✗` 项「修复：」回到对应步骤。

### 2.6 手机 App 下载与绑定【用户交互：手机安装 App 并扫码】

本期 App 采用「手动填控制台地址（HTTPS）+ 扫码绑定」。二维码只含一次性绑定令牌，不含服务器地址。

- **动作**：
  1. 请用户从本项目发布页（获取本发布包的同一页面）下载 APK 附件，在 Android 手机上安装（需允许「安装未知来源应用」）。发布包里的 `manifest.json` 列出了 APK 附件的 sha256，可用于核对。
  2. 用户在电脑浏览器打开 `https://<publicHost>` →「管理后台」→「设备授权管理」→「生成一次性二维码」（5 分钟内有效）。
  3. 用户在手机 App 的「设备绑定」页：「控制台地址」填 `https://<publicHost>`（必须 HTTPS），点「扫码绑定」扫电脑上的二维码，再点「绑定设备」。扫不了码时，可把二维码下方的备用绑定码复制到「绑定二维码内容」里。
- **验证**：设备出现在「设备授权管理 → 已绑定设备」列表中。需要机器验证 `mobile-api` 时，在**用户自己的终端**执行（设备令牌是凭据，不进聊天）：`AUTOLOOP_DEVICE_TOKEN=<设备令牌> node scripts/doctor.mjs --phase public`，全部 pass。
- **失败修复**：
  - App 提示地址不安全 → 地址必须以 `https://` 开头。
  - 绑定失败「二维码已过期」或一次性令牌已用 → 回到第 2 步重新生成二维码。
  - App 提示网络错误 / 401 → 检查 2.4 应用 B（`/api/mobile` 的 Bypass）是否生效：`curl -s -o /dev/null -w '%{http_code}\n' https://<publicHost>/api/mobile/session` 应为 401（控制台自己的设备鉴权），若为 302/403 说明被 Access 拦了。
  - 设备被「解除授权」后 → 重新生成二维码再绑定。
- **交付**：告诉用户「手机已绑定，可以在任何网络下用 App 远程管理；电脑浏览器访问 https://<publicHost> 需要用你的邮箱登录。解绑设备在网页『设备授权管理』里操作。」

---

## 附：重入速查

| 现象 | 从哪步续 |
| --- | --- |
| `CHECK node-version` 不过 | 1.1 |
| `node_modules` 缺失 | 1.2 |
| `home-layout` 缺 `app/bin/agent-autoloop.ts` | 1.4 |
| `home-layout` 缺 `config.json` 或 owner 验证不过 | 1.5 |
| `home-layout` 缺 `rules.json` 或 `rules-draft` 不过 | 1.6 |
| `console-reachable` 不过 | 1.7 |
| 分档验证不过（≥ 2 个可写平台时） | 1.8 |
| `public-host` 不过 | 2.1 |
| Cloudflare token 验证不过 | 2.2 |
| `tunnel-config` / `public-reachable` 不过 | 2.3 |
| `access-blocks-anonymous` 不过 | 2.4（**最高优先级，立刻修**） |
| `mobile-api` 不过 | 2.6 |
