import { useTranslation } from 'react-i18next'
import { Select, Text, tokens, Checkbox, makeStyles } from '@fluentui/react-components'

const LANGUAGES = ['zh', 'en', 'ja']

const useStyles = makeStyles({
  section: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    padding: '10px',
    marginBottom: '8px',
  },
  sectionTitle: {
    fontWeight: '600',
    marginBottom: '8px',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '6px',
    flexWrap: 'wrap',
  },
  langCheckboxGroup: {
    display: 'flex',
    gap: '6px',
    flexWrap: 'wrap',
    marginTop: '4px',
    marginLeft: '4px',
  },
  hint: {
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorNeutralForeground3,
    marginTop: '2px',
  },
})

export default function PermissionSettings({ value, onChange, disabled = false }) {
  const { t } = useTranslation()
  const styles = useStyles()

  const MODE_OPTIONS = [
    { value: 'author_only', label: t('workshop.permAuthorOnly') },
    { value: 'open', label: t('workshop.permOpen') },
    { value: 'open_lang', label: t('workshop.permOpenLang') },
    { value: 'apply', label: t('workshop.permApply') },
  ]

  const settings = value || { mode: 'author_only', open_langs: [], allow_mod_info: true, allow_lang: true, apply_langs: [] }
  const { mode, open_langs: openLangs, allow_mod_info: allowModInfo, allow_lang: allowLang, apply_langs: applyLangs } = settings

  const handleModeChange = (_, { value: newMode }) => {
    onChange?.({ ...settings, mode: newMode })
  }

  const handleOpenLangsToggle = (lang) => {
    const next = openLangs.includes(lang) ? openLangs.filter(l => l !== lang) : [...openLangs, lang]
    onChange?.({ ...settings, open_langs: next })
  }

  const handleApplyLangsToggle = (lang) => {
    const next = applyLangs.includes(lang) ? applyLangs.filter(l => l !== lang) : [...applyLangs, lang]
    onChange?.({ ...settings, apply_langs: next })
  }

  const handleCheckChange = (field) => (_, { checked }) => {
    onChange?.({ ...settings, [field]: checked })
  }

  return (
    <div className={styles.section}>
      <Text className={styles.sectionTitle}>{t('workshop.permTitle')}</Text>
      <div className={styles.row}>
        <Text size="small">{t('workshop.permMode')}</Text>
        <Select
          size="small"
          value={mode}
          onChange={handleModeChange}
          disabled={disabled}
        >
          {MODE_OPTIONS.map(m => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </Select>
      </div>

      {mode === 'open_lang' && (
        <>
          <Text size="small" block className={styles.hint}>{t('workshop.permOpenLangHint')}</Text>
          <div className={styles.langCheckboxGroup}>
            {LANGUAGES.map(lang => (
              <Checkbox
                key={lang}
                size="small"
                label={lang.toUpperCase()}
                checked={openLangs.includes(lang)}
                onChange={() => handleOpenLangsToggle(lang)}
                disabled={disabled}
              />
            ))}
          </div>
        </>
      )}

      {mode === 'apply' && (
        <>
          <div className={styles.row}>
            <Checkbox
              size="small"
              label={t('workshop.permAllowModInfo')}
              checked={allowModInfo}
              onChange={handleCheckChange('allow_mod_info')}
              disabled={disabled}
            />
          </div>
          <div className={styles.row}>
            <Checkbox
              size="small"
              label={t('workshop.permAllowLang')}
              checked={allowLang}
              onChange={handleCheckChange('allow_lang')}
              disabled={disabled}
            />
          </div>
          {allowLang && (
            <>
              <Text size="small" block className={styles.hint}>{t('workshop.permApplyLangHint')}</Text>
              <div className={styles.langCheckboxGroup}>
                {LANGUAGES.map(lang => (
                  <Checkbox
                    key={lang}
                    size="small"
                    label={lang.toUpperCase()}
                    checked={applyLangs.includes(lang)}
                    onChange={() => handleApplyLangsToggle(lang)}
                    disabled={disabled}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
