import { useTranslation } from 'react-i18next'
import {
  Text, Button, Input, Select, makeStyles, tokens,
  Popover, PopoverTrigger, PopoverSurface,
} from '@fluentui/react-components'
import {
  Delete24Regular, ArrowUpload24Regular, Document24Regular,
} from '@fluentui/react-icons'
import { RichTextEditor, MarkdownEditor, PlainTextarea } from '../../components/common/RichTextEditor'
import { LANGUAGES } from '../../i18n/languages'
import { usePersistedHeight } from '../../hooks/usePersistedHeight'
import { normalizeManifestFiles } from './modDetail/modFileUtils'

const MAX_INSTRUCTIONS_LENGTH = 10000

const useStyles = makeStyles({
  formRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    marginBottom: '8px',
    flexShrink: 0,
  },
  // 详细说明块：编辑器高度由用户拖动决定（usePersistedHeight），这里不再 flex:1 撑满，
  // 否则固定高度之后会剩下一大块空白
  expandableFormRow: {
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
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
  hint: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeSmall,
    lineHeight: '1.4',
  },
  // 危险操作按钮：统一 outlined（secondary）+ danger 配色，避免文字样式难以辨认
  dangerButton: {
    color: tokens.colorStatusDangerForeground1,
    borderColor: tokens.colorStatusDangerBorder1,
    ':hover': {
      color: tokens.colorStatusDangerForeground1,
      borderColor: tokens.colorStatusDangerBorder1,
      backgroundColor: tokens.colorStatusDangerBackground1,
    },
    ':active': {
      color: tokens.colorStatusDangerForeground1,
      borderColor: tokens.colorStatusDangerBorder1,
      backgroundColor: tokens.colorStatusDangerBackground2,
    },
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
  modKey = '',
  maxZipSize,
  modFiles = [],
  existingFile = null,
  uploadingLang = null,
  onSelectFiles,
  onSelectFolders,
  onUpload,
  onRemoveFile,
  onShowMoreFiles,
  onOpenFilePatch,
  patchBusy = false,
}) {
  const { t } = useTranslation()
  const styles = useStyles()
  // 同一字段在所有语言间共用一份高度：拖出来的尺寸是编辑习惯，不随语言变化
  const descHeightState = usePersistedHeight('editor_height_mod_desc', { min: 56, max: 800, defaultHeight: 80 })
  const detailHeightState = usePersistedHeight('editor_height_mod_detail', { min: 160, max: 2000, defaultHeight: 200 })
  // 详细说明的预览面板高度：与编辑框各自独立记忆（有人喜欢编辑区大、有人喜欢预览区大），
  // 同样在所有语言间共用
  const previewHeightState = usePersistedHeight('editor_height_mod_detail_preview', { min: 120, max: 2000, defaultHeight: 200 })

  const langLabel = LANGUAGES.find(l => l.value === lang)?.label || lang
  const trans = translation
  const isUploading = uploadingLang === lang
  // 编辑模式：从已上传文件的 manifest 还原压缩包内的文件列表供预览。
  // 历史 manifest 可能带父级前缀/目录条目，按 category 推导安装根后归一，
  // 保证这里与下方本地扫描列表使用同一个文件键。
  const existingFileList = existingFile
    ? normalizeManifestFiles(existingFile.manifest, category, modKey)
    : []

  return (
    <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '4px', padding: '8px', marginBottom: '8px' }}>
      {/* 语言头 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
        <Text weight="semibold" size="small">{langLabel} ({lang})</Text>
        {canRemove && (
          <Button size="small" icon={<Delete24Regular />} appearance="secondary" className={styles.dangerButton} onClick={onRemove} disabled={patchBusy} />
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
        <PlainTextarea
          heightState={descHeightState}
          placeholder={t('workshop.briefDesc')}
          value={trans.description}
          onChange={(v) => onChange(lang, 'description', v)}
          disabled={!canEdit}
        />
        <Text className={styles.hint}>{t('workshop.descHint')}</Text>
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
            heightState={detailHeightState}
          />
        ) : (
          <MarkdownEditor
            value={trans.instructions}
            onChange={(md) => onChange(lang, 'instructions', md)}
            placeholder={t('workshop.instructions') + '（' + t('workshop.markdown') + '；' + t('workshop.lineBreakTwice') + '）'}
            maxLength={MAX_INSTRUCTIONS_LENGTH}
            disabled={!canEdit}
            heightState={detailHeightState}
            previewHeightState={previewHeightState}
          />
        )}
        <Text className={styles.hint}>{t('workshop.detailHint')}</Text>
      </div>

      {/* 文件区域 */}
      <div className={styles.formRow}>
        <Text className={styles.formLabel}>
          {t('workshop.modFile')}
          {category === 'v2' ? ` (${t('workshop.hint_v2')})` : category === 'composite' ? ` (${t('workshop.hint_composite')})` : category === 'dll' ? ` (${t('workshop.hint_dll')})` : ` (${t('workshop.hint_v1')})`}
        </Text>

        {/* 上传限制提示 */}
        <Text size="small" style={{ color: tokens.colorNeutralForeground3, lineHeight: '1.4', whiteSpace: 'pre-wrap' }}>
          {t('workshop.uploadLimitWarning', { max: (maxZipSize / 1024 / 1024) })}
        </Text>

        {/* 已上传文件信息（编辑模式） */}
        {existingFile && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px', flexWrap: 'wrap' }}>
            <Text size="small" className={styles.meta}>
              {t('workshop.alreadyUploaded')}：{existingFile.file_name} ({(existingFile.file_size / 1024).toFixed(1)}KB)
            </Text>
            <Text size="small" className={styles.meta}>v{existingFile.version}</Text>
            {existingFileList.length > 0 && (
              <Popover withArrow positioning="below-start">
                <PopoverTrigger disableButtonEnhancement>
                  <Button size="small" icon={<Document24Regular />}>
                    {t('workshop.viewFileList')}
                  </Button>
                </PopoverTrigger>
                <PopoverSurface style={{ maxHeight: '300px', overflow: 'auto', minWidth: '240px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {existingFileList.map((filePath, idx) => (
                      <Text key={idx} block>{filePath}</Text>
                    ))}
                  </div>
                </PopoverSurface>
              </Popover>
            )}
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
          {/* 选择性替换与「更新文件/文件夹」同级并列：同一组按钮、同一间距。
              打包/发布中禁用入口，避免切换语言丢掉进度反馈 */}
          {onOpenFilePatch && existingFile && (
            <Button size="small" onClick={() => onOpenFilePatch(lang)} disabled={!canEdit || patchBusy}>
              {t('workshop.patchOpen')}
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
                <Button size="small" icon={<Delete24Regular />} appearance="secondary" className={styles.dangerButton} onClick={() => onRemoveFile?.(lang, -1)} disabled={!canEdit}>
                  {t('workshop.cancelSelection')}
                </Button>
              ) : (
                <Button size="small" icon={<Delete24Regular />} appearance="secondary" className={styles.dangerButton} onClick={() => onRemoveFile?.(lang, -1)} disabled={!canEdit} />
              )}
              {(category === 'v1' || category === 'composite') && existingFile && (
                <Text size="small" style={{ color: tokens.colorPaletteRedForeground1 }}>{t('workshop.replaceFileHint')}</Text>
              )}
            </>
          )}
        </div>

        {/* 选择性替换的说明：次要文字色 + 小字号，不做成按钮 */}
        {onOpenFilePatch && existingFile && (
          <Text size="small" className={styles.hint}>
            {t('workshop.patchButtonHint')}
          </Text>
        )}

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
                  appearance="secondary"
                  className={styles.dangerButton}
                  onClick={() => onRemoveFile?.(lang, i)}
                />
              </div>
            ))}
            {modFiles.length > 5 && (
              <Button size="small" appearance="secondary" onClick={() => onShowMoreFiles?.(lang)}>
                {t('workshop.moreFilesCount', { count: modFiles.length - 5 })}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}