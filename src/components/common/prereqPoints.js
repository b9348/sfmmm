// 前置下载点枚举（独立文件，避免 react-refresh/only-export-components 规则
// 因组件文件导出常量而报错）。每种前置可用的下载点：name 为 i18n 键，
// 经 mods.builtinDownloadPoint 显示为"内置下载点"。
// 业务 URL：新增/变更下载点时同步更新本表，所有引用方（BepInExPrereqBanner、ModList 等）自动生效。
export const PREREQ_DOWNLOAD_POINTS = {
  // BepInEx 加载器（DLL 模组前置）：默认源（蓝奏云，分享页链接，Rust 端 lanzou 模块解析成直链后下载）
  // + 备用源（Cloudflare / HuggingFace 分发）。
  // name 直接用源全拼显示在并列按钮上（不再用"内置下载点"命名）。
  bepinex: [
    { name: 'Lanzou', url: 'https://wwbad.lanzoum.com/iteVj43d89fi' },
    { name: 'Cloudflare', url: 'https://img.b9349.dpdns.org/file/sfm/BepInEx6/BepInEx6(1).7z' },
    { name: 'HuggingFace', url: 'https://img.b9349.dpdns.org/file/sfm/BepInEx6/BepInEx6.7z' },
  ],
  // v1 任务前置（BepInEx 插件 SFM_custom_mission.dll + CustomMissions，含作者说明 readme.txt）
  v1: [{ name: 'mods.builtinDownloadPoint', url: 'https://img.b9349.dpdns.org/file/sfm/BepInEx/sfmmm_v1.7z' }],
  // v2 任务前置（BepInEx 插件 SFM_custom_mission_v2.dll + GUI 资源；含中文字体 NotoSerifSC-Regular.otf，放游戏根目录）
  v2: [{ name: 'mods.builtinDownloadPoint', url: 'https://img.b9349.dpdns.org/file/sfm/BepInEx/sfmmm_v2.7z' }],
  // 去马赛克补丁（rmMosaic：d3d11.dll 等，全部粘贴到游戏根目录）
  rmmosaic: [{ name: 'mods.builtinDownloadPoint', url: 'https://img.b9349.dpdns.org/file/sfm/BepInEx/rmMosaic.7z' }],
}

export const BEPINEX_URL = PREREQ_DOWNLOAD_POINTS.bepinex[0].url
// BepInEx 默认（首个）下载源的显示名：直接用源全拼（Lanzou），供 ModList 等单按钮场景使用
export const BEPINEX_SOURCE_NAME = PREREQ_DOWNLOAD_POINTS.bepinex[0].name
export const V1_PREREQ_URL = PREREQ_DOWNLOAD_POINTS.v1[0].url
export const V2_PREREQ_URL = PREREQ_DOWNLOAD_POINTS.v2[0].url
export const RMMOSAIC_URL = PREREQ_DOWNLOAD_POINTS.rmmosaic[0].url

// SFMMM 实测推荐使用的 Doorstop 引导器版本（BepInEx 6 内置）。
// 与 Rust scan_mods 的 RECOMMENDED_DOORSTOP_VERSION 保持一致：
// 已安装的 .doorstop_version 不是此版本时，卡片提示兼容性问题并引导重装推荐版本框架。
export const RECOMMENDED_DOORSTOP_VERSION = '4.3.0'

// v1 前置的安装产物检测文件（相对游戏根目录）
export const V1_PREREQ_MARKER = 'BepInEx/plugins/SFM_custom_mission.dll'
// v2 前置的安装产物检测文件（相对游戏根目录）
export const V2_PREREQ_MARKER = 'BepInEx/plugins/SFM_custom_mission_v2.dll'
// v2 前置附带的中文字体（仅中文用户检测；其他语言不检测）。放游戏根目录。
export const V2_PREREQ_FONT = 'NotoSerifSC-Regular.otf'
// 去马赛克补丁的安装产物检测文件（游戏根目录）
export const RMMOSAIC_MARKER = 'd3d11.dll'
