import { FilePart, formatMigrationFile, regexps } from '@packages/data-context/src/util'
import HighlightedFile from './HighlightedFile.vue'

describe('<HighlightedFile/>', { viewportWidth: 1119 }, () => {
  it('renders expected content', () => {
    const part: readonly FilePart[] = formatMigrationFile(
      'cypress/e2e/foo.cy.js',
      new RegExp(regexps.e2e.afterRegexp),
    )

    cy.mount(() => (<div class="p-16px">
      <HighlightedFile
        file={part}
      />
    </div>))
  })
})
