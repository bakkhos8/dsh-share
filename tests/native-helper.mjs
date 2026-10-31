import { accessSync, constants } from 'node:fs'
import { fileURLToPath } from 'node:url'

const helper = process.env.DSH_SHARE_HELPER
  || fileURLToPath(new URL('../build/dsh-share-helper', import.meta.url))
try {
  accessSync(helper, constants.X_OK)
} catch {
  throw new Error('Build the native test helper first with scripts/build-helper.sh, or run scripts/test.sh')
}
process.env.DSH_SHARE_HELPER = helper
