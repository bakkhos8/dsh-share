import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

export const MAX_BATCH_BYTES = 256 * 1024 * 1024
export const MAX_SOURCE_FILES = 128
export const MAX_DRAFT_FILES = MAX_SOURCE_FILES + 1
export const FILE_CHUNK_BYTES = 64 * 1024

const types = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.heic': 'image/heic',
  '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.svg': 'image/svg+xml',
  '.html': 'text/html', '.htm': 'text/html', '.xml': 'application/xml', '.zip': 'application/zip',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
}

function safeName(suggested, fallback) {
  const cleaned = basename(String(suggested ?? fallback).replaceAll('\\', '/'))
    .replace(/[\x00-\x1f\x7f]/g, '').trim()
  return cleaned && cleaned !== '.' && cleaned !== '..'
    ? Array.from(cleaned).slice(0, 240).join('') : fallback
}

function fingerprint(info) {
  return { size: info.size, dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
}

function matches(info, expected) {
  return Object.entries(expected).every(([key, value]) => info[key] === value)
}

async function openRegular(path, expected) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error('share attachment must be a regular file')
    if (info.size > MAX_BATCH_BYTES) throw new Error('share batch exceeds 256 MiB')
    if (expected && !matches(info, expected)) throw new Error('share attachment changed after preparation')
    return { file, info }
  } catch (error) {
    await file.close()
    throw error
  }
}

// Names and sizes are fixed at preparation; no model or Harness upload service is involved.
export async function describeDraftFiles(dir, manifest, signal) {
  signal.throwIfAborted()
  const text = [manifest.text.trim() ? manifest.text : '', ...manifest.urls].filter(Boolean).join('\n\n')
  if (manifest.items.length > MAX_SOURCE_FILES) throw new Error('share batch exceeds 128 source attachments')
  const files = []
  let total = 0
  for (const item of manifest.items) {
    signal.throwIfAborted()
    const { file, info } = await openRegular(join(dir, item.file))
    await file.close()
    const name = safeName(typeof item.name === 'string' ? item.name : item.file, item.file)
    files.push({ name, type: types[extname(name).toLowerCase()] || 'application/octet-stream',
      size: info.size, source: item.file, fingerprint: fingerprint(info) })
    total += info.size
    if (total > MAX_BATCH_BYTES) throw new Error('share batch exceeds 256 MiB')
  }
  if (text) {
    const bytes = Buffer.from(text, 'utf8')
    total += bytes.length
    if (total > MAX_BATCH_BYTES) throw new Error('share batch exceeds 256 MiB')
    files.push({ name: '分享内容.txt', type: 'text/plain', size: bytes.length,
      digest: createHash('sha256').update(bytes).digest('hex'), bytes })
  }
  signal.throwIfAborted()
  return files
}

export function draftSnapshot(files) {
  return files.map(({ bytes, ...file }) => file)
}

export function publicDraftFiles(files) {
  return files.map(({ name, type, size }, index) => ({ index, name, type, size }))
}

// A pull reads one bounded chunk. Cancellation/disposal closes the original descriptor.
export async function streamDraftFile(dir, entry, signal) {
  signal.throwIfAborted()
  if (entry.bytes) return { body: entry.bytes, done: Promise.resolve() }
  const { file } = await openRegular(join(dir, entry.source), entry.fingerprint)
  let closed = false
  let closePromise
  let settled
  let controller
  let position = 0
  const done = new Promise(resolve => { settled = resolve })
  const close = () => {
    if (!closePromise) {
      closed = true
      signal.removeEventListener('abort', abort)
      closePromise = file.close().finally(settled)
    }
    return closePromise
  }
  const abort = () => {
    controller?.error(signal.reason ?? new DOMException('Transfer stopped', 'AbortError'))
    void close().catch(() => {})
  }
  const body = new ReadableStream({
    start(value) { controller = value; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort() },
    async pull(value) {
      if (closed) return
      try {
        signal.throwIfAborted()
        const buffer = Buffer.allocUnsafe(Math.min(FILE_CHUNK_BYTES, Math.max(1, entry.size - position)))
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position)
        signal.throwIfAborted()
        position += bytesRead
        if (position > entry.size) throw new Error('share attachment grew during transfer')
        if (!bytesRead && position !== entry.size) throw new Error('share attachment changed during transfer')
        if (position === entry.size) {
          if (!matches(await file.stat(), entry.fingerprint)) throw new Error('share attachment changed during transfer')
          if (bytesRead) value.enqueue(buffer.subarray(0, bytesRead))
          await close()
          value.close()
        } else if (bytesRead) value.enqueue(buffer.subarray(0, bytesRead))
      } catch (error) {
        await close().catch(() => {})
        if (!signal.aborted) value.error(error)
      }
    },
    cancel() { return close() },
  }, { highWaterMark: 0 })
  return { body, done }
}
