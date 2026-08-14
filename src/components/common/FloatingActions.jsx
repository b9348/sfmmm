import { Button, Text, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, makeStyles, tokens } from '@fluentui/react-components'

const useStyles = makeStyles({
  container: {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    alignItems: 'center',
  },
  item: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '4px',
  },
  actionButton: {
    '&:hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  label: {
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: '2px 6px',
    borderRadius: '4px',
    boxShadow: tokens.shadow4,
    whiteSpace: 'nowrap',
  },
})

/**
 * 悬浮操作按钮组。
 * 若某项配置了 `menu: { confirmLabel, cancelLabel, onConfirm }`，
 * 则该按钮按下后弹出 Menu 二次确认（与清除评分同模式），防止误操作。
 */
export function FloatingActions({ items }) {
  const styles = useStyles()

  const renderButton = (item) => (
    <Button
      size="large"
      icon={item.icon}
      appearance={item.appearance || 'outline'}
      shape={item.shape || 'circular'}
      onClick={item.onClick}
      disabled={item.disabled}
      title={item.label}
      style={{
        ...item.style,
        ...((item.appearance || 'outline') !== 'primary' ? { backgroundColor: tokens.colorNeutralBackground1 } : {}),
      }}
      className={(item.appearance || 'outline') !== 'primary' ? styles.actionButton : undefined}
    />
  )

  return (
    <div className={styles.container}>
      {items.map(item => (
        <div key={item.key} className={styles.item}>
          {item.menu ? (
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                {renderButton(item)}
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuItem onClick={item.menu.onConfirm} disabled={item.disabled}>
                    {item.menu.confirmLabel}
                  </MenuItem>
                  <MenuItem>
                    {item.menu.cancelLabel}
                  </MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
          ) : renderButton(item)}
          {item.label && <Text className={styles.label}>{item.label}</Text>}
        </div>
      ))}
    </div>
  )
}
