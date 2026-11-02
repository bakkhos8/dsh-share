/** Durable inbox consumer for the native macOS share target. */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { acquireInboxLock } from './inbox-lock.js'
import { describeDraftFiles, draftSnapshot, publicDraftFiles, streamDraftFile, MAX_DRAFT_FILES } from './draft-files.js'

export const name = 'dsh-macos-share'
export const inject = ['connection']
export const VERSION = '0.1.13'
const SWEEP_MS = 1000
const log = (...args) => console.warn('[dsh-macos-share]', ...args)

async function readJson(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!(await file.stat()).isFile()) throw new Error('share metadata must be a regular file')
    const data = Buffer.alloc(1024 * 1024 + 1)
    let length = 0
    while (length < data.length) {
      const { bytesRead } = await file.read(data, length, data.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length === data.length) throw new Error('share metadata exceeds 1 MiB')
    return JSON.parse(data.subarray(0, length).toString('utf8'))
  } finally {
    await file.close()
  }
}

async function optionalJson(path) {
  try { return await readJson(path) } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

async function writeJson(path, value) {
  const temporary = `${path}.tmp-${randomUUID()}`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function readManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('manifest is not an object')
  if (value.version !== 1) throw new Error(`unsupported manifest version: ${value.version}`)
  if (!Array.isArray(value.items) || !Array.isArray(value.urls) || typeof value.text !== 'string') {
    throw new Error('invalid share manifest')
  }
  if (value.items.length > 128) throw new Error('share batch exceeds 128 attachments')
  if (value.urls.some(url => typeof url !== 'string')) throw new Error('invalid share URL')
  for (const item of value.items) {
    if (!item || !['file', 'image'].includes(item.kind) || typeof item.file !== 'string'
        || item.file === '' || item.file === '.' || item.file === '..'
        || basename(item.file) !== item.file || item.file.includes('\\') || /[\x00-\x1f\x7f]/.test(item.file)) {
      throw new Error('invalid share attachment path or kind')
    }
  }
  if (!value.items.length && !value.urls.length && !value.text.trim()) throw new Error('empty share payload')
  return value
}

function isAcknowledgement(receipt, shareId) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(shareId)
    && receipt?.version === 1 && receipt.accepted === true && receipt.shareId === shareId
    && Number.isFinite(receipt.acknowledgedAt) && receipt.acknowledgedAt > 0
    && typeof receipt.sessionId === 'string' && !!receipt.sessionId
    && typeof receipt.requestId === 'string' && !!receipt.requestId
}

function matchesAcknowledgement(receipt, state, shareId) {
  return isAcknowledgement(receipt, shareId) && state?.version === 1 && state.accepted === true
    && state.sessionId === receipt.sessionId && state.requestId === receipt.requestId
}

async function inspect(path) {
  try { return await lstat(path) } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

export function apply(ctx, config) {
  const inbox = config?.inbox || process.env.DSH_SHARE_INBOX
    || join(homedir(), 'Library', 'Application Support', 'DSHShare', 'inbox')
  const connection = ctx.connection ?? ctx.get('connection')
  const pending = new Map() // shareId -> package + optional pinned composer
  const streams = new Set()
  const lifecycle = new AbortController()
  let lockStatus = 'starting'
  let lockMessage = 'acquiring the exclusive inbox lock'
  const requireOwner = () => {
    lifecycle.signal.throwIfAborted()
    if (lockStatus !== 'active') throw new Error('this consumer does not own the inbox lock')
  }
  const unavailable = () => Response.json({ error: 'inbox_unavailable', status: lockStatus, message: lockMessage },
    { status: 503, headers })
  // ACK cleanup and inbox delivery share one queue, so cleanup cannot race a sweep.
  let operations = Promise.resolve()
  const serialize = fn => {
    const operation = operations.then(fn)
    operations = operation.catch(() => {})
    return operation
  }
  const headers = { 'cache-control': 'no-store', 'x-dsh-share-version': VERSION }
  const receipts = join(inbox, '.receipts')

  async function checkReceipts() {
    const info = await inspect(receipts)
    if (info && !info.isDirectory()) throw new Error('.receipts must be a real directory; cleanup deferred')
    return !!info
  }

  async function removeEmptyReceipts() {
    requireOwner()
    try { await rmdir(receipts) } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error
    }
  }

  async function clearAcknowledged(shareId, receipt, receiptPath) {
    requireOwner()
    if (!isAcknowledgement(receipt, shareId)) throw new Error('invalid acknowledgement; package preserved')
    const dir = join(inbox, shareId)
    const info = await inspect(dir)
    if (info) {
      if (!info.isDirectory()) throw new Error('acknowledged package must be a real directory; preserved')
      const state = await optionalJson(join(dir, '.delivery.json'))
      const children = await readdir(dir)
      // A crash after the final metadata unlink can leave only an empty directory.
      if (!(state === undefined && children.length === 0)
          && !matchesAcknowledgement(receipt, state, shareId)) {
        throw new Error('completion receipt does not match an acknowledged delivery; package preserved')
      }
      // Keep the acceptance proof until every payload byte is gone. Interrupted cleanup
      // then resumes without re-reading a partially removed manifest or staging it again.
      for (const child of children.sort()) {
        if (child === '.delivery.json') continue
        requireOwner()
        await rm(join(dir, child), { recursive: true, force: true })
      }
      requireOwner()
      await rm(join(dir, '.delivery.json'), { force: true })
      await rmdir(dir)
    }
    requireOwner()
    await unlink(receiptPath)
    pending.delete(shareId)
    await removeEmptyReceipts()
  }

  async function clearOrphanReceipts() {
    if (!(await checkReceipts())) return
    for (const entry of await readdir(receipts)) {
      // Completed records from earlier versions are also removed, without an age limit.
      const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json(?:\.tmp-[0-9a-f-]{36})?$/.exec(entry)
      if (!match) continue
      const shareId = match[1]
      if (await inspect(join(inbox, shareId)) || await inspect(join(inbox, 'failed', shareId))) continue
      try {
        const receiptPath = join(receipts, entry)
        const receipt = await readJson(receiptPath)
        await clearAcknowledged(shareId, receipt, receiptPath)
      } catch (error) {
        if (lifecycle.signal.aborted) return
        log('completion cleanup deferred', String(error?.message ?? error))
      }
    }
    await removeEmptyReceipts()
  }

  if (connection?.fetch?.register === undefined) throw new Error('dsh-macos-share requires connection.fetch.register')
  const responseError = (error, status = 500) => Response.json({ error: String(error?.message ?? error) }, { status, headers })
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  const validShareId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  async function readBody(request, acknowledged = false) {
    const body = await request.json().catch(() => undefined)
    if (body?.protocol !== 2 || !validShareId(body.shareId) || !validId(body.sessionId)
        || (acknowledged && !validId(body.requestId))) return undefined
    return body
  }
  function matchesDraft(delivery, body) {
    return delivery.state?.deliveryMode === 'draft' && delivery.state.accepted === true
      && delivery.state.sessionId === body.sessionId && delivery.state.requestId === body.requestId
  }
  async function routeOperation(operation) {
    try { return await serialize(operation) } catch (error) {
      if (lockStatus !== 'active' || lifecycle.signal.aborted) return unavailable()
      return responseError(error)
    }
  }

  ctx.effect(() => connection.fetch.register({
    path: '/api/dsh-share.draft.pending', methods: ['GET', 'HEAD'], requestBody: 'buffered',
    fetch: request => {
      if (lockStatus !== 'active') return unavailable()
      const sessionId = request?.headers?.get('x-dsh-share-session')
      const first = [...pending.values()].find(delivery => !sessionId || !delivery.state || delivery.state.sessionId === sessionId)
      if (!first) return new Response(null, { status: 204, headers })
      return Response.json({ protocol: 2, shareId: first.shareId,
        ...(first.state ? { targetSessionId: first.state.sessionId } : {}) }, { headers })
    },
  }), 'dsh-macos-share: pending route')
  ctx.effect(() => connection.fetch.register({
    path: '/api/dsh-share.draft.prepare', methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      if (lockStatus !== 'active') return unavailable()
      const body = await readBody(request)
      if (!body) return responseError('protocol 2, shareId and sessionId required', 400)
      return routeOperation(async () => {
        requireOwner()
        const delivery = pending.get(body.shareId)
        if (!delivery) return responseError('share not found', 404)
        if (delivery.state && delivery.state.sessionId !== body.sessionId) {
          return responseError('share is already pinned to another conversation', 409)
        }
        // Revalidate every byte source before pinning, including retries after a restart.
        const files = await describeDraftFiles(delivery.dir, delivery.manifest, lifecycle.signal)
        requireOwner()
        if (delivery.state?.files && JSON.stringify(delivery.state.files) !== JSON.stringify(draftSnapshot(files))) {
          return responseError('share changed after preparation; package preserved', 409)
        }
        if (!delivery.state || !delivery.state.files) {
          const state = delivery.state ?? { version: 1, deliveryMode: 'draft', sessionId: body.sessionId,
            requestId: randomUUID(), accepted: true, createdAt: Date.now() }
          const prepared = { ...state, files: draftSnapshot(files) }
          await writeJson(join(delivery.dir, '.delivery.json'), prepared)
          requireOwner()
          delivery.state = prepared
        }
        delivery.files = files
        return Response.json({ protocol: 2, shareId: delivery.shareId, sessionId: delivery.state.sessionId,
          requestId: delivery.state.requestId, files: publicDraftFiles(files) }, { headers })
      })
    },
  }), 'dsh-macos-share: draft preparation route')
  ctx.effect(() => connection.fetch.register({
    path: '/api/dsh-share.draft.file', methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      if (lockStatus !== 'active') return unavailable()
      const body = await readBody(request, true)
      if (!body || !Number.isInteger(body.index) || body.index < 0 || body.index >= MAX_DRAFT_FILES) {
        return responseError('protocol 2, pinned delivery identity and file index required', 400)
      }
      return routeOperation(async () => {
        requireOwner()
        const delivery = pending.get(body.shareId)
        if (!delivery) return responseError('share not found', 404)
        if (!matchesDraft(delivery, body)) return responseError('delivery identity does not match', 409)
        const entry = delivery.files[body.index]
        if (!entry) return responseError('file not found', 404)
        const transfer = await streamDraftFile(delivery.dir, entry, lifecycle.signal)
        streams.add(transfer.done)
        void transfer.done.finally(() => streams.delete(transfer.done))
        requireOwner()
        return new Response(transfer.body, { headers: { ...headers,
          'content-type': entry.type, 'content-length': String(entry.size) } })
      })
    },
  }), 'dsh-macos-share: draft file route')
  ctx.effect(() => connection.fetch.register({
    path: '/api/dsh-share.draft.ack', methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      if (lockStatus !== 'active') return unavailable()
      const body = await readBody(request, true)
      if (!body) return responseError('protocol 2 and pinned delivery identity required', 400)
      return routeOperation(async () => {
        requireOwner()
        const delivery = pending.get(body.shareId)
        if (delivery) {
          if (!matchesDraft(delivery, body)) return responseError('delivery identity does not match', 409)
          // A short-lived transaction marker supports crash recovery; it is not history.
          await mkdir(receipts, { recursive: true, mode: 0o700 })
          await checkReceipts()
          const receipt = {
            ...delivery.state, shareId: delivery.shareId, acknowledgedAt: Date.now(), pluginVersion: VERSION,
          }
          const receiptPath = join(receipts, `${delivery.shareId}.json`)
          await writeJson(receiptPath, receipt)
          requireOwner()
          await clearAcknowledged(delivery.shareId, receipt, receiptPath)
        } else if (await inspect(join(inbox, body.shareId)) || await inspect(join(inbox, 'failed', body.shareId))) {
          return responseError('share has not been prepared for this composer', 409)
        } else {
          // The previous ACK may have completed even if its HTTP response was lost.
          return new Response(null, { status: 204, headers })
        }
        return Response.json({ protocol: 2, ok: true }, { headers })
      })
    },
  }), 'dsh-macos-share: ack route')

  async function queue(manifest, dir, shareId) {
    requireOwner()
    const statePath = join(dir, '.delivery.json')
    const state = await optionalJson(statePath)
    if (state !== undefined && state.deliveryMode !== 'draft') {
      // Either old accepted value can follow a successful prompt interrupted before its
      // state write. Preserve these packages for explicit review instead of resending.
      throw new Error('legacy delivery status is uncertain; package preserved for manual review')
    }
    if (state !== undefined && (state.version !== 1 || !validId(state.sessionId)
        || !validId(state.requestId) || state.accepted !== true)) {
      throw new Error('invalid draft delivery state; inspect package before retrying')
    }
    const files = await describeDraftFiles(dir, manifest, lifecycle.signal)
    requireOwner()
    if (state?.files && JSON.stringify(state.files) !== JSON.stringify(draftSnapshot(files))) {
      throw new Error('share changed after preparation; package preserved')
    }
    pending.set(shareId, { dir, shareId, manifest, state, files })
  }

  async function sweep() {
    requireOwner()
    await mkdir(inbox, { recursive: true, mode: 0o700 })
    await checkReceipts()
    for (const entry of await readdir(inbox, { withFileTypes: true })) {
      if (lifecycle.signal.aborted) return
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'failed') continue
      const dir = join(inbox, entry.name)
      let clearing = false
      try {
        const receiptPath = join(receipts, `${entry.name}.json`)
        if (await inspect(receiptPath)) {
          clearing = true
          await clearAcknowledged(entry.name, await readJson(receiptPath), receiptPath)
          continue
        }
        const manifest = readManifest(await readJson(join(dir, 'manifest.json')))
        if (!validShareId(entry.name)) throw new Error('invalid share identifier')
        await queue(manifest, dir, entry.name)
      } catch (error) {
        if (lifecycle.signal.aborted) return // Leave the package for the replacement consumer.
        if (clearing) {
          log('acknowledged cleanup deferred', String(error?.message ?? error))
          continue // Keep the proof in place and retry cleanup, never delivery, next sweep.
        }
        log('share failed', entry.name, String(error?.message ?? error))
        pending.delete(entry.name)
        try {
          await writeJson(join(dir, '.error.json'), { message: String(error?.message ?? error), at: Date.now() })
          await mkdir(join(inbox, 'failed'), { recursive: true, mode: 0o700 })
          await rename(dir, join(inbox, 'failed', entry.name))
        } catch (failure) {
          log('could not preserve failed share', entry.name, String(failure?.message ?? failure))
        }
      }
    }
    await clearOrphanReceipts()
  }

  ctx.effect(() => {
    let disposed = false
    let timer
    let lease
    const tick = async () => {
      if (disposed || lockStatus !== 'active') return
      try { await serialize(sweep) } catch (error) { log('inbox unavailable', String(error?.message ?? error)) }
      if (!disposed && lockStatus === 'active') timer = setTimeout(tick, SWEEP_MS)
    }
    const startup = (async () => {
      try {
        lease = await acquireInboxLock(inbox, {
          signal: lifecycle.signal,
          onLost(error) {
            disposed = true
            lockStatus = 'lost'
            lockMessage = error.message
            lifecycle.abort(error)
            pending.clear()
            clearTimeout(timer)
            log(error.message)
          },
        })
        if (disposed) { await lease.release(); return }
        lockStatus = 'active'
        lockMessage = ''
        await tick()
      } catch (error) {
        if (disposed) return
        lockStatus = error.code === 'INBOX_BUSY' ? 'busy' : 'unavailable'
        lockMessage = error.message
        log(lockMessage)
      }
    })()
    return () => {
      disposed = true
      lockStatus = 'stopped'
      lockMessage = 'consumer stopped'
      lifecycle.abort()
      pending.clear()
      clearTimeout(timer)
      // The next instance cannot enter until in-flight delivery/ACK work settles.
      const cleanup = (async () => { await startup; await operations; await Promise.all(streams); await lease?.release() })()
      cleanup.catch(error => log('inbox lock release failed', String(error)))
      return cleanup
    }
  }, 'dsh-macos-share: inbox sweeper')
  log('watching inbox', inbox, 'version', VERSION)
}
