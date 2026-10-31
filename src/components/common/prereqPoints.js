// 前置下载点枚举（独立文件，避免 react-refresh/only-export-components 规则
// 因组件文件导出常量而报错）。每种前置可用的下载点：name 为 i18n 键，
// 经 mods.builtinDownloadPoint 显示为"内置下载点"。
// 业务 URL：新增/变更下载点时同步更新本表，所有引用方（BepInExPrereqBanner、ModList 等）自动生效。
export const PREREQ_DOWNLOAD_POINTS = {
  // BepInEx 加载器（DLL 模组前置）：默认源（蓝奏云，分享页链接，Rust 端 lanzou 模块解析成直链后下载）
  // + 备用源（Cloudflare / HuggingFace 分发）。
  // name 直接用源全拼显示在并列按钮上（不再用"内置下载点"命名）。
  bepinex: [
    { name: 'Lanzou', url: 'https://wwbad.lanzouc.com/ikfoW4a5am1i' },
    { name: 'Cloudflare', url: 'https://img.b9349.dpdns.org/file/sfm/BepInEx6/BepInEx6.7z' },
    { name: 'HuggingFace', url: 'https://img.b9349.dpdns.org/file/sfm/BepInEx6/BepInEx6.7z' },
  ],
  // v1 任务前置（BepInEx 插件 SFM_custom_mission.dll + CustomMissions，含作者说明 readme.txt）
  v1: [{ name: 'mods.builtinDownloadPoint', url: 'https://img.b9349.dpdns.org/file/sfm/BepInEx/sfmmm_v1.7z' }],
  // v2 任务前置（BepInEx 插件 SFM_custom_mission_v2.dll + GUI 资源；含中文字体 NotoSerifSC-Regular.otf，放游戏根目录）。
  // 蓝奏云分享链接（Rust 端 lanzou 模块解析成直链后下载，压缩格式从分享页文件名推断）
  // + 内置直链（服务器 cmv2.7z）。
  v2: [
    { name: 'Lanzou', url: 'https://wwbad.lanzouc.com/iPQ844a84rji' },
    { name: 'mods.builtinDownloadPoint', url: 'https://img.b9349.dpdns.org/file/sfm/BepInEx/cmv2.7z' },
  ],
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
export const RECOMMENDED_DOORSTOP_VERSION = '4.5.0'

// v1 前置的安装产物检测文件（相对游戏根目录）
export const V1_PREREQ_MARKER = 'BepInEx/plugins/SFM_custom_mission.dll'
// v2 前置的安装产物检测文件（相对游戏根目录）
export const V2_PREREQ_MARKER = 'BepInEx/plugins/SFM_custom_mission_v2.dll'
// v2 前置附带的中文字体（仅中文用户检测；其他语言不检测）。放游戏根目录。
export const V2_PREREQ_FONT = 'NotoSerifSC-Regular.otf'

// v2 前置版本基准指纹（2.3.8），采集自官方分发包内的
// BepInEx/plugins/SFM_custom_mission_v2.dll：
//   - DLL_MTIME_MS：该文件修改时间的 epoch 毫秒。7z 分发包解压时 sevenz-rust
//     会还原条目 mtime，故已安装 dll 的修改时间即打包时的原始时间，可与基准
//     直接比对新旧；
//   - DLL_SHA256：文件内容哈希。修改时间早于基准时用它复核——一致视为同版本
//     （容忍 FAT/exFAT 时间戳粒度等误差），不一致才提示用户更新。
// 发布新版前置包后需手动同步更新这三个值（重测参考文件的修改时间与哈希）。
export const V2_PREREQ_VERSION = '2.3.8'
export const V2_PREREQ_DLL_MTIME_MS = 1790673694489 // 2026-09-29 17:21:34.489 +08:00
export const V2_PREREQ_DLL_SHA256 = '5dd37809c7f701751087e9d45485ae6b3ec00fe6e14d4e5dd437c9604ff9928b'
// 去马赛克补丁的安装产物检测文件（游戏根目录）
export const RMMOSAIC_MARKER = 'd3d11.dll'
