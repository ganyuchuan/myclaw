# MyClaw v0.2.0 Release Notes

发布日期：2026-04-06

## 版本概览

v0.2.0 聚焦飞书侧多模态能力与会话一致性：新增图片与文件消息处理、Markdown 回发渲染，以及统一的 Copilot 共享会话复用机制。

## 主要更新

1. Feishu 图片消息处理（真图片链路）
- 支持 `message_type=image`
- 自动下载图片到本地临时目录
- 将图片路径与元信息传给 copilot
- 执行后自动清理临时文件

2. Feishu 文件消息处理
- 支持 `message_type=file`
- 下载文件后对 `md/markdown/txt` 读取文本并传给 copilot
- 对非文本文件传递路径与元信息，给出可执行建议
- 支持文件大小与文本截断上限配置

3. 飞书 Markdown 渲染回发
- 新增 `FEISHU_REPLY_MARKDOWN`
- 回发时可使用 `interactive + markdown` 卡片渲染

4. Copilot 会话复用统一化
- 新增 `COPILOT_REUSE_SESSION`
- 从按 job 复用改为进程内共享 session 复用
- gateway 与 cron 路径统一会话策略

5. Copilot 执行日志增强
- 每次调用记录完整 `gh copilot` 参数
- 输出耗时、退出状态、stdout 大小，便于定位问题

## 新增配置项

- `FEISHU_REPLY_MARKDOWN`
- `FEISHU_FILE_TEMP_DIR`
- `FEISHU_FILE_MAX_BYTES`
- `FEISHU_FILE_MAX_TEXT_CHARS`
- `COPILOT_REUSE_SESSION`

## 兼容性说明

- Node.js 要求保持 `>=22`
- 旧配置可继续运行；新增配置均提供默认值

## 发布产物

- Tag: `v0.2.0`
- Source Archive:
  - `myclaw-v0.2.0-source.tar.gz`
  - `myclaw-v0.2.0-source.zip`
