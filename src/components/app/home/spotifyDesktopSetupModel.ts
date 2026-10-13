// First-use component progress contains no account, filesystem or raw exception data.
export type DesktopSetupStatus = {
    enabled: boolean; installations: { id: string; layout: string; version: string }[]; selected?: string;
    detectionFailed: boolean; running: boolean; connected: boolean; cli: boolean; wrapper: boolean;
    extension: boolean; driver: boolean; driverEndpointsReady: boolean; engine: boolean; ready: boolean; bundleVersion: string;
    versions: { spicetify: string; cable: string };
    systemOutput?: { state: 'ready' | 'cable' | 'unknown'; names: string[] };
    install: { phase: string; busy: boolean; code?: string; operation?: string; restartRequired?: boolean };
};
export const installPhase: Record<string, string> = {
    idle: '先安装组件，再完成配置。', checking: '正在检查已有组件…', engine: '正在准备采集与路由组件…',
    spicetify: '正在下载并准备 Spicetify…', driver: '请完成 VB-CABLE 管理员授权及安装窗口。',
    installed: '组件已准备，请点击“一键配置”。', configuring: '正在配置 Spotify 桥接与采集设备…',
    created: '正在准备独立配置目录…', copied: '正在处理 Spotify 资源副本…',
    'backup-started': '正在为首次配置建立独立备份…', 'backup-complete': '独立备份已完成…',
    'apply-started': '正在将桥接应用到独立资源副本…', applied: '正在检查资源引用…', configured: '正在检查采集设备…',
    complete: '配置已完成，可以启动并连接 Spotify。', interrupted: '上次操作中断，请继续原来的安装或配置步骤。',
    'restart-required': 'VB-CABLE 安装步骤已完成，请重启 Windows。回来后点击“重新检查”，无需重复安装。',
    'verification-required': '已完成重启，但尚未检测到完整的 VB-CABLE 输入输出设备对。请重新检查或检查驱动安装。',
};
export const installError: Record<string, string> = {
    SPOTIFY_NOT_INSTALLED: '请先自行安装 Spotify 并登录。', SPOTIFY_DISCOVERY_FAILED: '安装检测失败，请重新检查。',
    SPOTIFY_INSTALL_CHOICE_REQUIRED: '请选择要连接的 Spotify 版本。', SPOTIFY_CLOSE_FOR_SETUP: '请先正常退出 Spotify，再点击一键配置。',
    SPOTIFY_LOGIN_REQUIRED: '请先打开所选 Spotify，完成登录后退出，再继续配置。',
    SPOTIFY_INSTALL_COMPONENTS_FIRST: '请先完成一键安装。', SPOTIFY_COMPONENT_DOWNLOAD_FAILED: '组件下载失败，请检查网络后重试。',
    SPOTIFY_COMPONENT_INTEGRITY: '组件校验失败，尚未安装。', SPOTIFY_NATIVE_COMPONENT_UNAVAILABLE: '随 Folia 提供的采集与路由组件不可用，请检查组件安装状态。',
    SPOTIFY_DRIVER_INSTALL_NOT_COMPLETED: 'VB-CABLE 安装未完成或已取消；已有组件保留。',
    SPOTIFY_CABLE_SELECTION_REQUIRED: '没有找到唯一的 VB-CABLE 设备对，请在输出设置中检查设备。',
    SPOTIFY_BACKUP_REVIEW_REQUIRED: '首次备份在中途停止。原进度已保留，不会重复备份；请保留回报供排查。',
    SPOTIFY_APPLY_REVIEW_REQUIRED: '组件配置在中途停止。原进度已保留，不会自动重复修改。',
    SPOTIFY_CONFIGURATION_REVIEW_REQUIRED: '检测到未完成的资源目录，已保留现场，请保留回报供排查。',
    SPOTIFY_CONFIGURE_CLI_FAILED: 'Spicetify 配置未完成；原进度已保存。',
};
