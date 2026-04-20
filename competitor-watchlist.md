# MyClaw Competitor Watchlist

> 用途：持续跟踪 myclaw 所处的 **AI gateway / agent runtime / workflow orchestration** 赛道，重点看定价、版本演进、功能发布和团队扩张信号。

## 直接竞品

| 产品 | 判断依据 | 官网 | 定价页 | 更新日志 / Release | 新功能公告 | 招聘动态 | 监控优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OpenClaw | 与 myclaw 最接近，都是个人/团队 AI assistant + gateway/skill 生态叙事 | [openclaw.ai](https://openclaw.ai) | 暂未发现独立定价页，先盯 [官网首页](https://openclaw.ai) | [GitHub Releases](https://github.com/openclaw/openclaw/releases) | [Blog](https://openclaw.ai/blog) | 暂未发现独立招聘页，先盯 [官网博客](https://openclaw.ai/blog) 与 [GitHub Org](https://github.com/openclaw) | **高** |
| OpenHands | AI-driven development，定位覆盖 agent 执行、工具调用、代码修改与任务闭环 | [openhands.dev](https://openhands.dev) | [Pricing](https://www.all-hands.dev/pricing) | [GitHub Releases](https://github.com/OpenHands/OpenHands/releases) | [Blog](https://www.all-hands.dev/blog) | [Careers](https://www.all-hands.dev/careers) | **高** |
| Goose | 开源可扩展 AI agent，强调安装、执行、编辑、测试的完整链路 | [goose-docs.ai](https://goose-docs.ai/) | 暂未发现独立定价页，先盯 [Docs 首页](https://goose-docs.ai/) | [GitHub Releases](https://github.com/aaif-goose/goose/releases) | [GitHub Repo](https://github.com/aaif-goose/goose) | [Block Careers](https://block.xyz/careers) | **中高** |
| Open Interpreter | 自然语言操作本机/终端的代表产品，和 myclaw 在“本地工具执行 + agent”方向高度重叠 | [openinterpreter.com](https://www.openinterpreter.com/) | 暂未发现独立定价页，先盯 [官网首页](https://www.openinterpreter.com/) | [GitHub Releases](https://github.com/openinterpreter/open-interpreter/releases) | [GitHub Repo](https://github.com/openinterpreter/open-interpreter) | 暂未发现独立招聘页，先盯 [GitHub Org](https://github.com/openinterpreter) | **中高** |

## 间接竞品

| 产品 | 判断依据 | 官网 | 定价页 | 更新日志 / Release | 新功能公告 | 招聘动态 | 监控优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Dify | 更偏平台层，但在 agent workflow、模型接入、插件生态上与 myclaw 争夺相同预算和场景 | [dify.ai](https://dify.ai) | [Pricing](https://dify.ai/pricing) | [GitHub Releases](https://github.com/langgenius/dify/releases) | [Blog](https://dify.ai/blog) | 暂未发现独立招聘页，先盯 [GitHub Org](https://github.com/langgenius) | **高** |
| Flowise | 可视化 agent/workflow 平台，间接替代 myclaw 的编排与集成能力 | [flowiseai.com](https://flowiseai.com) | [Pricing](https://flowiseai.com/pricing) | [GitHub Releases](https://github.com/FlowiseAI/Flowise/releases) | [GitHub Repo](https://github.com/FlowiseAI/Flowise) | 暂未发现独立招聘页，先盯 [GitHub Org](https://github.com/FlowiseAI) | **中** |
| n8n | 原本是自动化平台，但 AI agent、human-in-the-loop、observability 已切入同一企业预算池 | [n8n.io](https://n8n.io) | [Pricing](https://n8n.io/pricing) | [GitHub Releases](https://github.com/n8n-io/n8n/releases) | [Blog](https://n8n.io/blog) | [Careers](https://n8n.io/careers) | **中高** |

## 重点监控项

| 维度 | 重点看什么 | 对 myclaw 的意义 |
| --- | --- | --- |
| 定价页 | 是否出现按 seat、按调用量、按 workspace、按 self-host/enterprise 分层；是否新增免费层/团队版 | 直接影响 myclaw 的商业化包装、版本分层和部署策略 |
| 更新日志 | 是否新增 MCP、工具权限、session 持久化、多代理协作、可观测性、审计、安全控制 | 这些都是 myclaw 的核心差异化或防御点 |
| 新功能公告 | 是否强化 Slack/Discord/飞书/CLI/IDE 集成，是否推出 hosted/cloud、marketplace、plugin/skill 生态 | 用于判断 myclaw 是否需要优先补 bridge、生态和分发能力 |
| 招聘动态 | 是否集中招聘 platform engineer、infra、DevRel、solutions engineer、product marketing | 团队招聘方向往往领先于产品路线，可提前感知竞品下注重点 |

## 建议的跟踪节奏

1. **每周一次**：扫官网博客、GitHub Releases、产品主页。
2. **每月一次**：复核定价页变化，记录是否新增套餐、企业能力、合规卖点。
3. **持续关注**：招聘页和 GitHub 组织活跃度，作为产品加速或商业化拐点信号。

## 备注

- 对很多开源项目而言，**GitHub Releases + 官方博客** 往往比独立 changelog 更可靠。
- 对暂未公开招聘页的项目，建议补充关注其 **GitHub Org、LinkedIn 公司页、创始人 X/Blog**。
- 如果后续 myclaw 明确主打 **飞书桥接 + Copilot gateway + MCP 管理**，可把竞品清单再细分成「开发者代理」「企业工作流」「中国 IM 集成」三条子赛道。
