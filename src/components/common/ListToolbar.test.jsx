import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ListToolbar } from './ListToolbar'

const noop = () => {}

function renderToolbar(props) {
  return renderToStaticMarkup(
    <FluentProvider theme={webLightTheme}>
      <ListToolbar
        search=""
        onSearchChange={noop}
        onSearchSubmit={noop}
        onRefresh={noop}
        itemsPerRow={2}
        onItemsPerRowChange={noop}
        {...props}
      />
    </FluentProvider>,
  )
}

describe('ListToolbar', () => {
  it('supports the F95 view with its own controls and progress', () => {
    const html = renderToolbar({
      refreshLabel: 'Refresh F95',
      refreshDisabled: true,
      status: <div>Reading page 2</div>,
      children: <button>F95 filter</button>,
    })
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Refresh F95/)
    expect(html).toContain('Reading page 2')
    expect(html).toContain('F95 filter')
    expect(html).not.toContain('workshop-sort-select')
  })

  it('continues to render the standard sort controls for workshop lists', () => {
    const html = renderToolbar({
      sortOptions: [{ value: 'created_at', label: 'Newest' }],
      sortBy: 'created_at',
      onSortByChange: noop,
      sortOrder: 'desc',
      onSortOrderChange: noop,
    })
    expect(html).toContain('workshop-sort-select')
    expect(html).toContain('Newest')
  })
})
