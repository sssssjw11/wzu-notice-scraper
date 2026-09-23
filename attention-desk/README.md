# Attention Desk

本地 Web 工作台，把微信群导出的 `messages.json` 变成按 P0–P3 排序的注意力队列。

也可以在设置中选择“本机微信”。工作台优先发现并使用已经安装的
`weflow-cli` / CipherTalk 导出器，按“列会话 → 导出 JSON → 转换联系人包”的方式
读取指定群；如果本机没有导出器，则回退到 `vendor/wechat-decrypt/config.json`
指向的兼容解密 SQLite。两条路径都会在分拣前生成同一格式的本地联系人包，入口只读，
不会操作或发送微信消息。

## 运行

```powershell
cd attention-desk
.\start.ps1 -Install
```

打开 Vite 输出的本地地址（默认 `http://127.0.0.1:5173`）。后端 API 在 `http://127.0.0.1:8765`。
端口被占用时可用 `-WebPort` 和 `-ApiPort` 指定其他端口。

## 学院官网监测

左侧地球图标打开第二个消息来源。来源清单来自 `data/sites.json` 中的 22 个学院；
检查时复用原始抓取器的串行请求、限速、隐藏日期节点解析和通知栏目发现逻辑。
每个学院优先检查已知学生公告列表，同时检查首页及最多两个公开通知栏目。
部分栏目失败会标成“部分可用”；需要认证的页面不会尝试绕过。

点击“检查全部”进行第一次全量检查，之后可设为关闭或每 6、12、24 小时自动检查
（默认每 12 小时，第一次全量检查完成后才开始计时）。也可只检查选中的学院。
首次检查得到的历史公告默认为已读；后续发现的新链接进入未读。打开公告会自动标已读，
也能单条撤销或批量标记已读。列表支持近 7 天、近 30 天、全部、标题搜索和只看未读。

监测只保存公开页面的标题、日期、栏目、链接及已读状态，不抓取正文和附件；本地状态在
被 Git 忽略的 `data/attention-desk/official_monitor.json`。完整图文与附件下载仍由仓库根目录
的原始脚本单独执行。校外无法访问的学院站点会保留失败状态，不被当成“没有公告”。

本地官网监测 API：

- `GET /api/official/overview`：22 个来源的检查状态、未读数和公告元数据。
- `POST /api/official/scan`：空 JSON 检查全部；`{"source_ids":["ai.wzu.edu.cn"]}` 只检查指定学院。
- `POST /api/official/read`：传 `source_id`、可选 `url` 和布尔 `read`；省略来源与 URL 可批量更新全部。
- `POST /api/official/settings`：传 `{"auto_interval_hours":12}`，可选 0、6、12、24。

## API 模式

- **本地 Jev 基线**：复用仓库 `.agents/skills/attention-announcement-triage` 的候选聚类、日期解析和确定性 reducer，不上传数据。
- **TypeSafe Jev**：后端按 `state + questions` 结构调用 `https://api.typesafe.ai/v1/systemone`，问题节点使用 `choice / score / noul`，再回到本地 reducer 排序。
- **自定义 Jev API**：可填任意兼容 Jev `state + questions` 的地址，API key 只在本次请求中转发，不写入文件。

日期范围：设置中的“消息日期范围”支持开始日期、结束日期或只填写一端；两端均为闭区间，
筛选发生在候选聚类之前。顶部的“分析基准日”仍单独用于判断 DDL 是否临近、逾期，
不会替代消息日期筛选。首屏提供“最近 1 天 / 最近 7 天 / 本周 / 全部”快捷范围，
并支持按事项类别和“待复核”状态收敛队列；如果范围内没有消息，会给出恢复到完整归档的入口。

截止状态会相对分析基准日动态重算：已超期、今日截止、临近 1-3 天、宽裕 4 天以上、
未排期和日期参考。截止日一过，事项会在下一次分析时自动标记为 `archived`，
退出进行中队列，进入“超期归档”。归档仍可搜索并查看原始判断与证据，但不再
按 P0–P3 当作待办呈现；超期记录按最近截止日期排列。

进行中事项可直接点击行尾勾选“完成并归档”，无需打开详情。完成记录保存在本机
`data/attention-desk/completions.json`，按群聊与证据消息生成稳定标识；刷新、调整
消息日期范围或重新分拣后仍然生效。归档可分别查看“已完成”和“已超期”，已完成事项
可一键撤销；如果它的截止日也已过去，撤销后仍保留在超期归档。

本机微信接口：

- `GET /api/wechat/status`：检查导出器、微信进程、解密目录和 SQLite 分片是否可读，并报告数据新鲜度。
- `GET /api/wechat/groups?q=群名`：搜索导出器会话或本机解密库中的群聊。
- `POST /api/wechat/analyze`：按 `username` 或 `display_name` 读取指定群并分拣；可选 `from_date` / `to_date`（YYYY-MM-DD，首尾包含）。
- `POST /api/wechat/export`：只导出消息包和脱敏后的文件清单；传 `resolve_files: true` 时会额外尝试定位已经下载到本机缓存的文件（文件条目只返回 `local_available`，不重复暴露每个文件的绝对缓存路径）。完整消息仍只写入本地联系人包。

上传文件接口 `POST /api/analyze` 和示例接口 `GET /api/sample` 也接受相同的 `from_date` / `to_date` 参数。
返回结果的 `source` 会同时记录 `archive_start/archive_end`、`archive_message_count`、
`selected_start/selected_end`、`message_count` 和 `message_date_filter`，便于确认筛选是否生效。

导出器未安装时，Windows 可用仓库内的安装检查脚本准备：

```powershell
python scripts/setup_chat_exporter.py --provider auto --install
```

安装器会先尝试 `weflow-cli`，再回退 CipherTalk；旧版兼容解密器只作为已有本地数据的回退路径。

默认加载仓库内的 `data/demo_messages.json` 合成演示记录。真实聊天记录不会入库；
可上传自己的 `messages.json`，或用 `ATTENTION_SAMPLE_PATH` 环境变量指向本机归档文件。
运行时完成记录和微信导出结果也只保存在被 Git 忽略的本地目录。

## JEV 边界

Jev 只负责窄问题的结构化判断，不能直接改写最终优先级。当前图会先把候选区分为
公告、资料/技术分享、普通对话、噪声和待确认事项；技术配置中的版本号不会当作 DDL。
DDL 和紧迫性由本地解析器计算，远程 Jev 的低置信度、越界枚举以及 `urgency` 覆盖都会被拒绝，
P0–P3 由确定性 reducer 计算，并保留证据消息 ID和人工复核状态。

短但有明确日期或行动词的消息不会因为长度被降为噪声；“供大家参考”这类技术分享也不会仅凭“大家”
被提升成全员公告。历史归档如果早于分析基准日，会明确标记为过期归档，并避免把旧事项伪装成当前待办。
