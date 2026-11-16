import {
  BracesRegular,
  CodeRegular,
  FolderZipRegular,
  LibraryRegular,
} from '@fluentui/react-icons'

// 无尺寸（1em）图标会随所在文本字号缩放
export const CATEGORY_ICONS = {
  v1: BracesRegular,           // JSON / 文档
  v2: CodeRegular,             // 代码
  dll: LibraryRegular,         // 动态链接库
  composite: FolderZipRegular, // 压缩包 / 多文件打包
}

// 下拉框展示顺序
export const CATEGORY_VALUES = ['v1', 'v2', 'dll', 'composite']
