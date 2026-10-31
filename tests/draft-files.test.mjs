import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile, readFile, truncate, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { FILE_CHUNK_BYTES, MAX_BATCH_BYTES, MAX_SOURCE_FILES, MAX_DRAFT_FILES } from '../plugin/dsh-share/draft-files.js'
import { exists, until, host } from './helpers.mjs'

const fileOnly = { version: 1, text: '', urls: [], items: [{ kind: 'file', name: 'test.bin', file: '0.bin' }] }
async function ready(f) {
  f.start(); await until(async () => (await f.pending()).status === 200)
  const response = await f.prepare(); assert.equal(response.status, 200)
  return response.json()
}
async function retainedFailure(f) {
  f.start()
  const failed = join(f.inbox, 'failed', 'test-share')
  await until(() => exists(join(failed, '.error.json')))
  assert.equal(await exists(join(failed, '0.bin')), true)
  assert.deepEqual(f.calls, [])
  return failed
}

test('256 MiB transfers raw bytes with bounded pulls, without Base64, uploads or automatic cleanup', async t => {
  const f = await host(t, { manifest: fileOnly })
  const file = join(f.dir, '0.bin'); await writeFile(file, ''); await truncate(file, MAX_BATCH_BYTES)
  const prepared = await ready(f)
  assert.equal(prepared.files[0].size, MAX_BATCH_BYTES)
  const response = await f.file()
  assert.equal(response.headers.get('content-length'), String(MAX_BATCH_BYTES))
  const hash = createHash('sha256')
  let length = 0, maxChunk = 0
  for await (const chunk of response.body) {
    hash.update(chunk); length += chunk.length; maxChunk = Math.max(maxChunk, chunk.length)
  }
  assert.equal(length, MAX_BATCH_BYTES); assert.equal(maxChunk, FILE_CHUNK_BYTES)
  const expected = createHash('sha256'), zero = Buffer.alloc(FILE_CHUNK_BYTES)
  for (let i = 0; i < MAX_BATCH_BYTES / zero.length; i++) expected.update(zero)
  assert.equal(hash.digest('hex'), expected.digest('hex'))
  assert.equal(await exists(file), true)
  assert.equal((await f.pending()).status, 200)
  assert.deepEqual(f.calls, [])
  await f.ack(prepared)
})

test('the 256 MiB limit applies to the complete batch including generated text', async t => {
  const f = await host(t)
  await truncate(join(f.dir, '0.bin'), MAX_BATCH_BYTES)
  const failed = await retainedFailure(f)
  assert.match(await readFile(join(failed, '.error.json'), 'utf8'), /batch exceeds 256 MiB/)
})

test('a single oversized attachment is preserved before any composer prepares it', async t => {
  const f = await host(t, { manifest: fileOnly })
  await truncate(join(f.dir, '0.bin'), MAX_BATCH_BYTES + 1)
  await retainedFailure(f)
})

test('a batch of individually valid files cannot exceed the combined size limit', async t => {
  const f = await host(t, { manifest: { ...fileOnly, items: [fileOnly.items[0], { kind: 'file', name: 'other.bin', file: '1.bin' }] } })
  await truncate(join(f.dir, '0.bin'), MAX_BATCH_BYTES / 2 + 1)
  await writeFile(join(f.dir, '1.bin'), ''); await truncate(join(f.dir, '1.bin'), MAX_BATCH_BYTES / 2)
  const failed = await retainedFailure(f)
  assert.equal(await exists(join(failed, '1.bin')), true)
})

test('128 source attachments can include one additional generated text attachment', async t => {
  const items = Array.from({ length: MAX_SOURCE_FILES }, (_, i) => ({ kind: 'file', name: `${i}.txt`, file: `${i}.bin` }))
  const f = await host(t, { manifest: { version: 1, text: 'one extra attachment', urls: [], items } })
  for (let i = 1; i < items.length; i++) await writeFile(join(f.dir, items[i].file), '')
  const prepared = await ready(f)
  assert.equal(prepared.files.length, MAX_DRAFT_FILES)
  assert.equal(await (await f.file(MAX_SOURCE_FILES)).text(), 'one extra attachment')
})

test('128 attachments without generated text are accepted', async t => {
  const items = Array.from({ length: MAX_SOURCE_FILES }, (_, i) => ({ kind: 'file', name: `${i}.txt`, file: `${i}.bin` }))
  const f = await host(t, { manifest: { version: 1, text: '', urls: [], items } })
  for (let i = 1; i < items.length; i++) await writeFile(join(f.dir, items[i].file), '')
  assert.equal((await ready(f)).files.length, MAX_SOURCE_FILES)
  assert.deepEqual(f.calls, [])
})

test('129 source attachments are rejected and retained', async t => {
  const items = Array.from({ length: MAX_SOURCE_FILES + 1 }, (_, i) => ({ kind: 'file', file: `${i}.bin` }))
  const f = await host(t, { manifest: { version: 1, text: '', urls: [], items } })
  const failed = await retainedFailure(f)
  assert.match(await readFile(join(failed, '.error.json'), 'utf8'), /128 attachments/)
})

test('suggested paths and control characters are stripped while # and ? remain literal filename bytes', async t => {
  const f = await host(t, { manifest: { version: 1, text: '中文原文', urls: ['https://example.invalid/a?b=1#c'], items: [
    { kind: 'image', name: '..\\outside\\my#file?.PNG\n', file: '0.bin' },
  ] } })
  const prepared = await ready(f)
  assert.equal(prepared.files[0].name, 'my#file?.PNG')
  assert.equal(prepared.files[0].type, 'image/png')
  assert.equal(await (await f.file(0)).text(), 'original attachment bytes')
  const text = '中文原文\n\nhttps://example.invalid/a?b=1#c'
  assert.equal(prepared.files[1].size, Buffer.byteLength(text))
  assert.equal(await (await f.file(1)).text(), text)
  const state = JSON.parse(await readFile(join(f.dir, '.delivery.json')))
  assert.equal(JSON.stringify(state).includes('中文原文'), false)
})

test('an empty regular attachment streams a complete zero-byte body', async t => {
  const f = await host(t, { manifest: fileOnly }); await writeFile(join(f.dir, '0.bin'), '')
  await ready(f)
  const response = await f.file()
  assert.equal(response.headers.get('content-length'), '0')
  assert.equal((await response.arrayBuffer()).byteLength, 0)
})

test('cancelling a response closes its stream and leaves original bytes available for retry', async t => {
  const f = await host(t, { manifest: fileOnly }); await truncate(join(f.dir, '0.bin'), FILE_CHUNK_BYTES * 3)
  await ready(f)
  const reader = (await f.file()).body.getReader()
  assert.equal((await reader.read()).value.length, FILE_CHUNK_BYTES)
  await reader.cancel()
  assert.equal(await exists(join(f.dir, '0.bin')), true)
  assert.equal((await (await f.file()).arrayBuffer()).byteLength, FILE_CHUNK_BYTES * 3)
})

for (const change of ['grow', 'shrink']) test(`a file that ${change}s during transfer errors and retains its source`, async t => {
  const f = await host(t, { manifest: fileOnly }); const file = join(f.dir, '0.bin')
  await truncate(file, FILE_CHUNK_BYTES * 3); await ready(f)
  const reader = (await f.file()).body.getReader(); await reader.read()
  await truncate(file, change === 'grow' ? FILE_CHUNK_BYTES * 4 : 1)
  await assert.rejects(async () => { while (!(await reader.read()).done) {} }, /changed|grew/)
  assert.equal(await exists(file), true)
  assert.equal(await exists(join(f.inbox, '.receipts')), false)
})

test('modification after prepare refuses another file response and preserves delivery proof', async t => {
  const f = await host(t, { manifest: fileOnly }); await ready(f)
  await writeFile(join(f.dir, '0.bin'), 'changed attachment')
  assert.equal((await f.file()).status, 500)
  assert.equal((await f.prepare()).status, 409)
  assert.equal(await exists(join(f.dir, '.delivery.json')), true)
  assert.equal(await exists(join(f.inbox, '.receipts')), false)
})

test('restarting after a prepared attachment changes quarantines it without transferring or deleting bytes', async t => {
  const f = await host(t, { manifest: fileOnly }); await ready(f); await f.stop()
  await writeFile(join(f.dir, '0.bin'), 'changed attachment')
  const failed = await retainedFailure(f)
  assert.equal(await readFile(join(failed, '0.bin'), 'utf8'), 'changed attachment')
  assert.match(await readFile(join(failed, '.error.json'), 'utf8'), /changed after preparation/)
})

test('symbolic-link attachments are refused before preparation without reading the target', async t => {
  const f = await host(t)
  await writeFile(join(f.inbox, 'outside'), 'private bytes'); await rm(join(f.dir, '0.bin'))
  await symlink(join(f.inbox, 'outside'), join(f.dir, '0.bin'))
  await retainedFailure(f)
  assert.equal(await readFile(join(f.inbox, 'outside'), 'utf8'), 'private bytes')
})

test('a symlink substituted after preparation cannot be fetched', async t => {
  const f = await host(t, { manifest: fileOnly }); await ready(f)
  await writeFile(join(f.inbox, 'outside'), 'private bytes'); await rm(join(f.dir, '0.bin'))
  await symlink(join(f.inbox, 'outside'), join(f.dir, '0.bin'))
  assert.equal((await f.file()).status, 500)
  assert.equal(await readFile(join(f.inbox, 'outside'), 'utf8'), 'private bytes')
})

test('oversized metadata is preserved rather than read into an unbounded buffer', async t => {
  const f = await host(t); await writeFile(join(f.dir, 'manifest.json'), ' '.repeat(1024 * 1024 + 1))
  await retainedFailure(f)
})
