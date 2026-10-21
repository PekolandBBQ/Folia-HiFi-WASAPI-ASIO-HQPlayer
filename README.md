# Folia-HiFi（支持Spotify接入-WASAPI及ASIO独占-HQPlayer升频）

基于 [Folia](https://github.com/chthollyphile/folia-major) 的个人公益、非商业专版，由 [PekolandBBQ](https://github.com/PekolandBBQ) 维护。保留 Folia 的歌词与音乐库体验，追加 **Spotify 接入、WASAPI / ASIO 独占、HQPlayer 升频、整数直通与音频链路展示**。

**当前版本：0.7.19 r9** · Windows x64 · Spotify 接入需要 Windows 11 x64

[GitHub 下载](https://github.com/PekolandBBQ/Folia-HiFi-WASAPI-ASIO-HQPlayer/releases/tag/folia-hifi-v0.7.19-r9) · [Gitee 国内下载](https://gitee.com/pekoland-bbq/folia-hi-fi-wasapi-asio-hqplayer/releases/tag/folia-hifi-v0.7.19-r9) · [使用说明](docs/exclusive/USAGE.md) · [更新说明](docs/exclusive/releases/0.7.19-r9.md) · [反馈问题](https://github.com/PekolandBBQ/Folia-HiFi-WASAPI-ASIO-HQPlayer/issues)

## 我追加了哪些功能

| 功能 | 实际体验 |
| --- | --- |
| **Spotify 流媒体接入** | 浏览自建与收藏歌单、收藏专辑、关注艺人，以及 Daily Mix、每周新发现等推荐；在线搜索单曲、艺人和专辑，点赞与收藏同步到 Spotify。支持拼贴卡片滚动歌词、全屏歌词和桌面播放协同 |
| **WASAPI / ASIO 独占输出** | 本地、Spotify、QQ、网易云等音源可选择 WASAPI / ASIO 设备独占播放 |
| **HQPlayer 升频与流式输出** | 将 Spotify、QQ、网易云等音源送入 HQPlayer，按所选 DAC、滤波器和整形器升频到 PCM 或 DSD；支持的音源可边下载边播放 |
| **HQPlayer 独立连接** | 自动发现或选择本机 HQPlayer Desktop，支持后台启动、窗口显示与隐藏，以及当前曲或下一曲应用 DSP 设置 |
| **整数 PCM 与音频链路** | 支持整数处理、音量与 ReplayGain，直观查看音源、采集格式、处理路径、升频结果和增益 |

## 下载与开始使用

1. 在发行页选择 **EXE 安装版**或 **ZIP 便携版**；便携版完整解压后运行。更新保留已有配置。
2. 启动后进入首页，选择本地或流媒体音源。使用 Spotify 前，请安装桌面客户端并登录账号，再按 Folia 向导完成一键安装与配置。
3. 使用 HQPlayer 前，请安装并授权 HQPlayer Desktop，选择 DAC 与 DSP 设置，开启网络控制，然后在 Folia 中连接。

应用会后台检查更新，在应用内展示更新说明；由你决定是否下载和安装。下载可取消、可重试，支持 GitHub 与 Gitee 更新源。

Gitee 网页提供分卷包，首次手动下载时请取齐同组分片，用 7-Zip 打开首个分片合并；应用内更新会自动合并。更多操作见[使用说明](docs/exclusive/USAGE.md)。

## 实际界面

点击图片可查看原图。

**Spotify 首次使用向导**：选择客户端，完成组件安装与连接。

![Spotify 首次配置向导](https://github.com/user-attachments/assets/e7ab6f03-3d89-4456-8ca7-96b174e62066)

**Spotify 歌单封面**：已点赞歌曲以九宫格封面展示。

![Spotify 已点赞歌曲与本机曲目](https://github.com/user-attachments/assets/a276b0f5-bde8-4e28-a1bf-fd8fb20e45e0)

**Spotify 音乐库**：浏览自建歌单、收藏歌单、年度歌曲和已点赞歌曲。

[![Spotify 收藏歌单、年度歌曲与已点赞歌曲](https://github.com/user-attachments/assets/740ed4e4-1be8-47ad-b4b8-6519ebd7aeb1)](https://gitee.com/pekoland-bbq/folia-hi-fi-wasapi-asio-hqplayer/raw/codex/folia-exclusive/docs/exclusive/images/r8/spotify-playlists.png)

<details>
<summary>查看收藏专辑与关注艺人</summary>

[![Spotify 收藏专辑](https://github.com/user-attachments/assets/f2a50f99-3f6b-49f1-aace-7c4f8f421489)](https://gitee.com/pekoland-bbq/folia-hi-fi-wasapi-asio-hqplayer/raw/codex/folia-exclusive/docs/exclusive/images/r8/spotify-albums.png)
![Spotify 关注艺人](https://github.com/user-attachments/assets/5a8d0ac8-a00a-46d1-8fd5-660794a810cb)

</details>

**Spotify 推荐歌单**：在“电台”中浏览 Daily Mix、每周新发现、新歌雷达等个性推荐。

[![Spotify Daily Mix、每周新发现与推荐歌单](https://github.com/user-attachments/assets/c182efd5-4cf2-45fb-a5a9-1a4900d80664)](https://gitee.com/pekoland-bbq/folia-hi-fi-wasapi-asio-hqplayer/raw/codex/folia-exclusive/docs/exclusive/images/r8/spotify-recommendations.png)

**在线分类搜索**：切换单曲、艺人和专辑，进入对应页面浏览与收藏。

<table>
  <tr>
    <td width="33%"><img src="https://github.com/user-attachments/assets/e0d2005d-54f4-46db-bfa0-17518ed7729d" alt="Spotify 单曲搜索" /></td>
    <td width="33%"><img src="https://github.com/user-attachments/assets/eaa295f6-bc2d-4b9e-bb59-e4bd36cbd8b9" alt="Spotify 艺人搜索" /></td>
    <td width="33%"><img src="https://github.com/user-attachments/assets/fb94d6fd-399b-41f7-95fc-fcef65d0c8fa" alt="Spotify 专辑搜索" /></td>
  </tr>
  <tr><td align="center">单曲</td><td align="center">艺人</td><td align="center">专辑</td></tr>
</table>

<details>
<summary>查看艺人、专辑详情与流媒体账号切换</summary>

![Spotify 艺人详情、热门歌曲与专辑](https://github.com/user-attachments/assets/9adfce97-73c5-4c0a-a5cb-233fd28c9236)
![Spotify 专辑详情与曲目](https://github.com/user-attachments/assets/76f553e8-20a4-4e57-8066-f599cdd821ed)

账号菜单展示头像与用户名，可切换 Spotify、网易云、QQ 等音源。

<img src="https://github.com/user-attachments/assets/e7b2fb98-47d9-4627-9285-c21dd5cc1d4e" alt="Spotify 与其他流媒体账号切换" width="480" />

</details>

**Folia 歌词体验**：在歌曲卡片内显示滚动歌词，或进入播放页欣赏全屏歌词动效。

![歌曲卡片内滚动歌词](https://github.com/user-attachments/assets/d9bb38e0-b6af-4598-acdc-1a91bb231ed5)

<details>
<summary>查看全屏歌词动效</summary>

![Folia 全屏动态歌词](https://github.com/user-attachments/assets/858610c6-2830-496c-9e79-04e4ecd25a06)

</details>

**WASAPI / ASIO 输出**：选择播放设备，调整 Spotify 缓存，开启整数处理与音频链路展示。

![WASAPI 与 ASIO 输出设备](https://github.com/user-attachments/assets/40fda476-59f4-4df9-bf89-75433739153a)
![整数 PCM 与音频链路开关](https://github.com/user-attachments/assets/f3c3a691-aa76-4338-8cf2-92530a2952bb)

**流式播放**：左下角显示准备与缓冲进度，音频链路展示当前处理与输出格式。

![Spotify 与 WASAPI 流式输出链路](https://github.com/user-attachments/assets/d4887785-7829-496c-80bc-58ee26cf7592)

**HQPlayer 独立连接**：管理连接与窗口显示，在 DSP 面板选择当前曲或下一曲应用设置。

![HQPlayer 连接与窗口设置](https://github.com/user-attachments/assets/d5d339f1-8f61-4318-89a9-b7804f44de3f)

<details>
<summary>查看 HQPlayer DSP 播放面板</summary>

![HQPlayer 浮窗、DSP 和窗口显示开关](https://github.com/user-attachments/assets/d736b9ff-a4d5-43c8-bc6d-8e968eaac370)

</details>


---

<details>
<summary>Folia 上游项目介绍、使用方式与贡献者（保留原文）</summary>

<p align="center">
  <img src="https://github.com/user-attachments/assets/b5d0e863-48be-497b-b0e9-4bd8d8ce9bf0" alt="Folia" width="100%" />
</p>

<div align="center">
<a href="https://trendshift.io/repositories/71740?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-71740" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/71740" alt="chthollyphile%2Ffolia-major | Trendshift" width="250" height="55"/></a>

# Folia

Lyrics Reimagined // 辞曲新境

[![GitHub release](https://img.shields.io/github/v/release/chthollyphile/folia-major?label=release)](https://github.com/chthollyphile/folia-major/releases)
[![License](https://img.shields.io/github/license/chthollyphile/folia-major)](https://github.com/chthollyphile/folia-major/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/chthollyphile/folia-major?style=social)](https://github.com/chthollyphile/folia-major/stargazers)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/chthollyphile/folia-major)
[![Discord](https://img.shields.io/discord/1541051241822687232?logo=discord&logoColor=white&label=Join%20our%20Discord)](https://discord.gg/dMDBTHxeKd)
<!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->
[![All Contributors](https://img.shields.io/badge/all_contributors-35-orange.svg?style=flat-square)](CONTRIBUTORS.md)
<!-- ALL-CONTRIBUTORS-BADGE:END -->

[获取方式](https://github.com/chthollyphile/folia-major#%E8%8E%B7%E5%8F%96%E6%96%B9%E5%BC%8F)
·
[Vercel 部署](https://vercel.com/new/clone?repository-url=https://github.com/chthollyphile/folia-major)
·
[使用指南](https://folia-site.cielaniska.top/guide/)
·
[技术说明](docs/technical.md)

</div>

## 项目简介

Folia是一个以全屏沉浸式歌词播放为核心的在线音乐播放器，支持网易云、酷狗、Navidrome 和本地音乐库，通过智能歌词匹配，AI生成配色主题，以及多种全屏歌词动画为用户提供独特的听歌体验。

提供基于Electron的 windows/ macOS/ Linux 桌面端版本与基于 Node.js 的 Web 版本，支持多平台部署。

如果希望能够在移动设备上使用，或在浏览器上体验，可以选择[一键部署到 Vercel](https://folia-site.cielaniska.top/guide/deploy-vercel) 的 Web 版本，或自行部署到其他支持 Node.js 的平台。

## 展示

![visualizer](https://github.com/user-attachments/assets/0e14a98a-c801-4084-9481-a2add7d9edf2)

### 演示视频

https://github.com/user-attachments/assets/af806cf1-f67f-4b88-b2e7-57db507e9e81

https://github.com/user-attachments/assets/fd27f4f0-64b9-4c57-8c3b-10df767f934b

https://github.com/user-attachments/assets/704f195a-2194-434b-86e8-8f36290e5cc4

### 部分主题预览

<table>
  <tr>
    <td width="50%">
      <img src="https://github.com/user-attachments/assets/2bf842f2-c2ee-4621-97fc-461d6b1125ea" alt="Fume 主题预览" />
    </td>
    <td width="50%">
      <img src="https://github.com/user-attachments/assets/a882f595-5d75-401f-a59a-4be982151f86" alt="Lumi 主题预览" />
    </td>
  </tr>
  <tr>
    <td align="center"><strong>浮名</strong></td>
    <td align="center"><strong>流光</strong></td>
  </tr>
  <tr>
    <td width="50%">
      <img src="https://github.com/user-attachments/assets/10e8a275-7ab1-4355-b7d8-daee2b062cfa" alt="Cad 主题预览" />
    </td>
    <td width="50%">
      <img src="https://github.com/user-attachments/assets/479529fa-0eff-4fb7-b48b-9b197b0b9b36" alt="Pat 主题预览" />
    </td>
  </tr>
  <tr>
    <td align="center"><strong>心象</strong></td>
    <td align="center"><strong>云阶</strong></td>
  </tr>
  <tr>
    <td width="50%">
      <img src="https://github.com/user-attachments/assets/b85b2c5d-2021-4fce-8f2e-7f0d9523755c" alt="群唱 主题预览" />
    </td>
    <td width="50%">
      <img src="https://github.com/user-attachments/assets/42ef0be4-e37d-4173-9a80-bfeb202b1a58" alt="Tilt 主题预览" />
    </td>
  </tr>
  <tr>
    <td align="center"><strong>群唱</strong></td>
    <td align="center"><strong>倾诉</strong></td>
  </tr>
    <tr>
    <td width="50%">
      <img src="https://github.com/user-attachments/assets/c5a42e8f-c1f8-4ac7-b616-735a3b4e8dbd" alt="镜台 主题预览" />
    </td>
    <td width="50%">
      <img src="https://github.com/user-attachments/assets/986d8a52-a712-4a90-9b3e-ef5ce7103cf5" alt="时计 主题预览" />
    </td>
  </tr>
  <tr>
    <td align="center"><strong>镜台</strong></td>
    <td align="center"><strong>时计</strong></td>
  </tr>
</table>

不同的歌词动画具有不同的排版氛围和可调参数，让全屏歌词拥有如同文字PV般的丰富视觉效果，同时又能兼顾响应式布局，自动适配不同窗口尺寸。

## 核心能力

| 模块 | 说明 |
| --- | --- |
| 在线搜索与播放 | 搜索歌曲、歌手或专辑后即可播放，并自动加载相关封面与歌词。 |
| 本地音乐支持 | 可导入本地音频文件，在本地安全保存索引信息，不上传文件内容。详细用法见 [本地音乐库管理](docs/local-library-management.md)。 |
| 智能歌词匹配 | 本地歌曲可自动匹配在线歌词与封面，也支持手动修正匹配结果。 |
| 本地歌词文件识别 | 自动加载同目录同名 `.lrc`、`.vtt`、`.ttml`、`.qrc`、`.yrc`、`.krc` 歌词文件，或歌词文件内嵌 LRC 歌词。适配 LDDC 生成的增强型逐字歌词格式。 |
| Now Playing 接入 | 支持通过本机 [Now Playing](https://github.com/Widdit/now-playing-service/) 服务接入外部播放器的歌曲、时间轴与歌词信息，并驱动 Folia 的舞台视图与全屏歌词渲染。 |
| AI 主题生成 | 基于歌曲情绪与歌词内容生成沉浸式背景与视觉参数。 |
| 多端体验 | 提供 Web 部署方式，同时支持桌面端打包分发。 |
| 模组系统（实验性） | 桌面版可通过 Folium 模组添加歌词动画、背景、播放页图层、命令等，并从 [模组市场](https://folium-compound.cielaniska.top) 安装官方认证的模组。详见 [模组系统](#模组系统folium-v1x)。 |

## 获取方式

桌面版内置前后端运行环境，适合希望即装即用的用户。

### 一键部署

如果你希望快速上线 Web 版本，请阅读 [Vercel 一键部署指南](https://folia-site.cielaniska.top/guide/deploy-vercel) 来创建项目

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/chthollyphile/folia-major) 

项目也支持一键部署到 Cloudflare，请参考 Vercel 的部署教程进行相应调整。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chthollyphile/folia-major)

Vercel 与 Cloudflare 上的 QQ 音乐不再需要额外部署一个常驻 API 实例：把 `VITE_QQ_API_BASE` 填成 `/api/qq`，再配一个 `QQ_SESSION_SECRET`（服务端密钥，**不加 `VITE_` 前缀**）即可。这种形态默认只支持微信扫码登录，且播放前必须先登录；Cloudflare 上可以再绑定一个 Durable Object，增加 QQ 扫码登录方式。完整步骤、平台差异和排错方法见 [QQ 音乐部署指南](docs/qq-music-deployment.md)。

自托管用户可以使用 [Docker Compose 全栈部署](deploy/docker/README.md)。本地音乐目录访问依赖可信 HTTPS 安全上下文，部署文档包含 NAS 反向代理和证书要求。

关于移动端：

目前推荐移动端用户部署 Web 版本/自托管版本之后，通过chrome for android / iOS Safari 创建 PWA应用（也就是将网页应用添加到桌面，Folia web版本支持安装为PWA应用）来使用。

有一定技术的用户可以使用 capacitor 将本项目的web版本打包成为可安装的安卓apk，具体方法可参考示范仓库：[chthollyphile/folia-sonnet](https://github.com/chthollyphile/folia-sonnet)

### 直接下载

- **Windows / macOS / Linux**: 最新版本的安装包请前往 [Releases 页面](https://github.com/chthollyphile/folia-major/releases/latest) 下载。
- **Arch Linux**: 可通过 AUR 获取 [folia-major-bin](https://aur.archlinux.org/packages/folia-major-bin)。
- **Flatpak**: 社区提供的第三方 flatpak，详情见 [Flatpark](https://flatpark.org/apps/top.izuna.foliamajor/)。

> [!IMPORTANT]
> 如果国内网络从 GitHub Releases 下载较慢，可以使用 [夸克网盘](https://pan.quark.cn/s/6e4c6fa3bc6f) 或 [百度云](https://pan.baidu.com/s/1f0x3g-8PMcNCO-TJ5z1rPw?pwd=flia) 下载。网盘链接仅提供 Windows 与 Apple silicon 的正式版安装包.

Linux 包、Wayland / Hyprland 遥控窗和桌面端细节见 [技术与开发说明](docs/technical.md)。

## 文档与开发

更完整的使用说明请访问 [Folia Guide](https://folia-site.cielaniska.top/guide/)。

部署、环境变量、本地开发、Stage API、常用脚本和技术栈见 [技术与开发说明](docs/technical.md)。

## 模组系统（Folium v1.x）

> [!NOTE]
> 模组系统是实验性功能，仅桌面版可用，默认关闭，需要在「设置 → 实验室 → 模组系统」中开启。

Folium 是 Folia 的模组平台。模组可以添加新的歌词动画模式和背景类型、在播放页上叠加内容、给进度条加按钮和标记、注册命令与设置分区、在歌词显示前改写歌词，也可以通过 Node 入口调用 ffmpeg 等本地能力。模组以可信代码运行，每个模组在启用前都要在原生窗口中确认，文件变化后需要重新确认。

- **模组市场**：[folium-compound.cielaniska.top](https://folium-compound.cielaniska.top) 提供官方模组和经过审查的社区模组，下载 zip 后拖进模组面板即可安装。
- **官方认证**：市场里的模组都带有 Folium 签名，安装后显示「官方认证」；没有签名的第三方模组显示「未验证」，同样可以使用。
- **开发与贡献**：[模组开发与贡献指南](docs/folium/contributing.md)，从写第一个模组、本地调试，到提交到模组市场、审查与签名、发布更新。
- **API 参考**：[Folium API 参考](docs/folium/api.md)，由契约文件生成的完整接口文档，按注册表、上下文、事件、服务等分类查询。
- **平台规范**：[Folium 规范](mods/README.md)，包括清单字段、权限、注册表语义、事件、安全模型与版本策略。
- **示范模组**：仓库的 [`mods/`](mods/) 目录，覆盖歌词动画、调参、进度条、播放页图层与透明视频导出。

## Sync Server

Folia 提供了可选的官方同步服务端 `sync-server`，用于在多个设备之间同步外观设置与 AI 主题库。服务端由用户自行托管，适合希望跨设备同步配色主题的用户。

支持以下部署方式：

- **Cloudflare Workers / D1**：免服务器运维的 Serverless 部署，推荐使用。
  [![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chthollyphile/folia-major/tree/main/sync-server)
- **Docker**：镜像与 Compose 入口见 [Docker 部署目录](deploy/docker/README.md)。
- **Node.js 自托管**：使用 SQLite，适合本地或不方便使用 Docker 的环境。

详细的环境变量、Token 配置与部署步骤请参阅 [Sync-Server 部署指南](https://folia-site.cielaniska.top/guide/deploy-sync)。部署完成后，在 Folia 的“存储设置”中填写服务端地址和 `SYNC_TOKEN` 即可启用同步。

## 本地音乐与匹配说明

Folia 会读取音频文件元数据、同目录歌词和封面，并可通过网易云、QQ 音乐或酷狗音乐补全歌曲信息。自动匹配按网易云、QQ、酷狗依次回退；匹配不准确时，可以手动选择候选、恢复首次导入的本地信息，或进一步合并、拆分艺术家与专辑实体。

完整的导入、重扫、匹配、实体编辑、歌单、缓存和故障排查说明见 [本地音乐库管理](docs/local-library-management.md)。

## Community

加入discord社群，共同交流，获得帮助

[![Discord](https://img.shields.io/discord/1541051241822687232?logo=discord&logoColor=white&label=Join%20our%20Discord)](https://discord.gg/dMDBTHxeKd)

## 贡献者

感谢所有为本项目进行 Issue 提交、Bug 报告、想法建议、测试与代码编写的贡献者，均依据 all-contributors 规范进行统计

由于列表过长，贡献记录请见 [贡献者名单](CONTRIBUTORS.md)。

## 法律与免责声明

本项目在 AI 的广泛协助下开发，因此仍可能存在细微或不易察觉的问题。若给你带来不便，敬请理解。

本项目主要用于展示播放动效、界面设计与相关工程实现。应用中涉及的在线音乐流媒体、歌词、专辑封面及其他内容，其版权均归对应权利人所有。

本仓库及其源代码仅供个人学习、技术交流与非营利测试使用。请勿将其用于商业盈利用途。若因对在线资源的传播、加工或再分发而引发版权纠纷或其他责任，均由使用者自行承担，项目开发者不承担相关责任。

请始终尊重数字版权，并在条件允许时通过官方平台支持正版音乐。

## 致谢

特别感谢以下项目和资源：

- [chenmozhijin/LDDC](https://github.com/chenmozhijin/LDDC)
- [NeteaseCloudMusicApiEnhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)
- [chenglou/pretext](https://github.com/chenglou/pretext)
- [MakcRe/KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi)
- [paper-design/shaders](https://github.com/paper-design/shaders)
- [yakult-green-tea/qq-music-api](https://github.com/yakult-green-tea/qq-music-api)

本项目接入了 [Apple Music-like Lyrics TTML 逐词歌词库](https://github.com/amll-dev/amll-ttml-db) 以提供高质量的歌词文件，感谢此歌词库的作者和贡献者们。

## 许可证

本项目基于 `AGPL-3.0` 许可证开源。

</details>

---

## 项目基础与致谢

<details>
<summary>查看项目与贡献者署名</summary>

感谢以下项目的作者、贡献者和维护者。本 fork 在 Folia 的基础上扩展 HiFi 输出与 Spotify 接入；下表列出主要项目及其实际用途，相关署名与许可证保留在源码、依赖和发行材料中。

| 项目 / 仓库 | 关系与用途 |
| --- | --- |
| [Folia · chthollyphile/folia-major](https://github.com/chthollyphile/folia-major) | 本 fork 的直接基础，提供播放器、歌词界面、音乐库和多音源框架 |
| [Electron](https://github.com/electron/electron) / [React](https://github.com/facebook/react) | 桌面应用运行与界面框架 |
| [Spicetify CLI](https://github.com/spicetify/cli) | Spotify 客户端扩展的安装与配置基础；本项目在此之上实现 Wrapper 通信与播放协同 |
| [Windows Application Loopback sample](https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback) | Spotify 进程专属采集所用 Windows API 的官方示例与实现参考 |
| [NAudio](https://github.com/naudio/NAudio) | Windows 原生音频组件使用的音频库，支持设备访问、采集及 WASAPI / ASIO 链路 |
| [FFmpeg](https://github.com/FFmpeg/FFmpeg) | 音频解码、格式转换及支持条件下的渐进解码；发行版附对应构建源码与许可证 |
| [NeteaseCloudMusicApiEnhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) | 网易云音乐接口依赖 |
| [yakult-green-tea/qq-music-api](https://github.com/yakult-green-tea/qq-music-api) | QQ 音乐接口依赖 |
| [MakcRe/KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi) | 酷狗音乐接口依赖 |
| [Apple Music-like Lyrics](https://github.com/amll-dev/applemusic-like-lyrics) | 使用其 TTML 解析组件 |
| [AMLL TTML DB](https://github.com/amll-dev/amll-ttml-db) | 接入的逐词歌词数据来源 |
| [chenglou/pretext](https://github.com/chenglou/pretext) | 文本测量与布局 |
| [paper-design/shaders](https://github.com/paper-design/shaders) | 背景与界面着色器效果 |
| [Borewit/music-metadata](https://github.com/Borewit/music-metadata) | 音乐文件格式、标签和时长解析 |
| [EarTrumpet](https://github.com/File-New-Project/EarTrumpet) | 实现参考：Windows 10 / 11 每应用音频路由接口定义与方法布局 |
| [Music Assistant](https://github.com/music-assistant/server) | 早期 Spotify 方案研究中，参考其官方播放程序、PCM 管道与控制分离的架构 |
| [spotify-player](https://github.com/aome510/spotify-player) | 早期 Spotify 方案研究中，参考其授权、Web API 与播放引擎分离的设计 |

保留 Folia 上游对 [chenmozhijin/LDDC](https://github.com/chenmozhijin/LDDC) 的致谢。Music Assistant 与 spotify-player 属于历史方案参考，当前 Wrapper 无需安装这两个项目。

相关官方软件与资料：[Signalyst HQPlayer Control 源码与接口资料](https://www.signalyst.eu/custom.html)用于 HQPlayer 控制接入；[VB-Audio VB-CABLE](https://vb-audio.com/Cable/)用于 Spotify 的受控音频路由与格式准备。感谢两者提供的工具与资料。

</details>
