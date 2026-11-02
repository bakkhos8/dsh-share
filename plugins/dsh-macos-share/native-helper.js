import { accessSync, constants, openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function resolveNativeHelper({
  override = process.env.DSH_SHARE_HELPER,
  installationFile = fileURLToPath(new URL('./.installation.json', import.meta.url)),
  candidates = [
    join(homedir(), 'Applications', 'DSHShare.app', 'Contents', 'MacOS', 'dsh-share-helper'),
    '/Applications/DSHShare.app/Contents/MacOS/dsh-share-helper',
  ],
} = {}) {
  if (override) return override
  let file
  try {
    file = openSync(installationFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (file !== undefined) {
    try {
      if (!fstatSync(file).isFile()) throw new Error('installation metadata must be a regular file')
      const data = Buffer.alloc(16 * 1024 + 1)
      let length = 0
      while (length < data.length) {
        const read = readSync(file, data, length, data.length - length, null)
        if (!read) break
        length += read
      }
      if (length === data.length) throw new Error('installation metadata is too large')
      const value = JSON.parse(data.subarray(0, length).toString('utf8'))
      if (value?.formatVersion !== 1 || typeof value.helperPath !== 'string' || !isAbsolute(value.helperPath)) {
        throw new Error('invalid native helper installation metadata')
      }
      accessSync(value.helperPath, constants.X_OK)
      return value.helperPath
    } catch (error) {
      throw new Error(`native helper installation needs repair: ${error.message}; reinstall the plugin using DSH Share`)
    } finally {
      closeSync(file)
    }
  }
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return candidate } catch {}
  }
  throw new Error('native helper not found; install DSHShare.app and its receiving plugin')
}
