# Alimbo Installation Skill

## 目标

本技能用于指导不同类型的 agent 在本机完成 alimbo 的安装、启动与最小验证。

适用对象：
- 终端执行型 agent（能执行 shell 命令）
- IDE 自动化 agent（Copilot/Cursor/Claude Code 等）
- CI/CD agent（非交互流水线）
- 全局 CLI 使用场景

## 统一前置条件

1. 操作系统：macOS/Linux（Windows 需自行替换命令）
2. Node.js: >= 22
3. npm: >= 10
4. 网络可访问 npm registry

建议先检查：

```bash
node -v
npm -v
```

## 安装路径总览

1. 源码安装（推荐开发）
2. 全局安装（适合最终用户）
3. CI 无交互安装（适合流水线）

---

## 路径 A：源码安装（开发型 agent 默认选这个）

### A1. 获取代码并进入目录

```bash
git clone <repo-url> alimbo
cd alimbo
```

### A2. 安装依赖

```bash
npm install
```

### A3. 初始化环境变量

```bash
cp .env.example .env
```

最小必改项：
- GATEWAY_TOKEN（强烈建议替换默认 dev-token）

### A4. 启动服务

网关：

```bash
npm start
```

可选子服务：

```bash
npm run cloud
npm run bridge:feishu
```

### A5. 最小验收

```bash
curl http://127.0.0.1:18789/health
```

如果启动了 cloud：

```bash
curl http://127.0.0.1:18790/health
```

成功标准：返回 JSON，包含 ok=true。

---

## 路径 B：全局安装（用户型 agent）

适用于已发布 npm 包后。

### B1. 全局安装

```bash
npm i -g alimbo
```

### B2. 验证版本与命令

```bash
alimbo --version
alimbo --help
```

### B3. 运行

```bash
alimbo start
alimbo cloud
alimbo bridge:feishu
```

说明：
- 全局模式下仍依赖当前工作目录的 .env。
- 建议在目标项目目录执行上述命令。

---

## 路径 C：CI/CD 安装（流水线 agent）

### C1. 安装依赖并构建

```bash
npm ci
npm run build
```

### C2. 注入环境变量

CI 中以密钥系统注入，至少提供：
- GATEWAY_TOKEN

### C3. 冒烟测试

```bash
node dist/index.js &
sleep 2
curl -f http://127.0.0.1:18789/health
```

可选：

```bash
node dist/cloud/intercept-server.js &
sleep 2
curl -f http://127.0.0.1:18790/health
```

---

## 各类 agent 执行策略

### 1) Copilot/Cursor/Claude Code（可执行终端）

推荐流程：
1. 走路径 A
2. 如果仅验证发布包，再补路径 B
3. 执行健康检查后再进行功能测试

### 2) 只读评审 agent（不可执行命令）

输出检查清单，不直接安装：
1. package.json engines.node 是否 >=22
2. scripts 是否包含 start、cloud、bridge:feishu
3. .env.example 是否存在且含 PORT/GATEWAY_TOKEN
4. README 安装命令是否与 scripts 一致

### 3) CI agent

固定走路径 C，优先 npm ci，禁止使用交互命令。

---

## 故障排查

1. npm install 失败：检查 Node 版本与网络代理。
2. npm start 失败：先执行 npm run build 查看 TS 构建错误。
3. 18789 端口占用：修改 PORT 或结束旧进程。
4. cloud 启动后页面缺失：确认 postbuild 已复制 dist/cloud/intercept-approval.html。

## 安全建议

1. 生产环境必须替换默认 GATEWAY_TOKEN。
2. 不要把 .env 提交到仓库。
3. 对外暴露前请配置反向代理与访问控制。

## Agent 输出模板（建议）

安装完成后，agent 应至少输出：
1. 使用的安装路径（A/B/C）
2. 执行过的关键命令
3. health 检查结果
4. 下一步建议（如是否启用 cloud/feishu）
