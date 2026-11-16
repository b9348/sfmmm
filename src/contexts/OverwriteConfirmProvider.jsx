import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import OverwriteConfirmContext from './OverwriteConfirmContext'

const useStyles = makeStyles({
  hint: {
    display: 'block',
    color: tokens.colorNeutralForeground2,
  },
  section: {
    marginTop: '12px',
  },
  sectionTitle: {
    display: 'block',
    fontWeight: tokens.fontWeightSemibold,
    marginBottom: '4px',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    maxHeight: '180px',
    overflowY: 'auto',
    padding: '8px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  groupTitle: {
    display: 'block',
    color: tokens.colorNeutralForeground2,
  },
  path: {
    display: 'block',
    paddingLeft: '8px',
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    wordBreak: 'break-all',
  },
  note: {
    display: 'block',
    marginTop: '4px',
    color: tokens.colorNeutralForeground3,
  },
})

/**
 * 安装覆盖 / 本地残留确认 Provider（挂在 App 内，需在 FluentProvider 之内）。
 *
 * 用法：const overwrite = useOverwriteConfirm()
 *       if (await overwrite.confirmOverwrite(check)) 继续安装
 *
 * 一个弹窗展示两个区块：
 *   1) 将被覆盖：按来源 mod 分组（其他 mod / 非 mod 安装的本机文件），可滚动；
 *   2) 本地残留：旧版本清单有、新版本清单没有的文件，只提示，不提供删除。
 * 用户取消时 resolve(false)，调用方据此不发起下载。
 */
export function OverwriteConfirmProvider({ children }) {
  const styles = useStyles()
  const { t } = useTranslation()
  const [check, setCheck] = useState(null)
  const resolverRef = useRef(null)

  const confirmOverwrite = useCallback((result) => new Promise((resolve) => {
    // 并发请求（如快速连点）时先让上一次以「取消」结束，避免 Promise 永不 resolve
    resolverRef.current?.(false)
    resolverRef.current = resolve
    setCheck(result)
  }), [])

  const settle = useCallback((ok) => {
    setCheck(null)
    const resolve = resolverRef.current
    resolverRef.current = null
    resolve?.(ok)
  }, [])

  // 卸载时把挂起的 confirmOverwrite Promise 以「取消」结束，避免调用方永久等待
  useEffect(() => () => {
    resolverRef.current?.(false)
    resolverRef.current = null
  }, [])

  // 按来源分组：其他 mod 优先，非 mod 文件在后
  const groups = useMemo(() => {
    const map = new Map()
    for (const c of check?.conflicts || []) {
      const key = c.owner || '__local__'
      if (!map.has(key)) {
        map.set(key, { key, kind: c.kind, name: c.ownerName || c.owner, files: [] })
      }
      map.get(key).files.push(c.path)
    }
    return [...map.values()]
  }, [check])
  const staleFiles = check?.staleFiles || []
  const invalidPaths = check?.invalidPaths || []
  // 清单里有非法路径时解压端会直接中止并留下半成品，因此禁止继续安装，
  // 弹窗只展示具体路径并给一个「关闭（不安装）」按钮。
  const blockedByInvalid = invalidPaths.length > 0

  const value = useMemo(() => ({ confirmOverwrite }), [confirmOverwrite])

  return (
    <OverwriteConfirmContext.Provider value={value}>
      {children}
      <Dialog open={!!check} onOpenChange={(_, { open }) => { if (!open) settle(false) }}>
        <DialogSurface style={{ maxWidth: '640px' }}>
          <DialogBody>
            <DialogTitle>{blockedByInvalid ? t('workshop.overwriteInvalidTitle') : t('workshop.overwriteTitle')}</DialogTitle>
            <DialogContent style={{ maxHeight: '70vh', overflowY: 'auto' }}>
              {!!check?.conflictCount && (
                <Text className={styles.hint} size="small">
                  {t('workshop.overwriteHint', {
                    total: check?.totalFiles ?? 0,
                    count: check?.conflictCount ?? 0,
                  })}
                </Text>
              )}

              {groups.length > 0 && (
                <div className={styles.section}>
                  <Text className={styles.sectionTitle} size="small">
                    {t('workshop.overwriteCoveredTitle', { count: check?.conflictCount ?? 0 })}
                  </Text>
                  <div className={styles.list}>
                    {groups.map((g) => (
                      <div key={g.key}>
                        <Text className={styles.groupTitle} size="small">
                          {g.kind === 'user_file'
                            ? t('workshop.overwriteFromUser', { count: g.files.length })
                            : g.kind === 'self_update'
                              ? t('workshop.overwriteFromSelf', { count: g.files.length })
                              : t('workshop.overwriteFromMod', { name: g.name, count: g.files.length })}
                        </Text>
                        {g.files.map((p, i) => (
                          // conflicts 可能含重复路径（同名文件多来源），拼 index 避免重复 key
                          <Text key={`${i}-${p}`} className={styles.path} size="small">{p}</Text>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {staleFiles.length > 0 && (
                <div className={styles.section}>
                  <Text className={styles.sectionTitle} size="small">
                    {t('workshop.overwriteStaleTitle', { count: staleFiles.length })}
                  </Text>
                  <Text className={styles.note} size="small">{t('workshop.overwriteStaleHint')}</Text>
                  <div className={styles.list}>
                    {staleFiles.map((p, i) => (
                      <Text key={`${i}-${p}`} className={styles.path} size="small">{p}</Text>
                    ))}
                  </div>
                </div>
              )}

              {check?.hasNestedZip && (
                <div className={styles.section}>
                  <Text className={styles.note} size="small">{t('workshop.overwriteNestedZip')}</Text>
                </div>
              )}

              {blockedByInvalid && (
                <div className={styles.section}>
                  <Text className={styles.sectionTitle} size="small">
                    {t('workshop.overwriteInvalidTitle')}
                  </Text>
                  <Text className={styles.note} size="small">{t('workshop.overwriteInvalidHint')}</Text>
                  <div className={styles.list}>
                    {invalidPaths.map((p, i) => (
                      <Text key={`${i}-${p}`} className={styles.path} size="small">{p}</Text>
                    ))}
                  </div>
                </div>
              )}
            </DialogContent>
            <DialogActions>
              {blockedByInvalid ? (
                <Button size="small" appearance="primary" onClick={() => settle(false)}>
                  {t('workshop.overwriteInvalidBlocked')}
                </Button>
              ) : (
                <>
                  <Button size="small" appearance="subtle" onClick={() => settle(false)}>
                    {t('workshop.cancel')}
                  </Button>
                  <Button size="small" appearance="primary" onClick={() => settle(true)}>
                    {check?.conflictCount
                      ? t('workshop.overwriteConfirm')
                      : t('workshop.continueInstall')}
                  </Button>
                </>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </OverwriteConfirmContext.Provider>
  )
}
