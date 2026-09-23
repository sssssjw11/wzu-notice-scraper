# 温州大学通知公告抓取工具

从温州大学官网页脚出发，串行抓取各学院／部门官网的通知公告，下载正文图文与附件，
核对完整性后打包成离线图文库。

面向的是一类很常见的场景：一个学校/单位的官网群由几十个二级子站组成，通知散落在
各处，官方没有统一的检索入口。本项目把「散落 → 汇总 → 离线可用」这条链路做完整。

## Attention Desk 工作台

仓库现已包含 `attention-desk/` 本地 Web 工作台，可把微信群 `messages.json` 整理成
按截止状态和优先级排序的行动队列，支持 Jev 结构化判断、指定日期范围、完成归档和撤销。
原有学院官网抓取脚本保持独立，仍可按下文命令单独运行。

```powershell
cd attention-desk
.\start.ps1 -Install
```

首次打开使用 `data/demo_messages.json` 合成演示记录。真实微信聊天、下载附件、
API 密钥和运行时状态均不进入公开仓库。工作台用法见
[attention-desk/README.md](attention-desk/README.md)。

---

## 设计原则

这三条是硬约束，代码里所有取舍都服从它们：

1. **绝不并发。** 全程单线程串行。任何时候只有 1 个在飞的请求。
2. **模拟真实用户。** 完整浏览器请求头、Cookie 会话、Referer 链、随机抖动延时。
   请求节奏刻意做得不规律（页面间隔 1.8~4.0 秒、资源间隔 0.3~0.9 秒随机）。
3. **需认证的跳过，不做任何绕过。** 撞上统一身份认证（CAS）或图形验证码就如实记录、
   跳过、在结果里标明，不尝试登录、不尝试破解验证码。

单站点还有节流：最多 1 个首页 + 3 个列表页，避免给子站造成压力。

---

## 快速开始

```bash
pip install -r requirements.txt   # requests / beautifulsoup4 / lxml

python extract_footer.py        # 1. 解析官网页脚 -> sites.json
python scrape.py                # 2. 抓取通知条目 -> out/notices.csv  （约 30 分钟）
python report.py                #    生成总览报告（可选，随时可跑）

python download.py --days 30    # 3. 下载近 30 天的正文图文与附件（约 20 分钟）
python finalize.py              # 4. 去重 + 甄别验证码/失效附件
python postprocess.py           # 5. 本地化图片 + 生成离线索引页
python verify.py --days 30      # 6. 完整性核对（交付前必跑）
python pack.py                  # 7. 打包成 zip
```

全量抓取约 1650 条通知，串行模式下耗时较长，属预期。**任何一步都可以随时中断，
重跑会自动跳过已完成部分**（见下文「断点续跑」）。

先跑通再说：`python scrape.py --limit 5` 和 `python download.py --limit 8`
各花一分钟，能验证网络与解析是否正常。

---

## 脚本一览

按执行顺序排列。每个脚本都可以单独运行，也可以只跑其中一段。

| # | 脚本 | 作用 | 主要产出 |
|---|---|---|---|
| — | `_common.py` | 公共层：路径、请求会话、限速、日期解析、日志 | — |
| 1 | `extract_footer.py` | 解析官网页脚，提取各二级单位官网地址 | 根目录 `sites.json`（运行时） |
| 2 | `scrape.py` | 抓取各站「通知公告」条目 | `out/notices.csv`、`out/site_*.json` |
| 2.5 | `report.py` | 把抓取结果渲染成总览报告 | `out/温大各部门通知汇总.html` |
| 3 | `scrape_extra.py` | 补抓首轮取不到通知的特殊站点 | 覆盖 `out/site_*.json` |
| 4 | `download.py` | 下载正文图文与附件 | `download/<单位>/<通知>/` |
| 5 | `finalize.py` | manifest 去重 + 附件真伪甄别 | 回写 manifest 与各 `meta.json` |
| 6 | `postprocess.py` | 本地化图片 + 生成离线索引页 | `download/索引.html` |
| 7 | `verify.py` | 完整性核对（六节核对报告） | `out/verify_report.txt` |
| 8 | `pack.py` | 打包成 zip 交付 | `温州大学通知图文库_*.zip` |
| — | `probe_sites.py` | 探测各站在当前网络下的可达性 | `out/site_reach.json` |
| — | `build_reach_list.py` | 可达性结果整理成清单 | `out/外网可访问站点清单.md`、`.csv` |

11 个脚本都支持 `-h/--help`，用法说明与「前置依赖是哪一步」会在参数解析阶段就打印出来，
不需要先跑通前面的步骤才能看到帮助。

`extract_footer.py` 与 `scrape.py` 之间还有个人工可选环节：如果某些站的入口用页脚
给的地址抓不到内容，在 `scrape_extra.py` 的 `TARGETS` 里补上正确的栏目地址即可。

---

## 时间范围

`download.py`、`verify.py` 支持三种范围写法，语义一致：

```bash
python download.py --days 30                          # 最近 30 天
python download.py --since 2026-08-22 --until 2026-09-22   # 指定区间
python download.py                                    # 不加参数 = 全部
```

`--prune` 会把范围外的已下载目录**移动到** `download/_范围外/`（**只移动，不删除**），
并同步重写 manifest。这样调窄范围不会丢数据，想恢复把目录搬回去即可。

参考数据（供估算耗时与体积）：近 30 天约 450 条、近 90 天约 640 条、
近一年约 1160 条、全量 1650 条左右。平均每条通知约 4.1 张图、1.1 MB。

---

## 断点续跑

所有抓取和下载状态都**逐条落盘**，这是能在串行慢速下安心跑全量的前提：

- `out/site_<域名>.json` —— 每个站点的抓取结果。已存在则跳过，`--force` 强制重抓。
- `download/_manifest.jsonl` —— 每条通知一行，含状态与资源清单。
  重跑时按 URL 跳过已完成项。`--retry-failed` 只重试失败/跳过项。

所以中断后直接重跑同一条命令就行，不用记跑到哪了。

---

## 站点适配说明

该校站点群是「博达系」CMS。同款 CMS 在不少高校都在用，以下结构特征可直接复用
（代码里都带了注释说明原因）：

- **页脚分组**：`ul#Foot-box1-content2/3/4/5` 依次是 学院 / 部门 / 其他 / 其他（重复）。
- **栏目标题不含链接**：`<li class="sh">教师公告</li>`、`<div class="tit">学生公告</div>`
  这类是纯文本节点。判定规则：不含 `<a>`、不含块级子元素、去掉英文数字后中文长度
  ≤12 且含「通知/公告/公示」。
- **日期藏在隐藏节点**（本项目数据质量的关键）：
  `<div id="time<新闻ID>">2026年07月10日</div>`。节点 id 里的新闻 ID 与文章 URL 里的
  ID 一一对应，所以能用 ID 精确反查日期，远比按文本模糊匹配可靠。
- **正文容器**：`<div id="vsb_content">` / `<div class="v_news_content">`。
- **文章链接四种形态**：`/info/<栏目ID>/<新闻ID>.htm`、`?wbnewsid=`、`?aid=`、
  `/<新闻ID>.htm`。
- **附件**：统一走 `/system/_content/download.jsp?urltype=news.DownloadAttachUrl&...`，
  文件名只能从响应头 `Content-Disposition` 取（URL 本身没有扩展名）。

### 日期提取的两个已知口径

`norm_date()`（`_common.py`）按「完整日期 → `YY.MM.DD` → 月-日」三级降级匹配。有两点需要知道：

1. **只有「月-日」时补当前年**。少数小站的列表页日期节点不带年份
   （如 `09-25`），此时会补成当前年。副作用是：一份 2023 年的老通知可能因为
   被补成 `2026-09-25` 而误入「近 30 天」的范围。影响面很小，但用
   `--since/--until` 收窄范围时值得留意。
2. **34 条通知没有日期**（占 1647 条的 2%）。集中在 `温州民俗博物馆`、
   `浙江省皮革工程重点实验室` 等自建小站 —— 它们的列表页压根没有日期节点，
   属上游数据缺失，不是解析失效。这些条目日期留空，不参与时间范围过滤。

### 三道坎

博达系的附件与正文有三种「取不到」的形态，本项目都实测遇到并做了处理：

| 坎 | 表现 | 处理 |
|---|---|---|
| CAS 统一身份认证 | 正文页整页跳 `/system/resource/code/auth/cas/clogin.jsp` | 识别后跳过，记 `需认证-跳过` |
| 图形验证码 | 单文件下载时才弹，返回「请输入验证码下载附件」HTML | `finalize.py` 甄别，记 `need_captcha` |
| PDF 正文 | `<div id="vsb_content">` 存在但取不到文字，内容在 `showVsbpdfIframe` 内嵌的 PDF 里 | `mode="pdf"` 分支，把 PDF 当附件抓 |

**最可靠的一道预警信号**：落盘文件名是 `download__<hash>.jsp` 就说明没拿到真附件 ——
扩展名取不到 = 响应头缺 `Content-Disposition` = 拿到的是中间页而不是文件。
`verify.py` 会把附件目录里的 `.jsp` 数量与甄别结果交叉核对，对不上就报警。

---

## 产出结构

### 仓库根目录

```
sites.json                 各二级单位官网清单（extract_footer.py 生成，不入库）
data/sites.json            同一份清单的版本化副本，随仓库分发
```

`sites.json` 是运行时产物（已列入 `.gitignore`），`data/sites.json` 是入库的分发副本。
`_common.load_sites()` 优先读后者 —— **所以 clone 下来不必先联网跑 `extract_footer.py`，
直接跑 `scrape.py` 就能用**。想更新站点清单，跑一次 `extract_footer.py`，
再把根目录那份复制到 `data/`。

### `out/`

```
notices.csv                全部通知条目（类别,单位,栏目,发布日期,标题,链接,站点,站点状态）
sites_result.json          每个站点的抓取明细与日志
site_*.json                单站点结果（断点续跑依据）
温大各部门通知汇总.html      总览报告（可搜索/筛选）
verify_report.txt          完整性核对报告
captcha_attach.json        需验证码/已失效附件明细
site_reach.json / .csv     可达性探测结果
```

### `download/`

```
索引.html                  离线浏览页（可搜索、按单位/日期筛选、附件直达）
_manifest.jsonl            全部下载记录
README.txt                 交付说明（pack.py 生成）
<单位>/<日期>__<编号>__<标题>/
    内容.md                正文（Markdown，图片指向本地）
    正文.html              正文网页快照（图片已本地化，双击可看图）
    meta.json              元数据（原站 URL、日期、栏目、图片与附件清单）
    图片/
    附件/
```

预览离线库：直接双击 `download/索引.html`。如果单文件预览器的相对链接不解析，
可以起个本地服务：

```bash
cd download && python -m http.server 8765 --bind 127.0.0.1
# 然后打开 http://127.0.0.1:8765/
```

---

## 核对为什么值得做

`verify.py` 刻意做了两条**互相独立**的核对路径：

1. 读 `_manifest.jsonl`（脚本自己写的自述）
2. 直接扫磁盘数文件（独立证据）

两者对不上就说明中间有文件丢失或未被记录。实践中这两条路径确实抓出过问题：
manifest 里 456 行有 4 行是重复写入；14 个 `.jsp` 假附件混在附件目录里；
2 张配图被误报为「本地缺失」——实际是原站本来就 404，属上游问题。

所以最终结论会把「本项目的失败」和「原站限制」严格分开统计，后者不计入失败。
以下是本项目实际交付时的核对结论（范围内 452 条通知）：

```
PASS — 范围内所有通知均完整落地，无缺失文件、无零字节文件。

属原站限制、不计入失败的项目：
  · 36 篇通知需统一身份认证（CAS），未能下载
  · 13 个附件原站要求图形验证码，仅取到中间页
  · 1 个附件原站已失效（服务器返回空内容）
  · 2 张配图在原站为 404，已失效
```

---

## 可用性探测

校外网络下，部分子站（多为学生线的高频站点）可能连不上或被拦。想先摸清情况：

```bash
python probe_sites.py        # 串行探测全部站点
python build_reach_list.py   # 整理成 Markdown + CSV 清单
```

探测方式与主抓取器一致。结果里「连不上」通常意味着该站仅限校内网络，需要校园网
或学校 VPN 才能访问 —— 这不是抓取脚本的问题。

---

## 已知边界

- **串行必然慢**。全量抓取 1600 条通知约 30 分钟，下载近一月图文约 20 分钟。
  这是遵守「不并发、模拟真实用户」的代价，换的是不被封禁、不打扰子站。
- **需认证的通知取不到**。这部分通知在校外永远抓不到，属产品边界的诚实告知，
  不是可以通过技术手段解决的问题（也不应该尝试）。
- **列表页深度有限**。单站点最多 3 个列表页，这意味着更新很慢的站点只能取到
  最近几条。调 `--max-lists` 可以加深，但不建议对子站加压。
- **`out/` 与 `download/` 不入库**（见 `.gitignore`）。仓库里只有脚本，数据在本地生成。
- **依赖只有三个**：`requests`、`beautifulsoup4`、`lxml`（见 `requirements.txt`）。
  `lxml` 容易漏装 —— 代码里所有 `BeautifulSoup` 调用都显式指定 `"lxml"` 解析器，
  缺它会报 `FeatureNotFound: Couldn't find a tree builder`。其余全部是标准库。
- **站点改版会导致解析失效**。解析逻辑集中在 `scrape.py` 的
  `find_notice_blocks` / `pick_list_pages` / `extract_items` 和 `download.py` 的
  `find_content_node`，改版时改这几个函数即可。

---

## 版权

本仓库内的代码以 [MIT License](LICENSE) 开源。

所有抓取内容版权归温州大学各二级单位所有，本工具仅作离线归档与检索之用。
使用时请遵守目标站点的 robots 约定与相关法律法规，控制请求频率。
