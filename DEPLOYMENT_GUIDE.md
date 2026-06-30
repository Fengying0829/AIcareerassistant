# AI Career Assistant 上线与埋点小白操作方案

这份项目上线时分成两块：

- 前端网页：放到 GitHub Pages，通过腾讯云域名访问。
- 后端接口：放到腾讯云 CloudBase、云函数或轻量服务器，用来保存 DeepSeek API Key、调用 DeepSeek、接收自定义埋点。

不要把 `DEEPSEEK_API_KEY` 写进 `index.html`，因为前端代码上线后所有人都能看到。

## 1. 腾讯云注册域名

1. 打开腾讯云官网并登录。
2. 搜索「域名注册」。
3. 搜索想要的域名，例如 `aicareerassistant.com` 或 `aicareeros.cn`。
4. 选择可购买的域名并付款。
5. 按腾讯云提示完成账号实名认证和域名实名认证。
6. 回到「我的域名」，确认域名状态正常。

## 2. 上传 GitHub Pages 前端文件

你的 GitHub 仓库：

```text
https://github.com/Fengying0829/AIcareerassistant
```

需要上传这些文件和文件夹：

```text
index.html
vendor/
.nojekyll
```

操作步骤：

1. 打开 GitHub 仓库。
2. 点击 `Add file`。
3. 点击 `Upload files`。
4. 上传 `index.html`、`vendor` 文件夹和 `.nojekyll`。
5. 点击 `Commit changes`。

不要把 DeepSeek API Key 上传到 GitHub。

## 3. 开启 GitHub Pages

1. 进入仓库 `Settings`。
2. 左侧点击 `Pages`。
3. `Source` 选择 `Deploy from a branch`。
4. `Branch` 选择 `main`。
5. 文件夹选择 `/root`。
6. 点击 `Save`。
7. 等 1 到 5 分钟。
8. 先访问默认地址测试：

```text
https://fengying0829.github.io/AIcareerassistant/
```

## 4. 配置自定义域名

建议主站使用 `www` 子域名，例如：

```text
www.your-domain.com
```

### 4.1 GitHub Pages 填域名

1. 进入仓库 `Settings`。
2. 点击 `Pages`。
3. 找到 `Custom domain`。
4. 填入你的真实域名，例如：

```text
www.your-domain.com
```

5. 点击 `Save`。
6. GitHub 会生成一个 `CNAME` 文件。

如果你手动上传，也可以把 `CNAME.example` 复制成 `CNAME`，并把里面改成真实域名。

### 4.2 腾讯云 DNSPod 配置 CNAME

1. 进入腾讯云控制台。
2. 搜索「云解析 DNS」或「DNSPod」。
3. 进入你的域名。
4. 添加解析记录：

| 项目 | 填写 |
|---|---|
| 主机记录 | `www` |
| 记录类型 | `CNAME` |
| 记录值 | `Fengying0829.github.io` |
| 线路类型 | 默认 |
| TTL | 默认 |

注意：记录值不是 GitHub 仓库链接，不要填 `https://github.com/Fengying0829/AIcareerassistant`。

### 4.3 可选裸域名

如果还想让 `your-domain.com` 也能访问，添加 4 条 A 记录：

```text
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```

主机记录都填 `@`，记录类型都选 `A`。

## 5. 开启 HTTPS

1. 回到 GitHub 仓库 `Settings`。
2. 进入 `Pages`。
3. 等待 DNS 检查通过。
4. 勾选 `Enforce HTTPS`。
5. 如果暂时不能勾选，等 10 分钟到 24 小时再刷新。

最终访问：

```text
https://www.your-domain.com
```

## 6. 部署 DeepSeek 后端

小白阶段推荐腾讯云 CloudBase 或云函数。后端需要提供这些接口：

```text
POST /api/match
POST /api/events
GET /api/analytics
```

当前项目里的 `server/index.js` 已经实现了这三个接口，适合部署到轻量服务器，也可以改造成 CloudBase HTTP 函数。

### 6.1 配置环境变量

在腾讯云后端环境里配置：

```text
DEEPSEEK_API_KEY=你的DeepSeekKey
DEEPSEEK_MODEL=deepseek-v4-flash
```

### 6.2 本地测试后端

PowerShell 示例：

```powershell
$env:DEEPSEEK_API_KEY="你的DeepSeekKey"
& "C:\Users\15576\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" .\server\index.js
```

打开：

```text
http://localhost:8787
```

## 7. 配置前端 API 地址

上线后，GitHub Pages 前端要知道后端在哪里。

打开 `index.html`，找到：

```js
window.AI_CAREER_API_BASE = window.AI_CAREER_API_BASE || "";
```

改成你的真实后端域名：

```js
window.AI_CAREER_API_BASE = "https://api.your-domain.com";
```

这样前端会调用：

```text
https://api.your-domain.com/api/match
https://api.your-domain.com/api/events
https://api.your-domain.com/api/analytics
```

## 8. 配置 Google Analytics

1. 打开 `https://analytics.google.com`。
2. 创建账号和 Property。
3. 创建 Web Data Stream。
4. 网站地址填：

```text
https://www.your-domain.com
```

5. 复制 Measurement ID，格式类似：

```text
G-XXXXXXXXXX
```

## 9. 在网页里填 GA ID

打开 `index.html`，找到：

```js
window.AI_CAREER_GA_ID = window.AI_CAREER_GA_ID || "";
```

改成：

```js
window.AI_CAREER_GA_ID = "G-XXXXXXXXXX";
```

保存并上传 GitHub。填了真实 GA ID 后，网页会自动加载 Google tag，并把自定义事件同步上报到 GA。

## 10. 当前已经接入的自定义事件

```text
page_view
resume_file_selected
resume_parse_success
resume_parse_failed
jd_link_fetch_clicked
jd_parse_success
match_start
match_success
match_failed
result_tab_click
quota_exhausted
pay_modal_open
scroll_depth
```

每个事件都会尽量带上：

```text
device_type
viewport_width
viewport_height
screen_width
screen_height
browser_language
timezone
referrer
page_url
```

以及业务参数，例如：

```text
file_type
file_size_kb
resume_text_len
jd_text_len
score
latency_ms
model
input_tokens
output_tokens
estimated_cost_usd
error_code
tab
scroll_depth
```

## 11. 埋点原则

推荐原则：

```text
行为事件尽量记录，用户隐私内容不记录；能记录元数据，不记录正文。
```

不要记录：

```text
简历全文
JD 全文
手机号原文
邮箱原文
姓名
身份证
微信号
DeepSeek API Key
```

## 12. GA 测试

1. 打开 Google Analytics。
2. 进入 `Reports`。
3. 打开 `Realtime`。
4. 访问你的网站。
5. 执行这些动作：
   - 进入用户端
   - 上传简历
   - 粘贴 JD
   - 点击匹配
   - 切换结果 Tab
6. 回到 GA Realtime 或 DebugView，查看事件是否出现。

也可以用：

```text
https://tagassistant.google.com
```

## 13. 最终检查清单

- `index.html` 已上传 GitHub。
- `vendor/` 已上传 GitHub。
- GitHub Pages 默认地址可访问。
- 腾讯云 DNSPod 配置了 `www` 的 CNAME。
- GitHub Pages 配置了自定义域名。
- `Enforce HTTPS` 已开启。
- DeepSeek Key 只在后端环境变量里。
- `window.AI_CAREER_API_BASE` 已填后端地址。
- `window.AI_CAREER_GA_ID` 已填 GA ID。
- `/api/match` 可返回 DeepSeek 结果。
- `/api/events` 可收到埋点。
- GA Realtime 能看到访问和事件。
