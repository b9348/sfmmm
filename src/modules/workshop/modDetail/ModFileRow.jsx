import { useTranslation } from 'react-i18next'
import {
  Text, Button, makeStyles, tokens,
  Popover, PopoverTrigger, PopoverSurface,
} from '@fluentui/react-components'
import {
  ArrowDownload24Regular, Delete24Regular,
  Folder24Regular, Document24Regular, Save24Regular,
} from '@fluentui/react-icons'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { FileRow, DownloadProgress } from '../../../components'
import { cdnUrl } from '../../../services/cdnApi'
import { copyText } from '../../../services/ndmApi'
import { localizeError } from '../../../utils/localizeError'
import { compareSemver, normalizeManifestFiles, openDirHighlightItems } from './modFileUtils'

const useStyles = makeStyles({
  // 版本行的操作区：宽屏用 display:contents 直接当 FileRow 单行里的 flex 项（布局不变）；
  // 窄屏整组落到第二行并允许换行，否则「安装/仅下载/文件列表/卸载」挤在一行会把卡片撑出横向滚动
  actions: {
    display: 'contents',
    '@media (max-width: 768px)': {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '6px',
      rowGap: '4px',
      flexBasis: '100%',
    },
  },
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
  // 下载直链行：标签 + 蓝链，紧贴版本行（间距由 FileRow 的 gap 控制）
  downloadRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '4px',
    minWidth: 0,
  },
  downloadLabel: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    whiteSpace: 'nowrap',
  },
  downloadLink: {
    flex: 1,
    minWidth: 0,
    color: tokens.colorBrandForegroundLink,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    textDecoration: 'none',
    wordBreak: 'break-all',
    ':hover': {
      color: tokens.colorBrandForegroundLinkHover,
      textDecoration: 'underline',
    },
  },
})

export function ModFileRow({
  file,
  category,
  modKey,
  installed,
  installing,
  subscribeProgress,
  archiveProgress,
  isInstalled,
  installedDir,
  installedFiles,
  uninstalling,
  installBlocked,
  onInstall,
  onArchiveDownload,
  onCancelInstall,
  onCancelArchive,
  onOpenFolder,
  onRequestUninstall,
}) {
  const styles = useStyles()
  const { t } = useTranslation()
  // 「查看文件列表」只展示文件：目录条目（末尾 /）与安装根前缀都在这里归一掉
  const previewFiles = normalizeManifestFiles(file.manifest, category, modKey)
  // 下载直链按当前生效线路改写（设置里启用 CDN 加速时换成加速域名）
  const downloadUrl = file.file_url ? cdnUrl(file.file_url) : ''

  const installAppearance = installing
    ? 'outline'
    : installed
      ? compareSemver(installed.installed_version, file.version) < 0
        ? 'primary'
        : 'outline'
      : 'primary'

  return (
    <FileRow
      langCode={file.lang_code}
      name={file.file_name}
      version={file.version}
      fileSize={file.file_size}
      footer={downloadUrl ? (
        // 点击同时复制直链并交给系统浏览器：复制供外部下载器用，打开浏览器可手动下载
        <div className={styles.downloadRow}>
          <Text className={styles.downloadLabel}>{t('workshop.downloadLink')}:</Text>
          <a
            href={downloadUrl}
            className={styles.downloadLink}
            title={downloadUrl}
            onClick={async (e) => {
              e.preventDefault()
              e.stopPropagation()
              await copyText(downloadUrl)
              openUrl(downloadUrl).catch(() => {})
            }}
          >
            {downloadUrl}
          </a>
        </div>
      ) : null}
    >
      <div className={styles.actions}>
        {installed && (
          <Text className={styles.meta}>
            {t('workshop.localVersion', { version: installed.installed_version })}
          </Text>
        )}
        <Button
          size="small"
          icon={<ArrowDownload24Regular />}
          appearance={installAppearance}
          disabled={installing || !!subscribeProgress || installBlocked}
          onClick={(e) => {
            e.stopPropagation()
            onInstall(file)
          }}
        >
          {installing
            ? t('workshop.installing')
            : installed
              ? compareSemver(installed.installed_version, file.version) < 0
                ? t('workshop.update')
                : t('workshop.reinstall')
              : t('workshop.install')}
        </Button>
        {/* 仅下载：把原始压缩包存到游戏根目录 sfmmmDownloads，不安装 */}
        <Button
          size="small"
          icon={<Save24Regular />}
          appearance="outline"
          disabled={archiveProgress?.status === 'downloading'}
          onClick={(e) => {
            e.stopPropagation()
            onArchiveDownload(file)
          }}
        >
          {archiveProgress?.status === 'downloading'
            ? t('workshop.downloadOnlyRunning')
            : t('workshop.downloadOnly')}
        </Button>
        {archiveProgress && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '120px' }}>
            {archiveProgress.status === 'downloading' ? (
              <DownloadProgress
                label={t('workshop.stage.downloading', { defaultValue: '下载中' })}
                percent={archiveProgress.percent || 0}
                speed={archiveProgress.speed}
                thickness="thin"
                // 取消语义对"仅下载"是"这个文件我不要了"：后端会连已落盘的 zip 一起删
                onCancel={onCancelArchive ? () => onCancelArchive(file, archiveProgress) : undefined}
                cancelLabel={t('workshop.cancelDownload')}
              />
            ) : archiveProgress.status === 'cancelled' ? (
              <Text className={styles.meta}>{t('workshop.downloadCancelled')}</Text>
            ) : (
              <Text className={styles.meta}>
                {archiveProgress.status === 'done'
                  ? t('workshop.downloadOnlyDone')
                  : t('workshop.downloadOnlyFailed')}
              </Text>
            )}
            {/* 失败原因：浮条 8s 后自动关闭，且离开详情页就看不到了，行内保留一份 */}
            {archiveProgress.status === 'failed' && archiveProgress.error && (
              <Text style={{ color: tokens.colorPaletteRedForeground2 }}>
                {localizeError(t, archiveProgress.error)}
              </Text>
            )}
            {archiveProgress.status === 'done' && archiveProgress.path && (
              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<Folder24Regular />}
                  onClick={(e) => {
                    e.stopPropagation()
                    // 传文件路径：open_folder 会打开其父目录并高亮该文件
                    onOpenFolder(archiveProgress.path)
                  }}
                >
                  {t('workshop.openDir')}
                </Button>
                {/* 删除已下载的缓存包：不占盘的用户常点完就走，留个入口免得去翻目录 */}
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<Delete24Regular />}
                  disabled={archiveProgress.status !== 'done'}
                  onClick={(e) => {
                    e.stopPropagation()
                    onCancelArchive?.(file, archiveProgress)
                  }}
                >
                  {t('downloadBar.removeFile')}
                </Button>
              </div>
            )}
          </div>
        )}
        {subscribeProgress && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '120px' }}>
            <DownloadProgress
              // 全局下载中心存的是原始阶段键（pending/downloading/…），
              // 文案在这里翻译——store 只做数据，不掺 i18n
              label={t(`workshop.stage.${subscribeProgress.stage || 'downloading'}`, { defaultValue: '' })}
              percent={['pending', 'downloading', 'extracting', 'recording'].includes(subscribeProgress.status)
                ? (subscribeProgress.percent || 0)
                : undefined}
              speed={subscribeProgress.status === 'downloading' ? subscribeProgress.speed : 0}
              thickness="thin"
              // 安装链路的取消：中止下载并清临时包（游戏目录里的已解压文件由
              // 退订或下次安装覆盖，不在取消语义内）
              onCancel={onCancelInstall ? () => onCancelInstall(file, subscribeProgress) : undefined}
              cancelLabel={t('workshop.cancelDownload')}
            />
            {/* 失败态不在这里渲染：subscribeProgress 来自 installByLang，只含运行中任务，
                失败原因由详情页统一抬到页面级 NoticeBar（浮条 8s 后自动关闭，错过就找不到了） */}
          </div>
        )}
        {/* 未安装时也能预览将要写入的文件列表（来自发布者上传的 manifest） */}
        {!installed && previewFiles.length > 0 && (
          <Popover withArrow positioning="below-start">
            <PopoverTrigger disableButtonEnhancement>
              <Button
                size="small"
                appearance="subtle"
                icon={<Document24Regular />}
                onClick={(e) => e.stopPropagation()}
              >
                {t('workshop.viewFileList')}
              </Button>
            </PopoverTrigger>
            <PopoverSurface style={{ maxHeight: '300px', overflow: 'auto', minWidth: '240px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {previewFiles.map((filePath, idx) => (
                  <Text key={idx} block>{filePath}</Text>
                ))}
              </div>
            </PopoverSurface>
          </Popover>
        )}
        {isInstalled && (
          <>
            <Button
              size="small"
              icon={<Folder24Regular />}
              onClick={(e) => {
                e.stopPropagation()
                if (installedDir) {
                  onOpenFolder(installedDir, openDirHighlightItems(installedFiles))
                }
              }}
            >
              {t('workshop.openDir')}
            </Button>
            <Popover withArrow positioning="below-start">
              <PopoverTrigger>
                <Button
                  size="small"
                  icon={<Document24Regular />}
                  onClick={(e) => e.stopPropagation()}
                >
                  {t('workshop.viewFileList')}
                </Button>
              </PopoverTrigger>
              <PopoverSurface style={{ maxHeight: '300px', overflow: 'auto', minWidth: '240px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {installedFiles.length === 0 ? (
                    <Text>{t('workshop.noFiles')}</Text>
                  ) : (
                    installedFiles.map((filePath, idx) => (
                      <Text key={idx} block>{filePath}</Text>
                    ))
                  )}
                </div>
              </PopoverSurface>
            </Popover>
            <Button
              size="small"
              icon={<Delete24Regular />}
              appearance="subtle"
              disabled={uninstalling}
              onClick={(e) => {
                e.stopPropagation()
                onRequestUninstall()
              }}
            >
              {t('workshop.uninstall')}
            </Button>
          </>
        )}
        <Text size="small" className={styles.meta}>{file.file_hash?.slice(0, 8)}</Text>
      </div>
    </FileRow>
  )
}
