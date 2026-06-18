import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { makeStyles, tokens, Tooltip } from '@fluentui/react-components'
import {
  DismissRegular,
  SquareRegular,
  SquareMultipleRegular,
  SubtractRegular,
} from '@fluentui/react-icons'

const useStyles = makeStyles({
  titleBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: '30px',
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    userSelect: 'none',
    flexShrink: 0,
  },
  dragRegion: {
    flex: 1,
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    paddingLeft: '8px',
    appRegion: 'drag',
    '-webkit-app-region': 'drag',
  },
  title: {
    fontSize: '12px',
    fontWeight: '400',
    color: tokens.colorNeutralForeground1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  controls: {
    display: 'flex',
    height: '100%',
    appRegion: 'no-drag',
    '-webkit-app-region': 'no-drag',
  },
  controlButton: {
    width: '45px',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    transition: 'background-color 0.1s ease',
    '&:hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
    '&:active': {
      backgroundColor: tokens.colorNeutralBackground1Pressed,
    },
  },
  closeButton: {
    width: '45px',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    transition: 'background-color 0.1s ease',
    '&:hover': {
      backgroundColor: '#e81123',
      color: '#ffffff',
    },
    '&:active': {
      backgroundColor: '#f1707a',
      color: '#000000',
    },
  },
  icon: {
    fontSize: '10px',
  },
})

export function TitleBar() {
  const styles = useStyles()
  const { t } = useTranslation()
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    const checkMaximized = async () => {
      const appWindow = getCurrentWindow()
      const maximized = await appWindow.isMaximized()
      setIsMaximized(maximized)
    }

    checkMaximized()

    const appWindow = getCurrentWindow()
    const unlisten = appWindow.onResized(() => {
      checkMaximized()
    })

    return () => {
      unlisten.then((fn) => fn())
    }
  }, [])

  const handleMinimize = async () => {
    const appWindow = getCurrentWindow()
    await appWindow.minimize()
  }

  const handleMaximize = async () => {
    const appWindow = getCurrentWindow()
    await appWindow.toggleMaximize()
    const maximized = await appWindow.isMaximized()
    setIsMaximized(maximized)
  }

  const handleClose = async () => {
    const appWindow = getCurrentWindow()
    await appWindow.close()
  }

  return (
    <div className={styles.titleBar}>
      <div data-tauri-drag-region className={styles.dragRegion}>
        <span className={styles.title}>{t('app.title')}</span>
      </div>
      <div className={styles.controls}>
        <Tooltip content={t('window.minimize')} relationship="label">
          <button
            className={styles.controlButton}
            onClick={handleMinimize}
            aria-label={t('window.minimize')}
          >
            <SubtractRegular className={styles.icon} />
          </button>
        </Tooltip>
        <Tooltip content={isMaximized ? t('window.restore') : t('window.maximize')} relationship="label">
          <button
            className={styles.controlButton}
            onClick={handleMaximize}
            aria-label={isMaximized ? t('window.restore') : t('window.maximize')}
          >
            {isMaximized ? (
              <SquareMultipleRegular className={styles.icon} />
            ) : (
              <SquareRegular className={styles.icon} />
            )}
          </button>
        </Tooltip>
        <Tooltip content={t('window.close')} relationship="label">
          <button
            className={styles.closeButton}
            onClick={handleClose}
            aria-label={t('window.close')}
          >
            <DismissRegular className={styles.icon} />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
