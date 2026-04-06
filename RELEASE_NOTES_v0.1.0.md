# MyClaw v0.1.0 Release Notes

发布日期：2026-04-06

## 概览

v0.1.0 是首个可用版本，提供 Gateway + Feishu Bridge + Copilot + Cron + Sync Server 的最小可用链路，并支持通过 Git Tag + Source Archive 方式分发源码产物。

## 主要能力

1. Gateway MVP
- WebSocket 接口：`/ws`
- 基础方法：`connect`、`health`、`send`、`agent`、`copilot`、`cron.*`

2. Feishu Bridge MVP
- 支持飞书 WebSocket 事件接入
- 文本消息处理与会话映射
- 支持处理中提示与错误回传

3. Copilot 工具链
- 通过 `gh copilot` CLI 非交互调用
- 可通过配置开关启用/禁用

4. Cron 子系统
- `cron.list/add/update/remove/run`
- 任务持久化、重启恢复、执行记录
- 支持 `at` / `every` / `cron` 三种调度

5. Sync REST Server
- 提供 `/health`、`/api/jobs`、`/api/runs`
- 支持同步任务快照与执行结果
- 启动时打印 LAN 可访问地址

## 本版本发布产物

1. Git Tag：`v0.1.0`
2. Source Archive：
- `myclaw-v0.1.0-source.tar.gz`
- `myclaw-v0.1.0-source.zip`

## 环境要求

- Node.js `>=22`
- npm `>=10`
- （可选）`gh` CLI（若使用 copilot 能力）

## 升级与兼容性

- 首次发布，无历史升级步骤。
- 当前版本为 MVP，默认配置偏开发环境。

## 已知限制

1. 非生产级安全默认值（例如 sync server 默认无鉴权）。
2. 任务与同步数据使用本地 JSON 文件存储。
3. 高并发和多实例协同能力未做完整生产化加固。

## 后续计划（建议）

1. 提供 Docker 化产物（Dockerfile + docker-compose）。
2. 为 sync server 增加鉴权（Bearer Token 或反向代理鉴权）。
3. 增加生产部署文档与监控告警建议。
