// 前置下载点枚举（独立文件，避免 react-refresh/only-export-components 规则
// 因组件文件导出常量而报错）。每种前置可用的下载点：name 为 i18n 键，
// 经 mods.builtinDownloadPoint 显示为"内置下载点"。
// 业务 URL：新增/变更下载点时同步更新本表，所有引用方（PrereqTable、ModList 等）自动生效。
export const PREREQ_DOWNLOAD_POINTS = {
  // BepInEx 加载器（DLL 模组前置）：默认源（蓝奏云，分享页链接，Rust 端 lanzou 模块解析成直链后下载）
  // + 备用源（Cloudflare / HuggingFace 分发）。
  // name 直接用源全拼显示在并列按钮上（不再用"内置下载点"命名）。
  bepinex: [
    { name: 'Lanzou', url: 'https://lanzou.example.com/s/example1' },
    { name: 'Cloudflare', url: 'https://img.example.com/file/sfm/BepInEx6/BepInEx6.7z' },
    { name: 'HuggingFace', url: 'https://img.example.com/file/sfm/BepInEx6/BepInEx6.7z' },
  ],
  // v1 任务前置（BepInEx 插件 SFM_custom_mission.dll + CustomMissions，含作者说明 readme.txt）
  v1: [{ name: 'mods.builtinDownloadPoint', url: 'https://img.example.com/file/sfm/BepInEx/sfmmm_v1.7z' }],
  // v2 任务前置（BepInEx 插件 SFM_custom_mission_v2.dll + GUI 资源）。
  // 内置直链为官方 2.4.0 分发包（zip，Rust 端按扩展名走 zip crate 解压）；
  // 蓝奏云分享链接由 Rust 端 lanzou 模块解析成直链后下载，压缩格式从分享页文件名推断。
  v2: [
    { name: 'mods.builtinDownloadPoint', url: 'https://img.example.com/file/sfm/BepInEx/SFM_custom_mission_v2_2.4.0.zip' },
    { name: 'Lanzou', url: 'https://lanzou.example.com/s/example2' },
  ],
  // 中文字体（NotoSerifSC-Regular.otf，解压到游戏根目录）。v2 前置包从 2.4.0 起
  // 不再附带字体，检测到缺失时由前置卡片单独从本下载点安装。
  font: [{ name: 'Lanzou', url: 'https://lanzou.example.com/s/example3' }],
  // 去马赛克补丁（rmMosaic：d3d11.dll 等，归档内是「全部粘贴到游戏根目录即可」单层目录，
  // 解压时由 Rust 端 decompress_archive 自动展开到游戏根目录）。
  rmmosaic: [
    { name: 'mods.builtinDownloadPoint', url: 'https://img.example.com/file/sfm/BepInEx/rmMosaic.7z' },
    { name: 'Lanzou', url: 'https://lanzou.example.com/s/example4' },
  ],
}

// SFMMM 实测推荐使用的 Doorstop 引导器版本（BepInEx 6 内置）。
// 与 Rust scan_mods 的 RECOMMENDED_DOORSTOP_VERSION 保持一致：
// 已安装的 .doorstop_version 不是此版本时，卡片提示兼容性问题并引导重装推荐版本框架。
export const RECOMMENDED_DOORSTOP_VERSION = '4.5.0'

// v1 前置的安装产物检测文件（相对游戏根目录）
export const V1_PREREQ_MARKER = 'BepInEx/plugins/SFM_custom_mission.dll'
// v2 前置附带的中文字体（仅中文用户检测；其他语言不检测）。放游戏根目录。
export const V2_PREREQ_FONT = 'NotoSerifSC-Regular.otf'

// v2 前置版本基准（2.4.0）定义在 Rust 端 commands/v2_prereq.rs 的 REQUIRED，
// 检测时由 check_v2_prereq_version 一并返回已安装版本与要求版本，前端不再各自
// 保存指纹/版本常量，避免双端漂移。

// v2 前置（CMV2）的 F95 原发布页：版本过低 toast 的「打开 F95 原网站」入口。
export const V2_F95_URL =
  'https://f95zone.to/threads/secret-flasher-manaka-custom-missions-1-2-1-version-2-4-0.263276/'

// 去马赛克补丁的安装产物检测文件（游戏根目录）
export const RMMOSAIC_MARKER = 'd3d11.dll'
