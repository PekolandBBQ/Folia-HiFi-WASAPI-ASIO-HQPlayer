# Spotify 艺人、专辑搜索与收藏候选 · 2026-10-20

基线：当前 r7 音乐库候选及冷启动进程发现恢复修复。沿用 Wrapper，HTTP/Origin 不恢复；本次不发布，不改配置、备份、音频组件、播放链路或既有客户端资源。

## 实现

- Omni 增加可选艺人、专辑搜索契约与能力。Spotify 从当前客户端资源提取 searchArtists/searchAlbums 查询身份，不调用官方限流目录 API，不用收藏列表冒充在线搜索。
- 原搜索页增加单曲／艺人／专辑分类；每类独立分页、缓存及滚动位置。艺人和专辑结果打开原有详情页，返回恢复正确分类，不构造假歌曲、不触发播放。切分类或查询后丢弃旧请求结果。
- Spotify 原生 LibraryAPI.add/remove 实际写入艺人关注和专辑收藏；与已有单曲点赞共用扩展写入队列，写入不阻塞播放状态、元数据及握手读取。
- 写入前读取账号与既有状态，同状态不重复写；完成后回读 contains，未确认不报告成功；账号改变不把旧结果应用到新账号。429 不反复请求。
- Folia 再从 Spotify 分页读取完整收藏艺人／专辑列表，核对成员及当前账号。列表同步稍迟时有限重读，满足后才发布完整列表快照。首页按 provider＋账号替换服务端快照并作废旧读取，不在本地凭空增删一项。
- 专辑复用原收藏按钮；艺人使用原拼贴页信息条的订阅控件、网格信息面板及 TUI 头部。关注／取消关注、收藏／取消收藏都显示真实回读状态；未知状态先读取，失败允许重新读取，不猜成“未收藏”。相关文案提供中文、英文、印尼文。
- 桥接 1.3.0 增加 collectionSearch、collectionSubscriptions 能力；已有自动连接流程更新运行中的旧桥接。无重装、无 backup 重跑。

## 验证与边界

- Node 146 项通过，覆盖原冷启动与恢复回归、新搜索响应与分页、不同关键词并发隔离、关注／取消／收藏／移除写入及回读、写入失败后下一项恢复、账号变化、429 停止，以及元数据／握手不被挂起写入阻塞。记录：build/spotify-catalog-node-final.log。
- Vitest 181 项通过，覆盖 Omni 路由、来源与类型、不同分类缓存／分页／晚到响应、历史返回、写入与真实列表回读、列表稍迟同步、旧账号与旧请求不能覆盖确认快照。记录：build/spotify-catalog-unit-final.log。
- 类型检查通过：build/spotify-catalog-typecheck-final.log。最初新增浏览器探针的 t 函数签名不匹配已修复，旧诊断保留，未降低生产类型检查。
- 真实共享组件／适配器／store 在独立浏览器的受控 IPC 下验证：深色、浅色、窄窗口各一项通过，覆盖搜索分类、详情打开与返回、关注失败后重试、关注／取消、收藏／取消及服务端快照更新。初次 3 项通过后，为共用滚动恢复再跑相同 3 项；最终结果见 build/spotify-catalog-component-final.log。探针原始 IPC 为显式假服务，不是 Spotify 账号实测。
- 新增适配器测试最初漏注册测试 provider，5 项失败；补齐注册后通过。失败与通过分别保存在 build/spotify-catalog-new-unit.log 和 build/spotify-catalog-new-unit-retry.log，不冒充产品连接失败。

独立新版路径：`artifacts/Folia-HiFi-Spotify-Catalog-20261020/win-unpacked/Folia-HiFi-WASAPI-ASIO-HQPlayer.exe`（相对于本机 Folia 工作区）。完整装配继续保留原生音频和外部脚本，新的 renderer 与 Wrapper 模块一起进入同一 ASAR。

用户自行关闭旧候选后打开新版。下一轮只需确认新能力：搜索艺人后关注／取消，搜索专辑后收藏／取消，并核对 Spotify 客户端及 Folia 收藏分类同步。真实账号写入尚未验收，不把浏览器假服务通过算作 Spotify 服务端通过。已经通过的其他播放行为不重复测试，暂不发布。
