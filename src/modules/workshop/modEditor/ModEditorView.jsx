import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Text, Button, Input, Select, makeStyles, tokens,
  Dialog, DialogTrigger, DialogSurface,
  DialogBody, DialogTitle, DialogContent,
  Checkbox,
  Tooltip,
} from '@fluentui/react-components'
import { Save24Regular, ArrowLeft24Regular, Info16Regular, Warning24Regular } from '@fluentui/react-icons'
import { useAuth } from '../../../contexts/useAuth'
import { LanguageTranslationBlock } from '../LanguageTranslationBlock'
import { CategorySelect, ConfirmDialog, BackButton, ProgressModal, FloatingActions } from '../../../components'
import PermissionSettings from '../PermissionSettings'
import { ModFilePatchPanel } from './ModFilePatchPanel'
import { KeepaliveLight } from '../../../components/common/KeepaliveLight'
import { LANGUAGES } from '../../../i18n/languages'
import { formatSpeed } from '../../../utils/formatSpeed'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  toolbarRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
  },
  formRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    marginBottom: '8px',
    flexShrink: 0,
  },
  formLabel: {
    fontSize: tokens.fontSizeSmall,
    fontWeight: '600',
  },
  langHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginTop: '8px',
    marginBottom: '4px',
  },
  stickyToolbar: {
    position: 'sticky',
    top: 0,
    zIndex: 10,
    backgroundColor: tokens.colorNeutralBackground1,
    paddingTop: '8px',
    paddingBottom: '8px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
  // 清单自愈失败的非阻断提示：只提醒 + 给重试入口，不挡保存、不挡关闭
  repairBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
    padding: '8px 10px',
    margin: '8px 0',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorStatusWarningStroke2}`,
    backgroundColor: tokens.colorStatusWarningBackground2,
    color: tokens.colorStatusWarningForeground1,
  },
})

export function ModEditorView({ mode, onClose, editor }) {
  const isEdit = mode === 'edit'
  const { t } = useTranslation()
  const { user } = useAuth()
  const styles = useStyles()
  // 当前展开「选择性替换」内联区域的语言（null = 收起）
  const [patchLang, setPatchLang] = useState(null)
  // 内联区域正在打包/发布时锁住入口，避免切换语言导致进度反馈丢失
  const [patchBusy, setPatchBusy] = useState(false)
  const {
    modId,
    modKey, setModKey,
    category, setCategory,
    isOriginal, setIsOriginal,
    translations, langList, availableLangs,
    addLang, setAddLang,
    permissions, setPermissions,
    existingFiles,
    busy, error, uploadError,
    modFiles, uploadingLang,
    fileDialogLang, setFileDialogLang,
    confirmRemoveLang, setConfirmRemoveLang,
    replaceErrors,
    progressOpen, progressPercent, progressStep, progressSpeed, progressError, progressNotice,
    manifestRepairLangs, manifestRepairBusy, manifestRepairError, handleManifestRepairRetry,
    maxZipSize,
    canSelectFile,
    isFormValid,
    canEditModInfo,
    canEditAllLangs,
    canEditLang,
    canDeleteFile,
    hasAnyEditPermission,
    userPermissions,
    handleSelectFolders,
    handleSelectFiles,
    handleAddLang,
    handleRemoveLang,
    handleConfirmRemoveLang,
    handleTransChange,
    handleRemoveFile,
    handleUploadFile,
    builtPatches,
    emptyPatchLangs,
    hasUnsavedDraft,
    getPatchDraft,
    handlePatchBuilt,
    handlePatchDraft,
    handleReplaceErrorClose,
    handleProgressCancel,
    handleSubmit,
  } = editor

  // 选择性替换面板把清单删空后禁止保存：前端按钮先拦截，后端 publish 还有一道 EMPTY_MANIFEST
  const patchEmpty = isEdit && Object.keys(emptyPatchLangs || {}).length > 0
  const submitDisabled = busy || patchEmpty || (isEdit ? !hasAnyEditPermission : !isFormValid)
  // 已构建但未保存的补丁包，或面板里尚未构建的草稿：离开页面都会丢，必须显式确认
  const [confirmLeaveOpen, setConfirmLeaveOpen] = useState(false)
  const hasUnsavedPatch = Object.keys(builtPatches || {}).length > 0 || !!hasUnsavedDraft
  const requestClose = () => {
    if (hasUnsavedPatch) setConfirmLeaveOpen(true)
    else onClose()
  }

  // 保活轮询与信号灯状态都在 KeepaliveLight 内部，页面只提供登录用户与「业务正忙」标记，
  // 灯色更新只重渲染该组件，不会连带动整个编辑页。

  return (
    <div className={styles.root}>
      <div className={isEdit ? `${styles.toolbarRow} ${styles.stickyToolbar}` : styles.toolbarRow}>
        <BackButton onClick={requestClose} />
        <Text weight="semibold">{isEdit ? t('workshop.editMod') : t('workshop.publishMod')}</Text>
      </div>
      {isEdit && manifestRepairLangs.length > 0 && (
        <div className={styles.repairBanner}>
          <Warning24Regular style={{ flexShrink: 0 }} />
          <Text size={200} style={{ flex: 1, minWidth: 220 }}>
            {t('workshop.patchManifestRepairNotice', { langs: manifestRepairLangs.join(' / ') })}
          </Text>
          {manifestRepairError && (
            <Text size={200} style={{ width: '100%' }}>{manifestRepairError}</Text>
          )}
          <Button
            size="small"
            appearance="secondary"
            onClick={handleManifestRepairRetry}
            disabled={manifestRepairBusy || busy}
          >
            {manifestRepairBusy
              ? t('workshop.patchManifestRepairRetrying')
              : t('workshop.patchManifestRepairRetry')}
          </Button>
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto', padding: '8px', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className={styles.formRow}>
          {isEdit ? (
            <Text className={styles.formLabel}>{t('workshop.modId')}</Text>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Text className={styles.formLabel}>{t('workshop.modId')}</Text>
              <Tooltip
                content={<span style={{ whiteSpace: 'pre-line', display: 'inline-block', maxWidth: 320 }}>{t('workshop.modIdTooltip')}</span>}
                relationship="description"
                positioning="below-start"
              >
                <Info16Regular style={{ color: tokens.colorNeutralForeground3, cursor: 'help', flexShrink: 0 }} tabIndex={0} />
              </Tooltip>
              <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                {t('workshop.modIdHint')}
              </Text>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {isEdit ? (
              <Input size="small" value={modKey} onChange={(_, d) => setModKey(d.value)} disabled={busy || !canEditModInfo} style={{ flex: 1, minWidth: 0 }} />
            ) : (
              <Input
                size="small"
                placeholder={t('workshop.modIdCreatePlaceholder')}
                value={modKey}
                maxLength={64}
                onChange={(_, d) => setModKey(d.value)}
                style={{ flex: 1, minWidth: 0 }}
              />
            )}
            <Checkbox
              size="small"
              checked={isOriginal}
              disabled={busy || (isEdit && !canEditModInfo)}
              onChange={(_, d) => setIsOriginal(!!d.checked)}
              label={t('workshop.isOriginalLabel')}
              style={{ whiteSpace: 'nowrap' }}
            />
          </div>
        </div>

        <div className={styles.formRow}>
          <Text className={styles.formLabel}>{t('workshop.type')}</Text>
          {isEdit ? (
            <CategorySelect value={category} onChange={setCategory} disabled={!canEditModInfo} />
          ) : (
            <CategorySelect value={category} onChange={setCategory} />
          )}
        </div>

        <PermissionSettings value={permissions} onChange={setPermissions} disabled={busy || (isEdit && !userPermissions?.is_author)} />

        <div className={styles.langHeader}>
          <Text weight="semibold" size="small">{t('workshop.multiLang')}</Text>
          <Select size="small" value={addLang} onChange={(_, d) => setAddLang(d.value)}>
            {availableLangs.map(l => {
              const lang = LANGUAGES.find(ll => ll.value === l)
              return <option key={l} value={l}>{lang?.label || l}</option>
            })}
          </Select>
          <Button
            size="small"
            onClick={handleAddLang}
            disabled={!addLang || !!translations[addLang] || (isEdit && !canEditAllLangs)}
          >
            {t('workshop.addLang')}
          </Button>
        </div>

        {langList.map(lang => (
          <div key={lang}>
            <LanguageTranslationBlock
              lang={lang}
              translation={translations[lang]}
              onChange={handleTransChange}
              onRemove={() => handleRemoveLang(lang)}
              canEdit={isEdit ? canEditLang(lang) : true}
              canRemove={isEdit ? canEditAllLangs && canDeleteFile(lang) : true}
              disableFileSelect={!isEdit && !canSelectFile}
              category={category}
              modKey={modKey}
              maxZipSize={maxZipSize}
              modFiles={modFiles[lang] || []}
              existingFile={isEdit ? (existingFiles[lang] || null) : null}
              uploadingLang={uploadingLang}
              onSelectFiles={handleSelectFiles}
              onSelectFolders={handleSelectFolders}
              onUpload={isEdit ? handleUploadFile : undefined}
              onRemoveFile={handleRemoveFile}
              onShowMoreFiles={setFileDialogLang}
              patchBusy={patchBusy}
              onOpenFilePatch={isEdit ? (l) => setPatchLang(p => (p === l ? null : l)) : undefined}
            />
            {isEdit && patchLang === lang && (
              <ModFilePatchPanel
                isOpen
                lang={lang}
                modId={modId}
                userId={user?.user_id || 0}
                category={category}
                version={translations[lang]?.version || ''}
                maxZipSize={maxZipSize}
                onVersionChange={(v) => handleTransChange(lang, 'version', v)}
                wholeArchivePending={(modFiles[lang] || []).length > 0}
                force={!!import.meta.env.DEV}
                onDraftChange={handlePatchDraft}
                getDraft={() => getPatchDraft(lang)}
                onBusyChange={setPatchBusy}
                onClose={() => setPatchLang(null)}
                onBuilt={handlePatchBuilt}
              />
            )}
          </div>
        ))}

        {uploadingLang && (
          <Text size="small" className={styles.meta}>
            {t('workshop.uploadingLang', { lang: uploadingLang })}
          </Text>
        )}
        {isEdit && uploadError && <Text size="small" style={{ color: tokens.colorPaletteRedForeground1 }}>{uploadError}</Text>}
        {error && <Text size="small" style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Text>}
        {patchEmpty && (
          <Text size="small" style={{ color: tokens.colorPaletteRedForeground1 }}>
            {t('workshop.patchEmptyManifestRejected')}
          </Text>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', padding: '12px 8px', borderTop: `1px solid ${tokens.colorNeutralStroke2}` }}>
        <Button size="small" appearance="secondary" onClick={requestClose}>{t('workshop.cancel')}</Button>
        <Button size="small" appearance="primary" onClick={handleSubmit} disabled={submitDisabled}>
          {isEdit
            ? (busy ? t('workshop.saving') : t('workshop.save'))
            : (busy ? t('workshop.publishing') : t('workshop.publish'))}
        </Button>
      </div>

      <Dialog open={!!fileDialogLang} onOpenChange={(_, { open }) => !open && setFileDialogLang(null)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('workshop.fileListTitle', { count: fileDialogLang && modFiles[fileDialogLang]?.length || 0 })}</DialogTitle>
            <DialogContent>
              <div style={{ maxHeight: '60vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {fileDialogLang && modFiles[fileDialogLang]?.map((f, i) => (
                  <Text key={i} size="small" className={styles.meta}>
                    {f.isDir ? `[${t('workshop.dirLabel')}] ` : ''}{f.zipPath || f.name} ({(f.size / 1024).toFixed(1)}KB)
                  </Text>
                ))}
              </div>
            </DialogContent>
            <DialogTrigger>
              <Button size="small">{t('window.close')}</Button>
            </DialogTrigger>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* 幂等/清单修正提示需要用户确认后才关闭编辑页，因此同样显示按钮 */}
      <ProgressModal
        open={progressOpen}
        title={isEdit ? t('workshop.updatingFiles') : t('workshop.publishing')}
        percent={progressPercent}
        stepText={progressStep}
        speedText={progressSpeed > 0 ? t('workshop.uploadSpeed', { speed: formatSpeed(progressSpeed) }) : ''}
        errorText={progressError}
        onCancel={progressError || uploadingLang || progressNotice ? handleProgressCancel : undefined}
        cancelLabel={progressError || progressNotice ? t('window.close') : t('workshop.cancel')}
      />

      {isEdit && (
        <>
          <ConfirmDialog
            open={replaceErrors.length > 0}
            onClose={handleReplaceErrorClose}
            title={t('workshop.replaceFileWarning')}
            onConfirm={handleReplaceErrorClose}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {replaceErrors.map((e, i) => (
                <Text key={i} size="small">{e.lang}: {e.msg}</Text>
              ))}
            </div>
          </ConfirmDialog>

          <ConfirmDialog
            open={!!confirmRemoveLang}
            onClose={() => setConfirmRemoveLang(null)}
            title={t('workshop.removeLang')}
            // 构建进行中禁止删除语言：面板卸载会让构建结果失去归属
            confirmDisabled={patchBusy}
            onConfirm={() => {
              if (patchBusy) return
              handleConfirmRemoveLang()
            }}
          >
            <Text>{t('workshop.confirmRemoveLang', { lang: confirmRemoveLang })}</Text>
            {confirmRemoveLang && existingFiles[confirmRemoveLang] && (
              <Text as="p" size="small" style={{ color: tokens.colorPaletteRedForeground1, marginTop: '8px' }}>
                {t('workshop.removeLangFileHint')}
              </Text>
            )}
            {patchBusy && (
              <Text as="p" size="small" style={{ color: tokens.colorStatusWarningForeground1, marginTop: '8px' }}>
                {t('workshop.removeLangPatchBusy')}
              </Text>
            )}
          </ConfirmDialog>

          <ConfirmDialog
            open={confirmLeaveOpen}
            onClose={() => setConfirmLeaveOpen(false)}
            title={t('workshop.patchUnsavedLeaveTitle')}
            confirmText={t('workshop.patchUnsavedLeaveConfirm')}
            onConfirm={() => { setConfirmLeaveOpen(false); onClose() }}
          >
            <Text>{t('workshop.patchUnsavedLeaveHint')}</Text>
          </ConfirmDialog>

          {/* 与其它页面统一走 FloatingActions：保活灯作为悬浮列表首项，替换全局网络灯 */}
          <FloatingActions
            light={
              <KeepaliveLight
                userId={user?.user_id}
                paused={progressOpen || patchBusy || !!busy}
              />
            }
            items={[
              { key: 'back', icon: <ArrowLeft24Regular />, onClick: requestClose, title: t('workshop.back') },
              {
                key: 'save',
                icon: <Save24Regular />,
                appearance: 'primary',
                onClick: handleSubmit,
                disabled: submitDisabled,
                title: t('workshop.save'),
              },
            ]}
          />
        </>
      )}
    </div>
  )
}
