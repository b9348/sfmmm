import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardHeader, Text, Button, Title2 } from '@fluentui/react-components'
import { Person24Regular } from '@fluentui/react-icons'
import { useAuth } from '../../contexts/useAuth'
import { LoginDialog } from './LoginForm'

/**
 * 社区内容登录门禁：未登录时不渲染内容，展示引导登录卡片。
 * 用于 创意工坊 / 通知 等社区页面——所有社区内容需登录后查看。
 */
export function RequireLogin({ children }) {
  const { t } = useTranslation()
  const { isLoggedIn, initialized } = useAuth()
  const [authOpen, setAuthOpen] = useState(false)

  // 本地登录态尚未从数据库加载完成：先不渲染，避免闪现登录引导
  if (!initialized) return null
  if (isLoggedIn) return children

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '16px' }}>
      <Card appearance="outline" style={{ maxWidth: '360px', width: '100%' }}>
        <CardHeader
          header={<Title2><span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}><Person24Regular />{t('nav.loginRegister')}</span></Title2>}
        />
        <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <Text size="small" style={{ color: 'var(--colorNeutralForeground3, #616161)' }}>
            {t('workshop.loginRequiredDesc')}
          </Text>
          <Button appearance="primary" onClick={() => setAuthOpen(true)}>
            {t('workshop.loginNow')}
          </Button>
        </div>
      </Card>
      <LoginDialog open={authOpen} onClose={() => setAuthOpen(false)} onSuccess={() => setAuthOpen(false)} />
    </div>
  )
}
