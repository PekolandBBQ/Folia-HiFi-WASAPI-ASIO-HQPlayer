# 原生音频专项验证：本机登录

本机已具备依赖时可运行 `./test/manual/startNativeAudioReview.ps1`。窗口关闭后重新运行；需加载新的主进程代码时追加 `-Restart`。脚本保留隔离账号目录，仅开发验证启用本机调试端口 19333，普通发布版不启用。

请在「Folia 原生音频专项验证」启动的隔离开发窗口中，使用原有账户界面依次登录网易云、QQ 音乐、酷狗。无需将密码、Cookie、token 或二维码截图发送到聊天。

验证账户配置位于 `%LOCALAPPDATA%/FoliaNativeReview/profile`。QQ/酷狗仍使用 Folia 自带的凭据存储与 API，不导出敏感凭据到测试报告。登录完成后告诉我三个平台分别是否显示成功；权限不足、会员状态、需要扫码或验证码等步骤由你在本机完成。

启动前在项目目录运行 `npm run dev -- --host 127.0.0.1 --port 3000 --strictPort`，另一个终端运行：

```powershell
$env:FOLIA_NATIVE_COMPONENT_CATALOG = (Resolve-Path ../folia-native-audio-component/artifacts/development-catalog.json).Path
$env:FOLIA_NATIVE_FFMPEG_PATH = (Resolve-Path build/ffmpeg/win-x64/ffmpeg.exe).Path
node_modules/.bin/electron test/manual/nativeAudioReviewHost.cjs
```

Navidrome 将单独部署在 `http://127.0.0.1:14533`，初始使用空音乐目录。请先在页面创建本机测试管理员。确认允许加载 `D:\Music` 后再启用该音乐目录；程序不会修改源音乐文件。账户创建后可在 Folia 的 Navidrome 设置中填写此地址和测试账户。请勿把该本机服务开放到公网。

待验证矩阵：每个平台的未缓存/缓存、现有音质档位、过期链接恢复、准备时切歌/停止、WASAPI/ASIO；Navidrome 额外覆盖服务端转码和 `folia-transcode:` 缓存源。模拟错误测试和真实账号实播分别记录，未完成项标注待验证。

报告每个步骤记录中文后英文的说明、预期/实际结果、耗时与截图。截图在完成登录后采集；不拍摄密码、token、Cookie、二维码或验证码。

## English

Sign in to NetEase, QQ Music and KuGou using Folia's existing account screens in the isolated review window. Do not share credentials in chat. The profile stays under `%LOCALAPPDATA%/FoliaNativeReview/profile`.

Navidrome starts with an empty library at `http://127.0.0.1:14533`. Create a local test administrator, then confirm loading `D:\Music`. Live account tests and simulated failure cases are reported separately, with Chinese-first bilingual logs, measured results and credential-free screenshots.
