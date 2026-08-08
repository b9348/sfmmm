// 前置下载点枚举（独立文件，避免 react-refresh/only-export-components 规则
// 因组件文件导出常量而报错）。每种前置可用的下载点：name 为 i18n 键，
// 经 mods.builtinDownloadPoint 显示为"内置下载点"。
// 业务 URL：新增/变更下载点时同步更新本表，所有引用方（BepInExPrereqBanner、ModList 等）自动生效。
export const PREREQ_DOWNLOAD_POINTS = {
  // BepInEx 加载器（DLL 模组前置）
  bepinex: [{ name: 'mods.builtinDownloadPoint', url: 'https://img.b9349.dpdns.org/file/sfm/BepInEx6/BepInEx6.7z' }],
  // v1 任务前置（BepInEx 插件 SFM_custom_mission.dll + CustomMissions，含作者说明 readme.txt）
  v1: [{ name: 'mods.builtinDownloadPoint', url: 'https://img.b9349.dpdns.org/file/sfm/BepInEx/sfmmm_v1.7z' }],
}

export const BEPINEX_URL = PREREQ_DOWNLOAD_POINTS.bepinex[0].url
export const V1_PREREQ_URL = PREREQ_DOWNLOAD_POINTS.v1[0].url

// v1 前置的安装产物检测文件（相对游戏根目录）
export const V1_PREREQ_MARKER = 'BepInEx/plugins/SFM_custom_mission.dll'
