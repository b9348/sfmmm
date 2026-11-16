import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores([
    'dist',
    'src-tauri/target',
    // 以下目录已在 .gitignore 中忽略，仅存在于本地：图床迁移导出、数据库备份、
    // Agent 临时工作树（内含整份仓库副本）。它们不是本项目源码，不应参与 lint。
    '.imgbed-migration*',
    'imgbed-migration-*',
    '.sqlbak',
    '.claude/worktrees',
  ]),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
])
