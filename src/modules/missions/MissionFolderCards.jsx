import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Text, Button, Badge, Tooltip, tokens } from '@fluentui/react-components'
import {
  FolderOpen24Regular, Document24Regular, Folder24Regular,
  Play24Regular, Pause24Regular, Delete24Regular,
  Cloud24Regular, ArrowDownload24Regular,
} from '@fluentui/react-icons'
import { LANG_LABELS } from '../../i18n/languages'
import { RatingStarsDisplay } from '../../components/common/RatingStars'
import { useMissionStyles } from './missionStyles'
import { getChildCount, getExt } from './missionFs'

// 从 mod_key 中剥离末尾版本号，返回 { base, version }
// mod_key 常把版本号附在末尾（如 "Freer 1.1.4.4"、"Manaka's Challenge v0.2"），
// 优先用已安装版本（installed_version）精确匹配末尾；匹配不到时正则兜底点分版本号。
function splitModKeyTitle(modKey, installedVersion) {
  const k = String(modKey || '').trim()
  if (!k) return { base: '', version: '' }
  const v = String(installedVersion || '').trim()
  if (v && k.endsWith(v)) {
    const base = k.slice(0, -v.length).replace(/[\s\-_]+$/, '')
    return { base: base || k, version: v }
  }
  const m = k.match(/^(.*?)\s*v?((?:\d+\.)+\d+)\s*$/)
  if (m) return { base: m[1].trim() || k, version: m[2] }
  return { base: k, version: '' }
}

// 创意工坊订阅标题行：有显示名（且与文件名不同）时合并为「显示名 - 基础名 v(版本)」单行，
// 显示名加粗醒目、其余灰色；无显示名时退回「模组标识: mod_key」。
function WorkshopTitleLine({ name, modKey, displayName, version }) {
  const { t } = useTranslation()
  const styles = useMissionStyles()
  if (!modKey) return null
  const showDisplay = displayName && displayName !== name
  const { base, version: ver } = showDisplay ? splitModKeyTitle(modKey, version) : { base: modKey, version: '' }
  return (
    <Text size="xSmall" className={styles.workshopKey} title={modKey}>
      {showDisplay ? (
        <>
          <Text weight="semibold" as="span" style={{ color: tokens.colorNeutralForeground1 }}>{displayName}</Text>
          {' - '}{base}{ver ? ` v(${ver})` : ''}
        </>
      ) : (
        `${t('mods.modKeyLabel')}: ${modKey}`
      )}
    </Text>
  )
}

// 创意工坊 mod 的操作按钮组：查看详情 / 更新（仅当有更新）/ 退订，三者并排
// 单卡片与分组组头共用，替代原来的三点菜单
function ModCardActions({ modKey, hasUpdate, onViewDetail, onUpdate, onUninstall, pushRight = true }) {
  const { t } = useTranslation()
  const styles = useMissionStyles()
  if (!modKey) return null
  return (
    <div className={pushRight ? styles.groupActionsPush : styles.groupActions}>
      <Tooltip content={t('mods.menuViewDetail')} relationship="label">
        <Button size="small" icon={<Cloud24Regular />} appearance="subtle" onClick={(e) => { e.stopPropagation(); onViewDetail(modKey) }} />
      </Tooltip>
      {hasUpdate && (
        <Tooltip content={t('mods.menuUpdate')} relationship="label">
          <Button size="small" icon={<ArrowDownload24Regular />} appearance="subtle" onClick={(e) => { e.stopPropagation(); onUpdate(modKey) }} />
        </Tooltip>
      )}
      {onUninstall && (
        <Tooltip content={t('mods.uninstall')} relationship="label">
          <Button size="small" icon={<Delete24Regular />} appearance="subtle" onClick={(e) => { e.stopPropagation(); onUninstall({ name: modKey, modKey }) }} />
        </Tooltip>
      )}
    </div>
  )
}

// 卡片外壳：容器外观、选中描边、单击/双击与可选 id（供外部滚动定位）
function MissionCardShell({ fullPath, inGroup, selected, onSelect, onNavigate, children }) {
  const styles = useMissionStyles()
  return (
    <div
      className={inGroup ? styles.innerCard : styles.card}
      id={`mission-item-${encodeURIComponent(fullPath)}`}
      onClick={(e) => { onSelect?.(fullPath, e) }}
      onDoubleClick={onNavigate ? (e) => { if (!e.ctrlKey && !e.shiftKey) onNavigate(fullPath) } : undefined}
      style={{
        border: selected ? `2px solid ${tokens.colorBrandStroke1}` : undefined,
        boxShadow: selected ? `0 0 0 2px ${tokens.colorBrandBackground2}, ${tokens.shadow4}` : undefined,
      }}
    >
      {children}
    </div>
  )
}

// 创意工坊订阅卡片的信息区：显示名+mod_key 合并标题行，与云端简介
function WorkshopInfoBlock({ name, modKey, workshopDetail, cloudInfo }) {
  const styles = useMissionStyles()
  return (
    <div className={styles.workshopInfo}>
      <WorkshopTitleLine name={name} modKey={modKey} displayName={cloudInfo?.displayName} version={workshopDetail?.version} />
      {cloudInfo?.description && (
        <Text size="small" className={styles.workshopDescription}>{cloudInfo.description}</Text>
      )}
    </div>
  )
}

// 工坊相关徽章组：工坊标识 / 版本 / 语言 / 评分 / 来源不一致。
// leading 放文件自身徽章（扩展名、禁用），afterBadge 放组员数，trailing 放更新徽章。
function WorkshopBadges({ workshopDetail, cloudInfo, show = true, leading = null, afterBadge = null, trailing = null }) {
  const { t } = useTranslation()
  return (
    <>
      {leading}
      {show && <Badge appearance="filled" color="success" size="small">{t('mods.workshopBadge')}</Badge>}
      {afterBadge}
      {show && workshopDetail?.version && <Badge appearance="outline" size="small">v{workshopDetail.version}</Badge>}
      {show && workshopDetail?.langCode && <Badge appearance="outline" size="small">{LANG_LABELS[workshopDetail.langCode] || workshopDetail.langCode}</Badge>}
      {show && cloudInfo?.ratingCount > 0 && (
        <RatingStarsDisplay value={cloudInfo.ratingAvg} count={cloudInfo.ratingCount} size="small" compact />
      )}
      {show && workshopDetail?.fileHash && cloudInfo?.latestFileHash && workshopDetail.fileHash !== cloudInfo.latestFileHash && (
        <Badge appearance="filled" color="danger" size="small">{t('mods.sourceMismatch')}</Badge>
      )}
      {trailing}
    </>
  )
}

export function FolderCard({ name, fullPath, onNavigate, isWorkshop, workshopDetail, cloudInfo, onUninstall, hasUpdate, modKey, onViewDetail, onUpdate, inGroup = false, selected = false, onSelect, onOpenLocation }) {
  const { t } = useTranslation()
  const styles = useMissionStyles()
  const [childInfo, setChildInfo] = useState(null)

  useEffect(() => {
    let cancelled = false
    getChildCount(fullPath).then(info => {
      if (!cancelled) setChildInfo(info)
    })
    return () => { cancelled = true }
  }, [fullPath])

  // 分组模式下工坊信息统一显示在组头，成员卡片保持精简
  const showWorkshopInfo = isWorkshop && !inGroup

  return (
    <MissionCardShell fullPath={fullPath} inGroup={inGroup} selected={selected} onSelect={onSelect} onNavigate={onNavigate}>
      <div className={styles.cardHeader}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
          <Folder24Regular />
          <Text size="small" weight="semibold" className={styles.fileName}>{name}</Text>
        </div>
        {childInfo && (
          <Text size="small" className={styles.meta}>
            {childInfo.dirs > 0
              ? t('mission.folderCount', { dirs: childInfo.dirs, files: childInfo.total - childInfo.dirs })
              : t('mission.itemCount', { count: childInfo.total })}
          </Text>
        )}
      </div>
      {showWorkshopInfo && (
        <WorkshopInfoBlock name={name} modKey={modKey} workshopDetail={workshopDetail} cloudInfo={cloudInfo} />
      )}
      <div className={styles.buttonRow}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', marginRight: 'auto' }}>
          <WorkshopBadges show={showWorkshopInfo} workshopDetail={workshopDetail} cloudInfo={cloudInfo} />
        </div>
        <Tooltip content={t('mods.openContainingFolder')} relationship="label">
          <Button size="small" icon={<FolderOpen24Regular />} appearance="subtle" onClick={(e) => { e.stopPropagation(); onOpenLocation?.(fullPath) }} />
        </Tooltip>
        {showWorkshopInfo && (
          <ModCardActions modKey={modKey} hasUpdate={hasUpdate} onViewDetail={onViewDetail} onUpdate={onUpdate} onUninstall={onUninstall} pushRight={false} />
        )}
      </div>
    </MissionCardShell>
  )
}

export function FileCard({ name, fullPath, isBanned, onToggle, isWorkshop, hasUpdate, workshopDetail, cloudInfo, onUninstall, modKey, onViewDetail, onUpdate, inGroup = false, selected = false, onSelect, onOpenLocation }) {
  const { t } = useTranslation()
  const styles = useMissionStyles()
  const ext = getExt(name)
  // 分组模式下工坊信息统一显示在组头，成员卡片保持精简
  const showWorkshopInfo = isWorkshop && !inGroup
  return (
    <MissionCardShell fullPath={fullPath} inGroup={inGroup} selected={selected} onSelect={onSelect}>
      <div className={styles.cardHeader}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
          <Document24Regular />
          <Text size="small" weight="semibold" className={styles.fileName}>{name}</Text>
        </div>
      </div>
      {showWorkshopInfo && (
        <WorkshopInfoBlock name={name} modKey={modKey} workshopDetail={workshopDetail} cloudInfo={cloudInfo} />
      )}
      <div className={styles.buttonRow}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', marginRight: 'auto' }}>
          <WorkshopBadges
            show={showWorkshopInfo}
            workshopDetail={workshopDetail}
            cloudInfo={cloudInfo}
            leading={(
              <>
                <Badge appearance="outline" size="small">{ext.toUpperCase()}</Badge>
                {isBanned && <Badge appearance="filled" color="danger" size="small">{t('mods.disabled')}</Badge>}
              </>
            )}
            trailing={!inGroup && hasUpdate ? <Badge appearance="filled" color="warning" size="small">{t('mods.hasUpdate')}</Badge> : null}
          />
        </div>
        <Tooltip content={t('mods.openContainingFolder')} relationship="label">
          <Button size="small" icon={<FolderOpen24Regular />} appearance="subtle" onClick={(e) => { e.stopPropagation(); onOpenLocation?.(fullPath) }} />
        </Tooltip>
        <Tooltip content={isBanned ? t('mods.enable') : t('mods.disable')} relationship="label">
          <Button
            size="small"
            icon={isBanned ? <Play24Regular /> : <Pause24Regular />}
            appearance="subtle"
            onClick={(e) => { e.stopPropagation(); onToggle(fullPath) }}
          />
        </Tooltip>
        {showWorkshopInfo && (
          <ModCardActions modKey={modKey} hasUpdate={hasUpdate} onViewDetail={onViewDetail} onUpdate={onUpdate} onUninstall={onUninstall} pushRight={false} />
        )}
      </div>
    </MissionCardShell>
  )
}

// 同一创意工坊订阅源（同 mod_key）下多个文件/文件夹的分组卡片：
// 订阅级信息与操作集中在组头，组内成员保留各自的独立交互（打开、启用/停用等）
export function ModGroupCard({ modKey, items, children, workshopDetail, cloudInfo, hasUpdate, onViewDetail, onUpdate, onUninstall, onDisableAll, onEnableAll, itemsPerRow = 3 }) {
  const { t } = useTranslation()
  const styles = useMissionStyles()
  const title = cloudInfo?.displayName || modKey
  return (
    <div className={styles.groupCard}>
      <div className={styles.groupHeader}>
        <Cloud24Regular />
        <Tooltip content={modKey} relationship="label">
          <Text size="small" weight="semibold" className={styles.fileName}>{title}</Text>
        </Tooltip>
      </div>
      {/* 订阅级信息：mod_key 与云端简介 */}
      <div className={styles.workshopInfo}>
        <Text size="xSmall" className={styles.workshopKey}>{t('mods.modKeyLabel')}: {modKey}</Text>
        {cloudInfo?.description && (
          <Text size="small" className={styles.workshopDescription}>{cloudInfo.description}</Text>
        )}
      </div>
      <div className={styles.groupInnerGrid} style={{ gridTemplateColumns: `repeat(${itemsPerRow}, minmax(0, 1fr))` }}>
        {children}
      </div>
      <div className={styles.buttonRow}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', marginRight: 'auto' }}>
          <WorkshopBadges
            workshopDetail={workshopDetail}
            cloudInfo={cloudInfo}
            afterBadge={<Badge appearance="outline" size="small">{t('mods.groupCount', { count: items.length })}</Badge>}
            trailing={hasUpdate ? <Badge appearance="filled" color="warning" size="small">{t('mods.hasUpdate')}</Badge> : null}
          />
        </div>
        <Tooltip content={t('mods.disableAll')} relationship="label">
          <Button size="small" icon={<Pause24Regular />} appearance="subtle" onClick={(e) => { e.stopPropagation(); onDisableAll?.(modKey) }} />
        </Tooltip>
        <Tooltip content={t('mods.enableAll')} relationship="label">
          <Button size="small" icon={<Play24Regular />} appearance="subtle" onClick={(e) => { e.stopPropagation(); onEnableAll?.(modKey) }} />
        </Tooltip>
        <ModCardActions modKey={modKey} hasUpdate={hasUpdate} onViewDetail={onViewDetail} onUpdate={onUpdate} onUninstall={onUninstall} pushRight={false} />
      </div>
    </div>
  )
}
