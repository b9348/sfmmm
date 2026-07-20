import { useTranslation } from 'react-i18next'
import {
  Text, Button, Input, Textarea, Select, makeStyles, tokens,
} from '@fluentui/react-components'
import {
  Delete24Regular, ArrowUpload24Regular,
} from '@fluentui/react-icons'
import { RichTextEditor, MarkdownEditor } from '../../components/common/RichTextEditor'
import { LANGUAGES } from '../../i18n/languages'

const MAX_INSTRUCTIONS_LENGTH = 10000

const useStyles = makeStyles({
  formRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    marginBottom: '8px',
    flexShrink: 0,
  },
  expandableFormRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    marginBottom: '8px',
    flex: 1,
    minHeight: '160px',
  },
  formLabel: {
    fontSize: tokens.fontSizeSmall,
    fontWeight: '600',
  },
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
})

export function LanguageTranslationBlock({
  lang,
  translation,
  onChange,
  onRemove,
  canEdit = true,
  canRemove = true,
  disableFileSelect = false,
  category,
  maxZipSize,
  r2Enabled = false,
  modFiles = [],
  existingFile = null,
  uploadingLang = null,
  onSelectFiles,
  onSelectFolders,
  onUpload,
  onRemoveFile,
  onShowMoreFiles,
}) {
  const { t } = useTranslation()
  const styles = useStyles()

  const langLabel = LANGUAGES.find(l => l.value === lang)?.label || lang
  const trans = translation
  const isUploading = uploadingLang === lang

  return (
    <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '4px', padding: '8px', marginBottom: '8px' }}>
      {/* 语言头 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
        <Text weight="semibold" size="small">{langLabel} ({lang})</Text>
        {canRemove && (
          <Button size="small" icon={<Delete24Regular />} appearance="subtle" onClick={onRemove} />
        )}
      </div>

      {/* 名称 */}
      <div className={styles.formRow}>
        <Text className={styles.formLabel}>{t('workshop.name')}</Text>
        <Input
          size="small"
          placeholder={t('workshop.modName')}
          value={trans.name}
          onChange={(_, d) => onChange(lang, 'name', d.value)}
          disabled={!canEdit}
        />
      </div>

      {/* 版本 */}
      <div className={styles.formRow}>
        <Text className={styles.formLabel}>{t('workshop.version')}</Text>
        <Input
          size="small"
          placeholder="1.0.0"
          value={trans.version || '1.0.0'}
          onChange={(_, d) => onChange(lang, 'version', d.value)}
          style={{ width: '100px' }}
          disabled={!canEdit}
        />
      </div>

      {/* 描述 */}
      <div className={styles.formRow}>
        <Text className={styles.formLabel}>{t('workshop.desc')}</Text>
        <Textarea
          size="small"
          placeholder={t('workshop.briefDesc')}
          value={trans.description}
          onChange={(_, d) => onChange(lang, 'description', d.value)}
          disabled={!canEdit}
        />
      </div>

      {/* 详细说明 */}
      <div className={styles.expandableFormRow}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Text className={styles.formLabel}>{t('workshop.detailedDesc')}</Text>
          <Select
            size="small"
            value={trans.instructions_format || 'markdown'}
            onChange={(_, d) => onChange(lang, 'instructions_format', d.value)}
            disabled={!canEdit}
          >
            <option value="markdown">{t('workshop.markdown')}</option>
            <option value="richtext">{t('workshop.richtext')}</option>
          </Select>
        </div>
        {(trans.instructions_format || 'markdown') === 'richtext' ? (
          <RichTextEditor
            value={trans.instructions}
            onChange={(html) => onChange(lang, 'instructions', html)}
            placeholder={t('workshop.instructions') + '（' + t('workshop.richtext') + '；' + t('workshop.lineBreakOnce') + '）'}
            maxLength={MAX_INSTRUCTIONS_LENGTH}
            disabled={!canEdit}
          />
        ) : (
          <MarkdownEditor
            value={trans.instructions}
            onChange={(md) => onChange(lang, 'instructions', md)}
            placeholder={t('workshop.instructions') + '（' + t('workshop.markdown') + '；' + t('workshop.lineBreakTwice') + '）'}
            maxLength={MAX_INSTRUCTIONS_LENGTH}
            disabled={!canEdit}
          />
        )}
      </div>

      {/* 文件区域 */}
      <div className={styles.formRow}>
        <Text className={styles.formLabel}>
          {t('workshop.modFile')}
          {category === 'v2' ? ` (${t('workshop.hint_v2')})` : category === 'composite' ? ` (${t('workshop.hint_composite')})` : category === 'dll' ? ` (${t('workshop.hint_dll')})` : ` (${t('workshop.hint_v1')})`}
        </Text>

        {/* 上传限制提示 */}
        <Text size="small" style={{ color: tokens.colorNeutralForeground3, lineHeight: '1.4', whiteSpace: 'pre-wrap' }}>
          <span style={{ textDecoration: r2Enabled ? 'line-through' : 'none' }}>
            {t('workshop.uploadLimitWarning', { max: (maxZipSize / 1024 / 1024) })}
          </span>
          {r2Enabled && (
            <>
              <br />
              {t('workshop.uploadLimitR2Enabled', { max: (maxZipSize / 1024 / 1024) })}
            </>
          )}
        </Text>

        {/* 已上传文件信息（编辑模式） */}
        {existingFile && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px', flexWrap: 'wrap' }}>
            <Text size="small" className={styles.meta}>
              {t('workshop.alreadyUploaded')}：{existingFile.file_name} ({(existingFile.file_size / 1024).toFixed(1)}KB)
            </Text>
            <Text size="small" className={styles.meta}>v{existingFile.version}</Text>
            {existingFile.file_url && (
              <a href={existingFile.file_url} target="_blank" rel="noreferrer" style={{ fontSize: '12px', color: tokens.colorBrandForeground1 }}>
                {existingFile.file_url}
              </a>
            )}
          </div>
        )}

        {/* 文件选择按钮 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          {category === 'composite' ? (
            <>
              <Button size="small" icon={<ArrowUpload24Regular />} onClick={() => onSelectFolders?.(lang)} disabled={disableFileSelect || !canEdit}>
                {modFiles.length > 0 ? t('workshop.appendFolder') : t('workshop.updateFolder')}
              </Button>
              <Button size="small" icon={<ArrowUpload24Regular />} onClick={() => onSelectFiles?.(lang)} disabled={disableFileSelect || !canEdit}>
                {modFiles.length > 0 ? t('workshop.appendFile') : t('workshop.updateFile')}
              </Button>
            </>
          ) : (
            <Button size="small" icon={<ArrowUpload24Regular />} onClick={() => onSelectFiles?.(lang)} disabled={disableFileSelect || !canEdit}>
              {category === 'v2' ? t('workshop.hint_v2') : category === 'dll' ? t('workshop.hint_dll') : modFiles.length > 0 ? t('workshop.updateFile') : t('workshop.selectFile')}
            </Button>
          )}
          {modFiles.length > 0 && (
            <>
              {category !== 'v1' && category !== 'composite' && (
                <Button size="small" appearance="primary" onClick={() => onUpload?.(lang)} disabled={isUploading || !canEdit}>
                  {isUploading ? t('workshop.uploading') : t('workshop.upload')}
                </Button>
              )}
              {(category === 'v1' || category === 'composite') ? (
                <Button size="small" icon={<Delete24Regular />} appearance="subtle" onClick={() => onRemoveFile?.(lang, -1)} disabled={!canEdit}>
                  {t('workshop.cancelSelection')}
                </Button>
              ) : (
                <Button size="small" icon={<Delete24Regular />} appearance="subtle" onClick={() => onRemoveFile?.(lang, -1)} disabled={!canEdit} />
              )}
              {(category === 'v1' || category === 'composite') && existingFile && (
                <Text size="small" style={{ color: tokens.colorPaletteRedForeground1 }}>{t('workshop.replaceFileHint')}</Text>
              )}
            </>
          )}
        </div>

        {/* 已选文件列表 */}
        {modFiles.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '4px' }}>
            {modFiles.slice(0, 5).map((f, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <Text size="small" className={styles.meta} style={{ flex: 1 }}>
                  {f.isDir
                    ? `${t('workshop.dirLabel')} ${f.zipPath}/`
                    : `${f.zipPath || f.name} (${(f.size / 1024).toFixed(1)}KB)`}
                </Text>
                <Button
                  size="small"
                  icon={<Delete24Regular />}
                  appearance="subtle"
                  onClick={() => onRemoveFile?.(lang, i)}
                />
              </div>
            ))}
            {modFiles.length > 5 && (
              <Text size="small" className={styles.meta} style={{ cursor: 'pointer', textDecoration: 'underline', color: tokens.colorBrandForeground1 }} onClick={() => onShowMoreFiles?.(lang)}>
                {t('workshop.moreFilesCount', { count: modFiles.length - 5 })}
              </Text>
            )}
          </div>
        )}
      </div>
    </div>
  )
}