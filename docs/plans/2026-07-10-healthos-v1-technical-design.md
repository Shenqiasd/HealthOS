# HealthOS V1.0 正式产品技术设计

版本：v1.1-draft  
日期：2026-07-10  
状态：工程评审已完成，待产品负责人确认后进入 Task 0  
负责人视角：开发技术负责人

## 1. 结论

HealthOS V1.0 不再沿用当前“整屏设计图 + 透明热区”的原型实现。正式版本从绿地工程开始，现有四张高保真图片只作为视觉验收基线。

V1.0 的定义是一个可以服务真实用户、保存真实数据、持续运行和追责的完整产品：

```text
原生 iOS App
  + HealthKit 数据同步
  + 体检报告上传、解析与确认
  + Today / Coach / Map / Review 四个核心入口
  + 每日一个行动及反馈闭环
  + Food Risk Scan 风险标签与用户纠错
  + 周报生成、保存与隐私分享
  + iOS 通知及企业微信触达
  + 运营审核台
  + 规则、安全、审计、监控、数据导出和删除
  + TestFlight、预发布和正式生产环境
```

它不是 Demo，也不是把所有长期想法塞进第一版。完整指核心闭环在正常、缺数据、失败、拒绝授权和低置信度状态下都能工作，而不是功能数量无限扩张。

## 2. 依据与真相来源

本设计按以下优先级整合现有材料：

1. `HEALTHOS_V1_IOS_DESIGN_PLAN.md`：V1 iOS 的四入口、7 天闭环、状态矩阵和 MoMo 语气。
2. `healthos-v1-ios-prototype/design-targets/*.png`：Today、Coach、Map、Review 的视觉目标。
3. `healthos-v1-ios-prototype/AGENTS.md`：MoMo 形象一致性和四个入口各自的布局语法。
4. `~/.gstack/projects/HealthOS/ceo-plans/2026-06-18-china-gyroscope-metabolic-coach.md`：V0/V1/V2 分层范围和安全边界。
5. `~/.gstack/projects/HealthOS/pete-main-design-20260618-151417.md`：已确认的健康数据、审核、触达和测试决策。
6. `healthos-v1-ios-prototype/src/App.jsx`：仅证明当前原型是图片驱动，不作为正式代码基础。

## 3. V1.0 产品边界

### 3.1 必须交付

| 领域 | V1.0 完整能力 | 完成标准 |
|---|---|---|
| 账号 | Sign in with Apple、会话刷新、退出、注销、设备管理 | 用户换机后仍能恢复云端档案，注销后进入删除流程 |
| 同意 | 隐私协议、敏感健康数据单独同意、消息同意、版本记录 | 每项处理有版本、时间、来源和撤回记录 |
| HealthKit | 授权、增量同步、近 7 天重算、90 天 reconciliation、前台同步、尽力后台同步、数据新鲜度 | 部分授权、无数据、旧数据和历史修订均有明确降级行为 |
| 体检报告 | PDF/图片上传、OCR、字段证据、单位归一、用户确认、运营复核 | 未确认字段绝不驱动个性化建议 |
| 健康档案 | 目标、偏好、限制、已确认指标、关键事件、画像快照 | 所有影响建议的变化可追溯到事件和来源 |
| Today | 每日一个行动、原因、完成、减轻、替换、跳过、数据不足 | 所有反馈一键可达，下一次打开仍保持状态 |
| Coach | 基于档案的问答、解释、调整行动、快速回复、自由输入 | AI 不决定医学诊断，回答带数据边界与证据来源 |
| Map | 一次解释一个健康信号、趋势、可能驱动、置信度、返回 Today | 不演化成全指标仪表盘 |
| Review | 周结论、2-3 条证据、摩擦模式、下周 1-3 个行动、分享 | 数据覆盖不足时生成诚实的部分周报，不伪造结论 |
| Food Risk Scan | 拍照、菜品/饮品候选、风险标签、置信度、用户纠错 | 只给糖饮、酒精、高油、高嘌呤、精制碳水等风险标签 |
| 触达 | iOS 推送、企业微信摘要、账号绑定、退订、失败追踪 | 消息正文不含原始敏感指标，深链需登录验证 |
| 运营台 | 用户、报告确认、建议审核、失败重试、安全事件、规则发布 | 任何已发送建议可从来源重放到最终文本和反馈 |
| 安全 | 规则优先、结构化 AI 输出、禁用输出、固定 fallback、kill switch | 诊断、用药、停药、恐吓和极端行为建议必须被阻断 |
| 运维 | 日志、指标、追踪、告警、备份、恢复、审计、发布回滚 | 生产问题能定位到用户、运行、规则、模型和通道版本 |
| 发布 | CI、预发布、TestFlight、生产、迁移、回滚、App Store 资料 | 不依赖开发者电脑手工维持服务 |

### 3.2 明确不进入 V1.0

| 项目 | 原因 | 计划阶段 |
|---|---|---|
| Food XRAY 热量及宏量营养精确估算 | 中餐份量误差容易制造伪精确，需真实纠错数据 | V1.1/V2 |
| 四个公开健康分数 | 容易造成医学确定感，现阶段用信号状态和解释更诚实 | V2 |
| 个人微信非官方桥接作为生产主通道 | 封号、协议变化和隐私风险不可作为核心依赖 | 内部实验，V1.1 再评估 |
| 多渠道自动 fallback | 第一版只需要 iOS 推送 + 企业微信，避免消息重复 | V1.1 |
| 医疗诊断、药物建议、停药建议 | 产品定位和风险边界禁止 | 永久不做，除非进入独立持牌医疗体系 |
| 家庭成员档案 | 身份、授权和错发风险显著增加 | V2 |
| 医生、营养师、教练市场 | 这是另一套服务交付系统 | V2 |
| CGM、体脂秤等设备矩阵 | 先把 HealthKit 主链路做稳 | V2 |
| Android、小程序完整客户端 | V1.0 聚焦 iOS 主产品 | V2 |
| 公开社区和排行榜 | 与温柔监督和隐私定位冲突 | 不规划 |

### 3.3 发布方式

V1.0 代码按生产标准建设，但发布采用渐进式：

```text
内部开发账号 3-5 人
  -> TestFlight Alpha 5 人 / 14 天
  -> TestFlight Beta 20-50 人
  -> App Store 邀请制/小流量
  -> 满足安全和留存门槛后开放注册
```

### 3.4 M0 前置阻断门

以下工作在真实健康数据、第三方 AI/OCR 或通道开发前完成。它们不是发布前补文档，而是架构输入：

1. 完成数据清单、数据流图、个人信息保护影响评估和保留/删除表。
2. 明确 HealthOS 的医疗器械/健康管理服务定位、生成式 AI 义务、等保、ICP 和中国大陆 App 分发要求，并由合资格专业人员签字确认。
3. 对 Apple、APNs、企业微信、OCR、AI、错误追踪、备份和客服访问逐项记录数据区域、处理目的、字段、保留期和跨境路径。
4. 用合成数据做企业微信官方能力 spike，确认目标用户究竟是企业成员、外部联系人还是普通消费者，以及主动消息、回调、退订和身份绑定是否可行。
5. 完成 Apple entitlement、签名、HealthKit、Background Modes、APNs、Associated Domains、Privacy Manifest 和 App Privacy 初版审查。
6. 建立医学内容治理：适用/排除人群、禁忌、紧急固定文案、审核 SLA、规则双人审批和“本服务不实时监护”的清晰说明。

任一阻断门未通过，对应能力从 V1.0 移除或保持关闭，不能用非官方桥接或默认跨境传输绕过。

## 4. 用户闭环

### 4.1 首次使用

```text
安装 App
  -> Sign in with Apple
  -> 阅读并同意基础条款
  -> 单独同意敏感健康数据处理
  -> 选择当前最关心的 1-2 个目标
  -> HealthKit 分步授权
  -> 上传最近体检报告，或先跳过
  -> 完成一分钟限制条件问卷
  -> 生成首个低风险行动
  -> 进入 Today
```

首屏不强迫一次完成所有设置。没有体检报告时可以进入降级模式，但涉及体检指标的建议保持关闭。

### 4.2 每日闭环

```text
iOS 同步可用数据
  -> 后端归一化并生成 daily_signal_snapshot
  -> 规则引擎选择一个风险区域和行动族
  -> 安全引擎分类 normal / caution / doctor / blocked
  -> 可选 LLM 仅改写表达
  -> 输出重新经过结构和安全校验
  -> 生成不可变 recommendation_snapshot
  -> Today 展示并按同意设置触发通知/企微摘要
  -> 用户完成、减轻、替换或跳过
  -> feedback_event 写入
  -> 次日规则只读取已确认反馈
```

### 4.3 7 天闭环

```text
7 天 daily snapshots + action feedback + data coverage
  -> 周聚合
  -> 生成 weekly_review_snapshot
  -> Review 展示一条结论、2-3 条证据、摩擦模式
  -> 用户确认下周 1-3 个行动
  -> 可生成隐私版或完整私人版分享图
```

### 4.4 Coach 问答闭环

```text
用户消息
  -> 意图和风险分类
  ├─ 紧急/医疗高风险 -> 固定安全响应 + 人工队列
  ├─ 调整今日行动 -> 规则候选 + 用户确认 -> Today 更新
  ├─ 解释信号 -> 读取已发布 snapshot 和来源
  └─ 一般健康问题 -> 受限上下文 + 结构化 LLM 回答
        -> 输出安全检查
        -> 保存回答、来源和模型版本
```

任何对话都不能直接修改健康档案。档案变化必须转换为待确认事件，由用户或运营人员确认。

## 5. 总体架构

### 5.1 架构选择

采用模块化单体，不采用微服务。

理由：第一版的难点是安全边界、状态一致性和产品闭环，不是独立扩容。模块化单体让事务、审计、测试和小团队维护更直接，同时保留未来拆分 worker、AI 和 channel 模块的边界。

```text
┌──────────────────────── iOS App ────────────────────────┐
│ SwiftUI | HealthKit | SwiftData cache | Push | Share   │
└───────────────────────────┬─────────────────────────────┘
                            │ HTTPS / REST / OpenAPI
┌───────────────────────────▼─────────────────────────────┐
│                    HealthOS API                         │
│ Identity | Consent | Health | Labs | Profile | Actions │
│ Rules | Safety | Coach | Signals | Reviews | Channels  │
└───────────────┬───────────────────┬─────────────────────┘
                │                   │
       ┌────────▼────────┐  ┌───────▼─────────┐
       │ PostgreSQL      │  │ Object Storage │
       │ source of truth │  │ encrypted docs │
       └────────┬────────┘  └─────────────────┘
                │ transactional outbox
       ┌────────▼────────────────────────────────────────┐
       │ Worker                                          │
       │ sync projection | recommendation | review       │
       │ OCR/parser | push | WeCom | cleanup | alerts    │
       └────────┬───────────────┬────────────────────────┘
                │               │
       ┌────────▼───────┐ ┌─────▼──────────┐
       │ AI Provider    │ │ APNs / WeCom  │
       │ constrained    │ │ official APIs │
       └────────────────┘ └────────────────┘

┌────────────────────── Admin Web ────────────────────────┐
│ Review queue | lab evidence | safety incidents | ops   │
└───────────────────────────┬─────────────────────────────┘
                            └──── same API, admin RBAC
```

### 5.2 技术栈

| 层 | 推荐技术 | 选择理由 |
|---|---|---|
| iOS | Swift、SwiftUI、Observation、async/await、HealthKit、BackgroundTasks、UserNotifications、SwiftData | 原生 HealthKit 和系统体验最好，不把原型 WebView 化 |
| API | TypeScript 当前 LTS、NestJS、Fastify adapter、OpenAPI | 模块边界、验证、依赖注入和接口文档适合绿地团队 |
| Worker | 同一 NestJS 代码库的独立进程、PostgreSQL domain outbox/inbox + lease worker | 第一版低流量下避免数据库到 Redis 的双写丢任务，任务与业务事务同源持久化 |
| 数据库 | PostgreSQL、Prisma migrations | 事务、约束、JSONB、审计和团队可读性 |
| 对象存储 | S3 兼容对象存储 + KMS envelope encryption | 报告原件不放数据库，支持短期签名访问 |
| 管理台 | Next.js、TypeScript、React | 与后端共享类型和团队技能，界面以运营效率为主 |
| 合同 | OpenAPI 为唯一 API 合同，生成 Swift client | 防止 iOS 与后端各自猜字段 |
| AI | Provider adapter + structured output + eval suite | 可替换模型，规则和安全不绑定供应商 |
| 基础设施 | Docker、Terraform、GitHub Actions | 环境可重复，发布与回滚可审计 |
| 可观测性 | OpenTelemetry、集中日志、指标、错误追踪 | 一次日报从同步到发送拥有同一 correlation_id |

具体依赖版本在仓库初始化当天锁定。计划不依赖某个库的未发布能力。

### 5.3 部署区域

推荐默认：

- 开发环境：本机 Docker Compose，只使用合成数据。
- 预发布：可用 Railway，但禁止放入真实敏感健康数据和可还原身份的文档。
- 中国生产默认候选：腾讯云中国大陆区域，使用托管 PostgreSQL、COS、KMS 和容器服务；最终选择由 M0 数据与合规评估决定。
- 若公司主体、ICP 或数据合规结论不支持大陆生产，必须在真实用户进入前重新做区域 ADR，不可默认跨境传输。
- OCR/AI 供应商只有在区域、合同、子处理方、训练使用政策和字段级最小化通过评估后才能接收真实数据。未通过时只运行规则模板和人工确认。

## 6. 模块边界

| 模块 | 负责 | 不负责 |
|---|---|---|
| Identity | Apple 登录、会话、设备、管理员身份 | 健康档案内容 |
| Consent | 同意版本、撤回、导出/删除请求 | 业务建议 |
| Health Ingestion | 批量接收、去重、归一、数据覆盖和新鲜度 | 决定行动 |
| Labs | 文件、OCR、证据、单位、确认状态 | 直接输出诊断 |
| Profile | 目标、限制、已确认事实、事件和快照 | 原始文件存储 |
| Rules | 从可信输入选择风险区域和行动族 | 自由生成医疗文本 |
| Safety | 输出分类、禁用内容、固定 fallback、kill switch | 通道发送 |
| Recommendations | 生成运行、不可变快照、修订和发布状态 | 直接修改用户原始数据 |
| Actions | 今日任务和反馈状态机 | 长篇解释 |
| Coach | 意图路由、上下文、受限 AI 回答 | 无确认写档案 |
| Signals | Map 所需信号快照、趋势和解释来源 | 全量 dashboard |
| Reviews | 周聚合、报告快照、分享版本 | 运行时重算历史建议 |
| Channels | APNs、企业微信、绑定、outbox、delivery attempts | 决定发送内容是否安全 |
| Audit | 管理访问、规则发布、审核和安全事件 | 业务主状态 |

模块只能通过公开 service 接口或领域事件交互。禁止 Channels 重新运行规则，禁止 Coach 直接写 Profile projection。

## 7. 核心数据模型

### 7.1 身份与同意

| 表 | 关键字段 |
|---|---|
| `users` | `id`, `status`, `timezone`, `locale`, `created_at`, `deleted_at` |
| `user_identities` | `user_id`, `provider`, `provider_subject_hash`, `verified_at` |
| `devices` | `user_id`, `device_id`, `apns_token_encrypted`, `last_seen_at`, `app_version` |
| `consent_records` | `user_id`, `consent_type`, `document_version`, `granted`, `recorded_at`, `source` |
| `channel_accounts` | `user_id`, `channel`, `tenant_id`, `external_id_lookup_hmac`, `external_id_encrypted`, `consent_epoch`, `status`, `linked_at` |

### 7.2 健康数据与体检

| 表 | 关键字段 |
|---|---|
| `health_sync_runs` | `id`, `user_id`, `device_id`, `anchor_epoch`, `server_sequence`, `started_at`, `completed_at`, `status`, `correlation_id` |
| `daily_health_fact_revisions` | `id`, `user_id`, `local_date`, `metric`, `canonical_value_json`, `coverage`, `source_vector_json`, `input_hash`, `supersedes_id`, `created_at` |
| `current_daily_health_facts` | 当前生效 revision 的 projection/view，不覆盖历史事实 |
| `lab_documents` | `id`, `user_id`, `object_key`, `sha256`, `status`, `uploaded_at`, `deleted_at` |
| `lab_observations` | `document_id`, `code`, `value`, `unit`, `normalized_value`, `reference_range`, `page`, `evidence_box`, `confidence`, `confirmation_status` |
| `food_scans` | `id`, `user_id`, `object_key`, `captured_at`, `model_version`, `overall_confidence`, `status` |
| `food_risk_labels` | `food_scan_id`, `label`, `level`, `confidence`, `evidence`, `user_correction` |

`daily_health_fact_revisions` 存日级最小必要聚合及不可变历史，不默认上传每一个心率原始样本。需要原始片段的能力必须单独通过 ADR 和同意评审。

### 7.3 画像、规则和闭环

| 表 | 关键字段 |
|---|---|
| `profile_events` | `id`, `user_id`, `event_type`, `source`, `payload`, `correlation_id`, `occurred_at` |
| `profile_snapshots` | `id`, `user_id`, `version`, `facts_json`, `source_event_until`, `created_at` |
| `rule_bundles` | `id`, `version`, `status`, `content_hash`, `published_by`, `published_at` |
| `recommendation_runs` | `id`, `user_id`, `local_date`, `input_snapshot_id`, `rule_bundle_id`, `status`, `correlation_id` |
| `recommendation_snapshots` | `id`, `run_id`, `revision`, `risk_area`, `safety_class`, `action_code`, `rendered_payload_json`, `canonical_rule_input_json`, `provenance_json`, `review_status`, `supersedes_id` |
| `action_assignments` | `id`, `user_id`, `recommendation_snapshot_id`, `local_date`, `difficulty`, `status`, `replaced_by_id` |
| `feedback_events` | `id`, `action_assignment_id`, `type`, `reason_code`, `text`, `source`, `occurred_at` |
| `signal_snapshots` | `id`, `user_id`, `local_date`, `signal_code`, `state`, `trend`, `confidence`, `drivers_json`, `provenance_json` |
| `weekly_review_snapshots` | `id`, `user_id`, `week_start`, `coverage`, `conclusion`, `evidence_json`, `next_actions_json`, `provenance_json`, `revision` |

### 7.4 对话、触达和运营

| 表 | 关键字段 |
|---|---|
| `coach_threads` | `id`, `user_id`, `status`, `summary`, `summary_version` |
| `coach_messages` | `id`, `thread_id`, `role`, `intent`, `content`, `sources_json`, `safety_class`, `model_metadata`, `created_at` |
| `channel_outbox` | `id`, `user_id`, `channel`, `template`, `payload`, `idempotency_key`, `available_at`, `status` |
| `delivery_attempts` | `id`, `outbox_id`, `attempt`, `provider_message_id`, `status`, `error_code`, `sent_at` |
| `domain_outbox` | `id`, `event_type`, `aggregate_id`, `payload`, `idempotency_key`, `available_at`, `lease_until`, `status` |
| `consumer_inbox` | `consumer`, `message_id`, `processed_at`, `result_hash` |
| `review_tasks` | `id`, `task_type`, `subject_id`, `priority`, `status`, `assignee_id`, `sla_at` |
| `audit_logs` | `id`, `actor_id`, `action`, `resource_type`, `resource_id`, `before_hash`, `after_hash`, `created_at` |
| `safety_incidents` | `id`, `user_id`, `source`, `severity`, `status`, `details_encrypted`, `created_at` |

发布约束由受限的 publication service 在同一数据库事务中执行，并对关键不变量使用 trigger/constraint 辅助，不能假设跨表业务规则可由普通 `CHECK` 完成。外部通道标识使用 tenant-scoped HMAC 做唯一查找，密文只用于取回原值。

## 8. 领域状态机

### 8.1 今日行动

```text
proposed
  -> active
      ├─ completed
      ├─ skipped(reason)
      ├─ rejected(reason) -> replaced -> active(new action)
      └─ expired
```

约束：

- 同一用户同一本地日期最多一个 `active` 主行动。
- `completed` 不可改回 `active`，修正用新事件表达。
- `replaced` 保留原行动，周报可以解释摩擦，而不是删除历史。

### 8.2 体检指标

```text
extracted
  -> needs_confirmation
      ├─ user_confirmed -> reviewer_confirmed -> usable
      ├─ corrected -> needs_confirmation
      └─ rejected -> unusable
```

V1.0 中 `usable` 至少需要原报告证据和用户确认。对高风险或解析冲突字段，再要求运营复核。

### 8.3 建议发布

```text
draft
  -> safety_checked
      ├─ normal -> auto_publish or sampled_review
      ├─ caution -> review_required
      ├─ doctor -> fixed_fallback + review_task
      └─ blocked -> no_publish + incident/review
  -> published snapshot
  -> outbox
  -> sent / failed / suppressed
```

## 9. HealthKit 设计

### 9.1 V1.0 读取范围

- 步数、活动能量、运动分钟。
- 睡眠时长、睡眠区段、入睡/起床时间。
- 静息心率、HRV。
- 训练记录、训练类型、时长。
- 体重和 VO2 Max 作为可选趋势。

不默认请求与当前功能无关的权限。授权文案按功能分组说明价值。

### 9.2 同步策略

```text
App 启动/回前台
  -> 读取本地 anchor
  -> HKAnchoredObjectQuery 增量抓取
  -> 根据新增/删除样本定位受影响日期
  -> 重算受影响日期，并固定重算最近 7 天
  -> 批量上传，带 device_id + anchor_epoch + source vector + timezone
  -> 后端写不可变 fact revisions，分配 server_sequence
  -> 保存服务端确认结果

BGAppRefreshTask + observer delivery
  -> 尽力触发相同流程
  -> 不承诺每日一定后台运行
```

HealthKit 对某些权限无法可靠区分“用户拒绝”和“没有数据”。用户文案统一使用“当前不可用/尚未读取到”，避免虚假判断。

历史正确性规则：

- V1.0 每个账号只有一个 `primary_health_device` 可以上传 HealthKit；换机必须显式 handover 并触发重建。
- 本地保存加密 sample index：HealthKit UUID、类型、起止时间、source/product 和所在日期，用于处理 anchored query 返回的删除。
- 步数等累计量优先使用 HealthKit statistics/query 的去重语义，并为 iPhone、Watch 和第三方来源建立明确优先级；睡眠区段按重叠和跨日规则归一。
- 每次前台同步固定重算最近 7 天。每周或设备 handover 执行最近 90 天 reconciliation；删除无法定位日期时触发有界全量重建。
- 设备本地 revision 不用于跨设备比较。服务端为每次接受的事实 revision 分配 `server_sequence`，projection 由 source vector 和服务端顺序决定。

### 9.3 离线和冲突

- 本地 outbox 保存待上传日聚合，网络恢复后重试。
- 每个批次有 idempotency key。
- 同一日期产生新的不可变 fact revision，projection 指向当前 revision；历史推荐仍引用生成时的 revision。
- 后端建议只使用截止时间前最新可信 snapshot，迟到数据进入次日，不重发当天建议。

## 10. 体检报告和 Food Risk Scan

### 10.1 体检报告流水线

```text
App 请求预签名上传
  -> 直接上传对象存储
  -> 完成回调校验 sha256 / mime / size
  -> 病毒扫描
  -> OCR
  -> 结构化 parser
  -> 单位归一和字段映射
  -> 保存页码及 evidence_box
  -> App 展示原文证据和候选值
  -> 用户逐项确认/修正
  -> 必要字段进入运营复核
  -> profile_event + 新画像快照
```

所有 OCR 文本按不可信输入处理，不得进入系统提示词或工具参数。

### 10.2 Food Risk Scan

V1.0 输出示例：

```text
识别候选：红烧肉、米饭、奶茶
整体置信度：中
风险标签：
  - 含糖饮料：高
  - 高油：中
  - 精制碳水：中
  - 高嘌呤：未知
今日建议：先去掉奶茶，饭后走 12 分钟
```

用户可以改菜名、风险标签或标记“没拍全”。低置信度结果只做询问，不生成强建议。

## 11. 规则、安全和 AI

### 11.1 决策权顺序

```text
可信数据和用户限制
  -> 确定性规则选择风险区域
  -> 动作目录选择低风险行动
  -> 安全策略决定能否发布
  -> LLM 只做解释、语气和有限对话
  -> 输出再校验
```

LLM 无权：

- 选择或改变 `safety_class`。
- 添加新的药物、诊断、检查或治疗建议。
- 修改已确认体检值。
- 直接发送消息。
- 直接写入健康档案。

### 11.2 输出合同

```json
{
  "intent": "explain_action",
  "short_answer": "今天把饭后散步做短一点，12 分钟就够。",
  "reason": "昨晚睡眠偏短，今天的目标是保持活动但不过度消耗。",
  "action_code": "POST_MEAL_WALK",
  "safety_class": "normal",
  "source_ids": ["signal_snapshot_id"],
  "needs_human_review": false
}
```

服务端忽略模型返回的权限外字段，并验证 `action_code`、`safety_class` 和来源是否与规则输出一致。

### 11.3 自动化审核策略

- Alpha：所有建议都必须人工审核，任何等级都不自动发布。
- Beta：只有经过至少 100 次人工批准、零安全事件、固定动作目录和双人发布的 allowlisted `normal` 规则可以自动发布，且持续抽样至少 20%。
- 小流量正式版：是否扩大自动发布由规则级编辑率、安全事件、用户投诉和 reviewer 容量决定，不按时间自动解锁。
- `caution`：必须人工审核或使用完全固定模板。
- `doctor`：只允许固定安全模板，并创建高优先级审核任务。
- `blocked`：不发布，记录原因；若为系统越界，创建安全事件。

Coach 不向用户流式展示未完成的模型内容。模型结果必须完整缓冲、通过 schema、来源、禁用输出和安全分类校验后一次性显示。紧急/高风险输入不调用自由生成模型，只返回按地区配置的固定求助文案，并明确 HealthOS 不是实时监护服务。

适用性门禁至少覆盖：未成年人、孕期/备孕、已确诊严重肝肾/心血管疾病、糖尿病治疗、影响建议的用药、进食障碍风险、行动能力限制和急性症状。未通过门禁时只允许数据查看和固定安全路径。

### 11.4 安全 kill switches

- 全局停止所有主动消息。
- 按通道停止企业微信或 APNs。
- 停止 LLM，回退到规则模板。
- 停止某一规则 bundle。
- 按用户冻结建议，只保留数据查看。
- 停止报告分享链接。

## 12. 四个核心入口的工程合同

### 12.1 Today

API 返回一个 `TodayViewModel`，包含：

- 本地日期、数据新鲜度、覆盖率。
- MoMo 状态和文案 key，不直接把所有艺术文案写死在图片里。
- 唯一主行动、预计时长、原因、信号来源。
- `complete`, `lighter`, `swap`, `skip`, `why` 可用性。
- 当前状态和幂等版本。

App 必须缓存最后一个已发布 Today。网络失败时显示缓存、时间和只允许安全的本地反馈排队。

### 12.2 Coach

- 对话先显示短回答，再按需展开证据。
- 快速回复使用动词：“换轻一点”“为什么”“记下限制”“今天跳过”。
- 所有 AI 输出完整生成并校验后一次显示；等待状态由 MoMo 动效和可取消请求表达。
- 用户草稿在网络失败时保留。
- 回答来源只引用已确认档案、已发布 snapshot 和公开安全知识库条目。

### 12.3 Map

- 后端返回信号列表摘要和一个选中信号详情。
- 每个信号包含 `state`, `trend`, `confidence`, `freshness`, `drivers`, `today_action_link`。
- 客户端可以做空间布局，但不计算健康结论。
- 红色只用于真正的高风险固定流程，普通波动使用暖橙或中性色。

### 12.4 Review

- 周报是不可变 snapshot，打开页面不实时调用 LLM。
- 生成失败时可重试，不显示半生成结论。
- 分享默认生成去标识化版本，不含原始体检值、姓名、账号、精确时间。
- 私人保存版可以包含更多数据，但必须留在 App 沙盒或用户主动导出。

## 13. 企业微信和通知

### 13.1 V1.0 通道策略

- iOS 通知是系统级提醒通道。
- 企业微信只有在 M0 官方能力 spike 证明目标消费者身份、主动消息权限、回调、退订和账号生命周期可行后，才成为 Beta 通道。
- 若 spike 失败，V1.0 只发布 iOS 通知 + App 内 Coach；企业微信从发布阻断项移除，而不是换成个人微信非官方桥接。
- 个人微信桥接只在独立实验环境使用合成数据，不接生产数据库。

### 13.2 消息原则

企业微信正文只包含：

```text
MoMo 一句简短状态
今天一个行动
反馈入口或打开 App 深链
```

不包含原始尿酸、肝功、血糖等值。Universal Link 打开 App 后再次校验当前登录用户；未安装 App 时只进入无敏感信息的落地页。

### 13.3 Outbox 语义

- `idempotency_key = user + channel + message_type + local_date + snapshot_revision`，用于尽量去重，不承诺端到端 exactly-once。
- 所有内部异步任务和外部发送都由同一事务写 `domain_outbox`/`channel_outbox`；worker 使用 lease、consumer inbox、幂等 handler 和周期 reconciliation。
- 重试使用指数退避和最大次数。
- 已永久失败的消息进入运营台，不自动切换通道。
- webhook 按 provider event id 去重。
- 每次真正调用外部 provider 前，重新检查用户状态、consent epoch、channel binding epoch、退订和 kill switch。排队时的旧同意不够。
- provider 已发送但进程在落库前崩溃时标记 `unknown_after_send`。使用 provider 支持的 collapse/dedup key；不支持时由运营确认，避免盲目重发。

## 14. 运营审核台

V1.0 管理台不是健康杂志，目标是低错误率和高处理速度。

必须包含：

1. 登录、MFA、角色权限和会话审计。
2. 用户概览和数据新鲜度，不显示不必要的完整原始文件。
3. 体检字段证据对照、修正、确认和冲突提示。
4. 建议队列：原始规则结果、AI 改写、来源、风险等级、批准/编辑/拒绝。
5. 编辑必须填写原因，原稿和发送稿同时保留。
6. 消息失败、同步失败、周报失败和 SLA 队列。
7. 规则 bundle 发布、回滚和 kill switch。
8. 安全事件列表和处置记录。
9. 数据导出、删除请求的双人确认。

审核运营合同：

- Alpha 每一条建议人工审核；Beta 审核所有 `caution/doctor/blocked`、所有新规则首批输出和至少 20% allowlisted `normal` 抽样。
- 日建议审核时段和 reviewer/backup 值班表必须可见。错过审核截止的建议被抑制或使用固定模板，不自动越过队列。
- `doctor` 固定文案即时说明求助路径，但人工后续承诺按工作时段和 SLA 表达，绝不暗示实时值守。
- Beta 前用 2 倍预计峰值做容量演练：100 条日建议、30 条需关注反馈、20 个报告字段复核。队列必须在约定窗口内清空，峰值利用率低于 70%，backup 能接管。

## 15. 隐私和安全

### 15.1 数据最小化

- 只上传支持当前功能的日级 HealthKit 聚合。
- 报告原件和身份信息分开存储及授权。
- 推送、企业微信、分析和错误追踪禁止发送敏感正文。
- 第三方 AI 默认只接收完成任务所需的最小结构化上下文，不发送原报告文件。

### 15.2 访问控制

- 用户 API 使用短期 access token + 旋转 refresh token，refresh token 存 Keychain。
- iOS 使用 App Attest/DeviceCheck 风险信号，不能把它当唯一认证。
- 管理员使用独立身份域、MFA、最小角色权限和 IP/设备策略。
- 任何读取报告原件、修改确认指标或查看安全事件的操作写审计日志。

### 15.3 加密和密钥

- 全链路 TLS。
- 数据库和对象存储静态加密。
- 外部身份、通道标识、报告文件 key 和自由文本安全事件使用应用层 envelope encryption。
- 密钥由云 KMS 管理，环境变量不保存主密钥。

### 15.4 用户权利

- App 内可撤回消息、HealthKit 和数据处理同意。
- 提供机器可读导出。
- 删除请求立即冻结处理，后台按保留政策清理，完成后向用户确认。
- 法律要求保留的审计记录与用户内容分离并去标识化。
- 删除完成后写入独立、最小化的 deletion tombstone。备份恢复后先执行 consent/delete/outbox reconciliation，系统在完成前处于 no-send 模式，防止复活已删除用户或撤回同意后的旧消息。

## 16. 可观测性和 SLO

### 16.1 关键指标

- HealthKit 同步成功率、数据新鲜度、授权覆盖率。
- recommendation run 成功率、平均耗时、各安全等级比例。
- AI schema 失败率、安全拦截率、fallback 率。
- Today 打开率、行动完成/减轻/替换/跳过率。
- 周报生成和打开率。
- APNs/企微发送成功率、延迟、永久失败。
- 体检 OCR 置信度、字段级 precision/recall、abstention、用户修正率、审核 SLA。
- 账号错绑、未授权访问和安全事件数。

### 16.2 V1.0 SLO

| 指标 | 目标 |
|---|---:|
| API 月可用性 | 99.9% |
| Today 缓存首屏 | p95 < 800 ms |
| Today 在线刷新 | p95 < 2 s，不含 HealthKit 本地查询 |
| 普通 Coach 回答 | p95 < 8 s |
| 日建议按计划生成 | 99% 在 15 分钟窗口内完成 |
| 通道发送成功 | >= 99%，按已同意且 provider 接受发送的消息为分母；`unknown_after_send` 单列 |
| 周报按周生成 | >= 99% |
| 未授权健康数据访问 | 0 |
| 禁用医疗输出被发送 | 0 |

每个关键流水线使用同一个 `correlation_id`，从 iOS sync run 贯穿到 recommendation、outbox、delivery 和 feedback。每个指标在 `docs/product/metrics-contract.md` 定义分子、分母、观察窗口、排除项、最小样本和数据延迟，未定义的指标不能作为发布门槛。

## 17. 性能策略

- Today、Map、Review 均读取已发布 snapshot，禁止打开页面时重跑规则或 LLM。
- iOS 启动先读本地缓存，再并发刷新账号、Today 和数据新鲜度。
- HealthKit 上传按日期和 metric 批量，不逐样本请求。
- 周报和分享图异步生成，客户端轮询或通过推送获知完成。
- 数据库常用索引以 `user_id + local_date/week_start + status` 为主。
- 管理台列表必须 cursor pagination，禁止加载全部用户。
- 报告文件和分享图走 CDN/签名 URL，原文件不公开缓存。

## 18. 测试战略

### 18.1 测试层级

| 层 | 目标 |
|---|---|
| Domain unit | 规则、状态机、单位归一、置信度和安全策略 100% 分支覆盖 |
| API integration | 数据库约束、幂等、权限、事务、outbox 和对象存储合同 |
| Golden cases | 至少 50 个健康场景，固定输入、动作、禁用输出和用户文案边界 |
| LLM eval | 全部 golden cases + 至少 30 个越界/注入/低置信度对抗案例 |
| iOS unit | HealthKit 聚合、缓存、view state、offline outbox、deep link |
| iOS UI | 首次使用、Today 反馈、Coach、Map、Review、权限和错误状态 |
| Admin integration | 体检确认、审核历史、规则回滚、删除双确认 |
| E2E | D0、D1、D3 摩擦、D7 周报、账号绑定、错用户访问拒绝 |
| Visual regression | 390x844 基线、动态字体、深浅对比、主要状态截图 |
| Security | IDOR、过期 token、重放、文件上传、管理员权限、prompt injection |
| Performance | Today 读取、日任务批量、周报批量、通道队列和 100 用户峰值 |

### 18.2 关键覆盖图

```text
D0 [E2E]
Sign in -> Consent -> HealthKit -> Lab upload -> Confirm -> First Today
   |          |           |             |            |
 auth fail  withdraw   partial       parse fail    no usable data

D1 [E2E + EVAL]
Sync -> Facts -> Rules -> Safety -> AI rewrite -> Snapshot -> Delivery -> Feedback
  |       |       |        |          |             |          |
 stale  conflict no rule  blocked   schema fail   send fail   duplicate tap

D3 [E2E]
Reject action -> reason -> lighter replacement -> Today update -> Review remembers friction

D7 [E2E]
Aggregate -> coverage gate -> weekly snapshot -> share variant -> next actions
   |              |               |             |
 late data     partial week   generation fail  privacy variant
```

任何路径如果既没有测试、又没有错误处理、且用户看不到失败，视为发布阻断。

数据能力的最低验证规模：

- Labs：至少 100 份经过同意和去标识化的报告，覆盖明确列出的机构/格式；每个支持字段有医学 reviewer 审核的 unit/range corpus，高置信度结果 precision >= 98%，其余必须 abstain 或人工确认。
- Food Risk Scan：至少 300 张经同意的中国餐食图片，按饮品、酒精、高油、精制碳水和高嘌呤不确定性分层；高置信度风险标签 precision >= 90%，未达标则该标签或整个功能保持 feature flag 关闭。

## 19. CI/CD 与环境

### 19.1 环境

| 环境 | 数据 | 用途 |
|---|---|---|
| local | 合成/匿名 fixture | 开发和单元测试 |
| test | 临时数据库 | CI 集成测试 |
| staging | 合成 + 明确同意的内部数据 | E2E、通道 sandbox、TestFlight 内测 |
| production | 真实用户 | 小流量正式服务 |

M0 即建立 production-like 安全基线和 App Store 合规工作流。后续安全加固是验证和补强，不是第一次做 threat model、数据清单或 KMS/网络设计。

### 19.2 PR 门禁

- TypeScript lint、类型检查、单元和集成测试。
- Swift format/lint、build、unit 和 UI smoke tests。
- OpenAPI 破坏性变更检查。
- Prisma migration 校验和回滚说明。
- Golden cases 和 LLM eval 回归。
- 依赖漏洞、secret 和 IaC 扫描。
- 管理台和 iOS 关键页面截图差异。

### 19.3 发布顺序

```text
合并主分支
  -> 构建不可变镜像
  -> staging 数据库迁移
  -> staging smoke + E2E + eval
  -> 人工批准
  -> production 向后兼容迁移
  -> API/worker canary
  -> TestFlight/App Store build
  -> 监控 30 分钟
  -> 扩大流量或回滚
```

## 20. 发布门槛

### 20.1 Feature Complete

- 四个入口均使用真实组件和 API，不再渲染整屏图片。
- 八类状态均可在测试数据下复现。
- D0、D1、D3、D7 E2E 全通过。
- 50 个 golden cases 和 30 个安全对抗案例通过。
- APNs 在 staging 连续 7 天无错绑；企业微信只有在 M0 feasibility gate 通过时才应用同一门槛。
- Labs/Food 达到各自 corpus 和 abstention 门槛，否则功能保持关闭，不阻挡其他核心闭环 Beta。

### 20.2 TestFlight Beta

- 5 个内部用户连续 14 天同步成功率 >= 90%。
- 报告确认流程跑通 20 份不同来源文件。
- 所有 P0/P1 缺陷关闭。
- 恢复演练在 RPO 24h、RTO 4h 内完成。
- 医疗 reviewer、backup、值班和事故联系人已明确。
- 隐私、同意、App Store disclosure 和数据区域已完成审查。

### 20.3 App Store 小流量

- 20-50 人 Beta 连续健康顾问周数达到既定门槛。
- 禁用医疗输出发送为 0。
- 账号错绑和未授权访问为 0。
- 主要流水线 SLO 连续 4 周达标。
- 人工审核比例和运营成本可承受。
- 删除、导出和通道退订均经过真实演练。

## 21. 里程碑和团队

### 21.1 推荐团队

- 1 名技术负责人，兼架构和后端核心。
- 1 名后端工程师。
- 2 名 iOS 工程师。
- 1 名 Web/全栈工程师，负责运营台。
- 1 名产品设计师，负责正式组件和 MoMo 资产系统。
- 1 名 QA/SDET。
- 1 名医学内容 reviewer + 1 名 backup，兼职即可但必须具名。

reviewer 是否能兼职由 Task 20 容量演练决定。若 2 倍峰值下利用率超过 70%、队列错过 SLA 或 backup 无法接管，必须增加排班或缩小 Beta，而不是降低审核覆盖。

### 21.2 现实工期

| 团队 | 预计时间 | 说明 |
|---|---:|---|
| 上述 6 人工程/设计/QA 团队 | 14-16 周到内部 Alpha；22-26 周到生产就绪 | 后半段包含 14 天 Alpha、20-50 人 Beta、修复和至少 4 周 SLO 观察 |
| 3 人小队：1 iOS + 1 后端 + 1 全栈 | 30-36 周到生产就绪 | 运营台、视觉、合规和验证会成为瓶颈 |
| 单人全栈 | 不建议承诺日期 | HealthKit、iOS、后端、安全和运营并非一个可验证的单线程任务 |

### 21.3 里程碑

| 里程碑 | 周期 | 可验收结果 |
|---|---:|---|
| M0 技术地基 | W1-W2 | 仓库、环境、CI、API 合同、认证、数据库、设计 token |
| M1 数据纵切 | W3-W5 | 真机 HealthKit -> 后端 -> Today 数据新鲜度完整跑通 |
| M2 顾问闭环 | W6-W8 | 体检确认、规则、安全、Today 行动和反馈跑通 |
| M3 V1 功能完整 | W9-W11 | Coach、Map、Review、Food Risk Scan、分享、触达、运营台 |
| M4 工程硬化 | W12-W13 | E2E、eval、安全、性能、迁移、备份、可访问性 |
| M5 Alpha | W14-W16 | 5 人 14 天内部 Alpha，修完 P0/P1 |
| M6 Beta 与生产就绪 | W17-W26 | 20-50 人 Beta、App 审查、修复、四周 SLO 观察和小流量决策 |

## 22. 并行开发策略

### 22.1 依赖表

| 工作流 | 主要目录 | 依赖 |
|---|---|---|
| Foundation | `apps/api`, `packages/contracts`, `infra` | 无 |
| iOS shell/design system | `apps/ios` | API contract 初稿 |
| Identity/Consent | `apps/api`, `apps/ios` | Foundation |
| HealthKit/Ingestion | `apps/ios`, `apps/api/src/health` | Identity |
| Labs/Profile | `apps/api/src/labs`, `apps/admin`, `apps/ios` | Identity、object storage |
| Rules/Safety | `packages/rules`, `packages/evals` | 数据合同 |
| Today/Actions | `apps/api/src/actions`, `apps/ios` | Health、Rules |
| Coach | `apps/api/src/coach`, `apps/ios` | Profile、Safety、Today |
| Map/Review | `apps/api/src/signals`, `apps/api/src/reviews`, `apps/ios` | Snapshots、Actions |
| Channels | `apps/api/src/channels`, `apps/worker` | Identity、published snapshots |
| Admin/Ops | `apps/admin`, admin API | Labs、Recommendations、Audit |
| QA/Release | `e2e`, `packages/evals`, `infra` | 各纵切可逐步接入 |

### 22.2 泳道

```text
Lane A: Foundation -> Identity -> Health ingestion -> Rules -> Recommendation pipeline
Lane B: iOS shell -> HealthKit -> Today -> Coach -> Map/Review
Lane C: Admin shell -> Lab confirmation -> Recommendation review -> Ops/safety
Lane D: Contract tests -> Golden cases/evals -> E2E -> Performance/security
Lane E: Channel sandbox -> WeCom/APNs -> Delivery observability
```

W1-W2 由 Lane A 先产出合同，B/C/D 同时搭框架。W3 起 A+B+C+D 并行，E 在身份和 snapshot 合同稳定后接入。

冲突点：

- iOS 和 API 都依赖 OpenAPI，合同只能由指定 owner 合并。
- Rules、Safety、Evals 共享 fixture，由同一 owner 维护 schema。
- Identity 被 HealthKit、Labs 和 Channels 同时依赖，W2 后冻结 V1 主键和绑定合同。

## 23. 失败模式

| 路径 | 真实失败 | 测试 | 处理 | 用户结果 |
|---|---|---|---|---|
| HealthKit | 后台未运行、旧样本删除、来源重叠、换机 | unit + 真机 E2E | sample index、近 7 天重算、90 天 reconciliation、primary device handover | 看到同步/重建状态，不使用不可信事实 |
| 日聚合 | 时区变化或重复批次 | integration | 幂等 key + source revision | 不重复生成行动 |
| 体检 OCR | 单位错、页码错、低置信度 | golden fixtures | 证据对照和确认门 | 不确认则不使用 |
| Rule | 无匹配、冲突规则 | unit + golden | 数据不足或保守 fallback | 不硬给建议 |
| LLM | 超时、schema 错、越界 | eval + fault injection | 模板回退或阻断 | 不显示半截危险回答 |
| Reviewer | SLA 超时 | integration | normal 可按策略发布，caution/doctor 不发布 | 明确延迟，不静默发送 |
| Today feedback | 连点或离线 | UI + integration | 本地 outbox、幂等版本 | 只记录一次，可稍后同步 |
| Weekly review | 数据不足或任务失败 | E2E | 部分报告或重试 | 不伪造完整结论 |
| WeCom/APNs | 能力不适用、限流、退订、错绑、发送后崩溃 | feasibility + adapter + E2E | iOS fallback、send-time consent、unknown_after_send、抑制、运营告警 | 不跨用户发送，必要时不启用 WeCom |
| Deep link | token 过期或换账号 | security E2E | 登录后资源级授权 | 拒绝访问，不泄露摘要 |
| 删除 | worker 部分失败 | integration + runbook | 可重入删除状态机 | 用户可看到处理中/完成 |

允许的关键静默失败：0。

## 24. 风险清单

| 风险 | 严重度 | 缓解 |
|---|---|---|
| 产品建议太泛 | P0 | 50 个 golden cases、真实 reviewer 编辑率、一个行动约束 |
| 医疗越界 | P0 | 规则优先、固定边界、eval、审核、kill switch |
| HealthKit 后台不可靠 | P0 | 前台同步为可靠路径、显示 freshness、通知引导打开 |
| 体检解析错误 | P0 | 原文证据、用户确认、单位校验、运营复核 |
| 微信通道能力不适用、受限或封禁 | P0 | 先过官方能力闸门；失败则 V1 只用 iOS，个人桥接隔离 |
| 敏感数据错发 | P0 | 消息最小化、绑定 E2E、资源级授权、禁止多通道 fallback |
| MoMo 形象漂移 | P1 | 统一 asset manifest、姿势/解剖 QA、同一导航头像 |
| 原型精美但正式组件粗糙 | P1 | 组件 token、视觉回归、设计签收，不直接切整屏图片 |
| 运营成本失控 | P1 | 风险分层审核、编辑率指标、抽样 normal |
| 架构过早平台化 | P1 | 模块化单体、一个数据库、一个 API、一个 worker |

## 25. 已存在与复用决定

| 已存在资产 | 决定 |
|---|---|
| 四张高保真设计图 | 用作视觉基线和内容层级参考，不作为运行时整屏图片 |
| MoMo 视觉资产 | 先建立正式 asset manifest，再挑选可复用素材；不直接混用不同版本 |
| React/Vite 原型 | 保留为设计预览，不迁入正式 iOS 代码 |
| V1 iOS Design Plan | 作为交互、状态、语气和布局语法来源 |
| V0/V1/V2 PRD | 复用安全、数据和触达边界；由本文件重新定义正式 V1.0 |
| V0 golden-case test plan | 扩展为 V1.0 的 50 个 golden cases 和 30 个对抗 eval |
| `TODOS.md` | 后续按本文件新阶段重新整理，不在本计划中静默删除旧项 |

## 26. 开工前必须确认的四项责任，不是技术悬念

技术方案已经给出默认值，以下是组织责任，必须在对应阶段具名：

1. 生产数据区域和法律/隐私审核负责人，Task 0/M0 开始前确认。
2. 医学内容 reviewer 和 backup，真实健康建议测试前确认。
3. 企业微信主体、目标用户身份模型、应用和 API 管理员，M0 feasibility spike 前确认。
4. Apple Developer、App Store Connect、entitlement、隐私材料和大陆分发负责人，M0 开始前确认。

这些事项不阻挡 M0 搭建，但缺任一项都阻挡真实用户进入。

## 27. 技术负责人签收标准

只有同时满足以下条件，才可以把 HealthOS V1.0 称为“完成”：

- 用户在真机上经历 D0、D1、D3、D7，不需要开发人员改数据库。
- 所有状态来自真实组件和状态机，不是整屏截图或硬编码演示数据。
- 关键健康结论能追溯到数据、规则、模型、审核和版本。
- 数据不足、AI 失败、通道失败、用户拒绝和权限撤回都能恢复。
- 真实数据不出现在日志、推送或错误追踪。
- 自动化测试覆盖关键分支，发布可回滚，备份可恢复。
- 运营人员能处理报告、建议、失败和安全事件。
- 视觉实现通过正式设计验收，MoMo 形象一致，动态字体和辅助功能可用。
- 20-50 人 Beta 证明系统能连续运行至少两周。

这才是第一版产品。四张漂亮页面，只是开始。
