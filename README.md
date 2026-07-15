# TikTok Sandbox — 视频话术拆解工作台

粘贴一条 TikTok 视频链接，自动完成：抓取视频与数据 → 转写逐字稿（带时间轴）→ AI 拆解开头钩子 / 结构 / 卖点话术，并生成一个可浏览的视频板块（类似 Dailyviral 的 sandbox）。

## 功能

- 粘贴链接即抓取：视频文件、封面、标题、作者、播放/点赞/评论/分享数、标签
- 自动转写完整逐字稿 + 时间轴
- AI 话术拆解：
  - 黄金 3 秒 / 开头钩子分析（原话 + 用到的技巧 + 为什么有效）
  - 结构拆解（按阶段切分，附时间戳）
  - 卖点与话术技巧（产品卖点、情绪触发点、话术技巧、可复用金句、CTA）
- 视频板块：网格浏览团队已拆解过的所有视频，点开看详情
- 实时状态轮询（抓取中 / 转写中 / AI 拆解中 / 完成 / 出错）

## 技术架构

- **前端 + 后端**：Next.js 14（App Router + API Routes），TypeScript，Tailwind CSS
- **视频抓取**：yt-dlp（Python），下载视频与封面、解析元数据
- **转写**：可选 OpenAI Whisper API（推荐，快且准）或本地 faster-whisper（免费但慢，需要额外装依赖）
- **AI 拆解**：Anthropic Claude API，结构化 JSON 输出
- **存储**：SQLite（better-sqlite3），视频文件存本地磁盘 `data/media/`

数据流：`粘贴链接 → POST /api/analyze 建记录并后台跑 pipeline → yt-dlp 抓取 → ffmpeg 提取音频 → Whisper 转写 → Claude 拆解 → 写入 SQLite → 前端轮询展示`

## 本地运行

### 1. 安装依赖

```bash
npm install
pip3 install -r scripts/requirements.txt --break-system-packages
# 系统需要已安装 ffmpeg（Mac: brew install ffmpeg / Ubuntu: apt install ffmpeg）
```

### 2. 配置 API Key

```bash
cp .env.example .env
```

编辑 `.env`：
- `ANTHROPIC_API_KEY`：必填，用于话术拆解。在 https://console.anthropic.com/ 获取
- `TRANSCRIBE_PROVIDER`：`openai`（默认，需要 `OPENAI_API_KEY`）或 `local`（免费，需额外 `pip3 install faster-whisper --break-system-packages`，首次运行会自动下载模型）
- `FASTMOSS_API_KEY`：可选，用于 Trend Analysis 页面的"更新"按钮直连 FastMoss 官方 API 拉取数据（不再需要人工在 Chrome 里登录 FastMoss 抓取）。去 https://developers.fastmoss.com 注册账号，登录后在控制台（Profile → API Keys）生成一个 key；按额度付费，可以先申请免费试用额度。不填的话"更新"按钮会报错提示去配置。
- `FASTMOSS_PET_CATEGORY_ID`：可选。设置后会用 FastMoss 的商品分类过滤，更精准也更省额度；不设置的话会退化成关键词兜底搜索（dog/cat/pet/puppy/kitten），零配置能跑但更耗额度。配好 `FASTMOSS_API_KEY` 后访问 `/api/trends/fastmoss-categories` 能看到完整分类树，找到"Pet"相关分类的 `c_code` 填进来。
- `FASTMOSS_REGION`：可选，默认 `US`。
- Script Generator 里的 "Generate video" storyboard 画布，AI 参考图功能复用的就是上面同一个 `OPENAI_API_KEY`（需要这个账号有图片生成权限），不用额外配置。

### 3. 启动

```bash
npm run dev
```

打开 http://localhost:3000，粘贴一个 TikTok 视频链接即可。

## 团队部署（Docker，推荐）

```bash
cp .env.example .env   # 填好 API key
docker compose up -d --build
```

访问 `http://<服务器IP>:3000`。视频文件与数据库会持久化在宿主机的 `./data` 目录。

如果没有自己的服务器，可以用 Railway / Render 这类支持 Dockerfile 部署的平台，把这个仓库直接部署上去（注意：Vercel 等纯 Serverless 平台不适合，因为需要 ffmpeg / python 常驻进程且单次处理耗时较长）。

## 关于稳定性与合规的重要说明

- **抓取稳定性**：TikTok 会不定期调整反爬策略，yt-dlp 可能间歇性失效或需要升级（`pip3 install -U yt-dlp`）。如果团队用量较大、抓取经常失败，可以考虑接入付费的第三方 TikTok 数据 API（如 Kalodata、EchoTik 等）替换 `src/lib/tiktok.ts` 里的抓取逻辑，其余流程不用改。
- **FastMoss 数据来源**：Trend Analysis 的"更新"按钮走的是 FastMoss 官方付费 API（`src/lib/fastmoss.ts`），服务端直接调用，稳定、不依赖真人登录浏览器。Creator Tracker 的达人扫描和 TikTok Shop Affiliate 数据这两块目前还是走 Claude 在 Chrome 里现场登录抓取的老方式（FastMoss 没有对应的达人历史视频扫描 / TikTok Shop 卖家后台的开放 API），还需要在 Claude 对话里触发。
- **速率限制**：短时间内大量抓取同一 IP 容易被限流，建议控制并发、必要时配置代理。
- **合规**：仅建议用于团队内部的竞品/达人内容研究分析，请遵守 TikTok 的服务条款以及所在地区的相关法规，不要用于批量搬运或侵权用途。
- **成本**：每条视频会产生 1 次 Whisper 转写调用 + 1 次 Claude 调用，费用与视频时长、逐字稿长度相关，建议先小范围试用评估单条成本。
- **Storyboard 画布**：Script Generator 里的 "Generate video" 按钮打开一个可自由拖拽拼线的 storyboard 画布（分镜卡片可以任意增删/改文字/重新连线，每张卡片可以上传/从素材库选/AI 生成参考图，底部有整体剪辑方向备注）。点击"🎬 Render video"会用 FFmpeg 把连线顺序上有真实素材（视频或图片）的卡片硬切拼接成一条可下载的 MP4（原视频自带的音轨会保留，没有音轨的片段/图片会补一条静音轨，避免拼接失败）——**这不是 AI 生成视频**，没挂素材的卡片会被跳过并在结果里列出来。
- **AI dub（对口型配音）是可选功能，需要额外的 Sync.so key**：每张挂了视频素材的卡片下面有一个"🗣️ AI dub (lip-sync)"按钮，会用卡片文字生成新配音（OpenAI TTS，复用现有 `OPENAI_API_KEY`），再调用 Sync.so 把嘴型对上这段新配音，生成后会替换成这条卡片渲染时用的素材。需要在 `.env` 配置 `SYNC_API_KEY`（sync.so 注册账号，控制台 API Keys 页面生成），免费额度是每月 3 次生成、单次最长 20 秒，不需要信用卡。没配置这个 key 之前，按钮点击会直接报错提示去配置，不影响其余功能。

## 目录结构

```
tiktok-sandbox/
  scripts/
    fetch_tiktok.py       # yt-dlp 抓取视频+元数据
    transcribe_local.py   # 本地 whisper 转写（可选）
  src/
    app/
      page.tsx                    # 首页：粘贴链接 + 视频板块
      video/[id]/page.tsx         # 视频详情页
      api/analyze/route.ts        # 提交链接，触发后台 pipeline
      api/videos/route.ts         # 视频列表
      api/videos/[id]/route.ts    # 单条视频详情（前端轮询用）
      api/media/[...path]/route.ts# 提供本地视频/封面文件
    components/                   # UI 组件
    lib/
      tiktok.ts        # 调用 yt-dlp
      transcribe.ts    # 调用 Whisper（OpenAI 或本地）
      analyze.ts       # 调用 Claude 做话术拆解
      db.ts            # SQLite 读写
```

## 后续可以扩展的方向

- 团队账号登录与协作评论（当前是无认证的内部工具，默认所有人共享同一个视频板块）
- 批量导入多个链接、按达人/标签打标签筛选
- 导出拆解结果为 PDF / 飞书文档，方便团队分享复盘
- 把 `src/lib/tiktok.ts` 换成付费数据源，提升抓取稳定性和达人主页数据（粉丝数、历史爆款等）
