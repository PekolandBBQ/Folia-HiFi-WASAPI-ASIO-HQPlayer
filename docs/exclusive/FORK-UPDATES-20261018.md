# Folia HiFi 双源更新与确认安装（2026-10-18）

## 范围

仅查询 GitHub `PekolandBBQ/Folia-HiFi-WASAPI-ASIO-HQPlayer` 与 Gitee `pekoland-bbq/folia-hi-fi-wasapi-asio-hqplayer` 的正式发行版，不查询上游。启动后台延时检查，保留检查开关和手动检查。自动模式优先 GitHub，查询或下载建立连接失败时尝试 Gitee；也可在设置中手动选择来源。后台网络错误不弹窗、不介入播放。

安装版：用户发起应用内下载，完整下载后才允许点击确认安装。确认前不退出、不安装。确认后启动独立等待程序，等待 Folia 正常退出及原有路由清理后运行 NSIS；保留配置和组件备份，成功后重开。等待退出有 120 秒上限，不强制终止 Folia。便携目录仅提供 ZIP 下载，不执行安装。

安装目录通过本地卸载程序和 HKCU 注册卸载路径共同判断，不能因便携目录里复制了卸载程序就误认为安装版。

## 版本和镜像发布约定

- 外部版本、标签不因覆盖修复而改变；内置 `release.json` 增加 `forkTag` 和 13 位内部 `build` 编号。
- 正式 `packaging/exclusive/build.cjs` 每次装配分配一次构建编号，两个产物共用。
- 打包输出 `folia-hifi-update.json`，schema=1，含 tag、build、installer、portable（后两项为附件文件名）。
- 两个源必须同步同一次构建的同一份安装包、ZIP 与清单。先上传包，最后上传清单。不可在两个源分别重新构建后使用同一个 build。
- Gitee 使用官方 API 的 releases/latest、releases/{id}/attach_files 获取发行版及附件。没有正式版或清单时不能报告最新版。
- 下载换源仅接受相同 tag、build、附件名和长度；不比较校验值。不会用镜像旧版覆盖新版本。
- 本次没有上传仓库、Release 或清单，没有修改 PR/Issue。

## 验证结果及限制

- Node 针对性测试 13 项通过：版本排序、同版构建、拒绝预发布、双源自动/手动选择、空源、镜像落后、同构建下载切源、文件未完整下载、取消确认、正常退出等待与复制卸载程序识别。
- Playwright 实际组件测试 1 项通过：更新来源选择、说明展开、显式下载。桌面 IPC 是测试替身。
- 类型检查、桌面渲染器构建和本地 NSIS 装配结果另见 build/dual-source-*.log。
- Gitee 仓库实际查询：公开可访问，发行版数为 0。尚未实测从 Gitee 下载真实发布包。
- GitHub 现有 r4 尚无新构建清单。Node 直接网络查询遇到 fetch failed；PowerShell 查询 GitHub API成功。应用使用独立 Electron 网络会话，网络失败不会触发安装或干扰播放。
- 未对用户正在运行的程序执行退出或安装；真实整包升级、安装后重开仍需后续发布可用清单与安装包后验证。模拟测试不等于真实升级已通过。

## 本地候选

`C:\Users\Pekora\Documents\ChatGPT\Folia\artifacts\Folia-HiFi-r4-dual-source-20261018`

win-unpacked 内程序可直接试用界面；安装版 Setup.exe 供用户自行关闭旧版后安装测试。现有配置、组件备份未被本轮测试修改。

最终装配：2026-10-18，本地双源候选内部构建号 `1792333287831`。NSIS 安装包构建成功；已读取打包内 release.json、forkUpdateSources.cjs 与专版入口，确认包含该构建号、Gitee 地址与专版更新入口（未比较校验值）。注册安装目录检测改为异步执行，避免在主线程同步等待注册表查询。
