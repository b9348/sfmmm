import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import zh from './locales/zh.json'
import en from './locales/en.json'
import ja from './locales/ja.json'

i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
    ja: { translation: ja },
  },
  lng: 'zh',           // 默认中文
  fallbackLng: 'zh',   // 找不到 key 时回退中文
  interpolation: {
    escapeValue: false, // React 已经做 XSS 转义
  },
})

export default i18n
