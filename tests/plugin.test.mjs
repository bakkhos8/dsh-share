import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { VERSION, inject } from '../plugin/dsh-share/index.js'
import { exists, until, host } from './helpers.mjs'

const queued = f => until(async () => (await f.pending()).status === 200)
const identity = async f => { await queued(f); return (await f.prepare()).json() }

test('new shares only queue, with no session, upload, prompt or navigation dependency', async t => {
  const f = await host(t); f.start(); await queued(f)
  assert.deepEqual(inject, ['connection'])
  const response = await f.pending()
  assert.equal(response.headers.get('x-dsh-share-version'), VERSION)
  assert.deepEqual(await response.json(), { protocol: 2, shareId: 'test-share' })
  assert.equal(f.routes.has('/api/dsh-share.pending'), false)
  assert.equal(f.routes.has('/api/dsh-share.ack'), false)
  assert.equal(await exists(join(f.dir, '.delivery.json')), false)
  assert.deepEqual(f.calls, [])
})

test('prepare and file transfer retain bytes until the composer ACKs the complete identity', async t => {
  const f = await host(t); f.start()
  const prepared = await identity(f)
  assert.deepEqual(prepared.files, [
    { index: 0, name: 'test.txt', type: 'text/plain', size: 25 },
    { index: 1, name: '分享内容.txt', type: 'text/plain', size: 15 },
  ])
  const state = JSON.parse(await readFile(join(f.dir, '.delivery.json')))
  assert.equal(state.version, 1); assert.equal(state.deliveryMode, 'draft'); assert.equal(state.accepted, true)
  assert.equal(state.sessionId, 'test-session'); assert.equal(state.requestId, prepared.requestId)
  assert.deepEqual(await (await f.pending()).json(), { protocol: 2, shareId: 'test-share', targetSessionId: 'test-session' })
  const attachment = await f.file(0)
  assert.equal(attachment.headers.get('content-type'), 'text/plain')
  assert.equal(attachment.headers.get('content-length'), '25')
  assert.equal(await attachment.text(), 'original attachment bytes')
  assert.equal(await (await f.file(1)).text(), 'regression test')
  assert.equal(await exists(join(f.dir, '0.bin')), true)
  assert.equal((await f.pending()).status, 200)
  assert.equal(await exists(join(f.inbox, '.receipts')), false)
  assert.equal((await f.ack()).status, 200)
  assert.equal(await exists(f.dir), false)
  assert.equal((await f.pending()).status, 204)
  assert.deepEqual(await readdir(f.inbox), ['.consumer.lock'])
  assert.equal((await f.ack(prepared)).status, 204)
  assert.deepEqual(await readdir(f.inbox), ['.consumer.lock'])
  assert.deepEqual(f.calls, [])
})

test('several shares can pin to one current thread without overwriting or acknowledging each other', async t => {
  const f = await host(t)
  const secondDir = join(f.inbox, 'second-share'); await mkdir(secondDir)
  await writeFile(join(secondDir, 'manifest.json'), JSON.stringify({ version: 1, text: 'second', urls: [], items: [] }))
  f.start(); await queued(f)
  const first = await (await f.prepare('same-thread', 'test-share')).json()
  const second = await (await f.prepare('same-thread', 'second-share')).json()
  assert.notEqual(first.requestId, second.requestId)
  assert.equal((await f.ack(first)).status, 200)
  assert.equal(await exists(f.dir), false)
  assert.equal(await exists(secondDir), true)
  assert.deepEqual(await (await f.pending()).json(), { protocol: 2, shareId: 'second-share', targetSessionId: 'same-thread' })
  assert.equal((await f.ack(second)).status, 200)
  assert.equal(await exists(secondDir), false)
  assert.deepEqual(f.calls, [])
})

test('prepare pins a target and requestId across repeated requests and refuses another target', async t => {
  const f = await host(t); f.start()
  const prepared = await identity(f)
  assert.deepEqual(await (await f.prepare()).json(), prepared)
  assert.equal((await f.prepare('different-thread')).status, 409)
  assert.equal((await f.ack({ ...prepared, sessionId: 'different-thread' })).status, 409)
  assert.equal((await f.ack({ ...prepared, requestId: 'stale-request' })).status, 409)
  assert.equal((await f.file(0, { ...prepared, requestId: 'stale-request' })).status, 409)
  assert.equal(await exists(join(f.dir, '0.bin')), true)
  assert.deepEqual(await (await f.prepare()).json(), prepared)
})

test('pending skips a share pinned to an inactive thread and offers later unclaimed shares', async t => {
  const f = await host(t); f.start(); const first = await identity(f)
  const secondDir = join(f.inbox, 'second-share'); await mkdir(secondDir)
  await writeFile(join(secondDir, 'manifest.json'), JSON.stringify({ version: 1, text: 'second', urls: [], items: [] }))
  await until(async () => (await f.pending('other-thread')).status === 200)
  assert.deepEqual(await (await f.pending('other-thread')).json(), { protocol: 2, shareId: 'second-share' })
  const second = await (await f.prepare('other-thread', 'second-share')).json()
  assert.equal((await f.pending('unrelated-thread')).status, 204)
  assert.equal((await (await f.pending('test-session')).json()).shareId, 'test-share')
  assert.equal((await (await f.pending('other-thread')).json()).shareId, 'second-share')
  await f.ack(second); await f.ack(first)
})

test('malformed, old-protocol and unprepared ACK requests cannot remove queued contents', async t => {
  const f = await host(t); f.start(); await queued(f)
  for (const body of [null, {}, { protocol: 1, shareId: 'test-share', sessionId: 'test-session' },
    { protocol: 2, shareId: '../test-share', sessionId: 'test-session' },
    { protocol: 2, shareId: 'test-share' }, { protocol: 2, shareId: 'test-share', sessionId: '' }]) {
    assert.equal((await f.request('prepare', body)).status, 400)
    assert.equal((await f.request('ack', body)).status, 400)
  }
  assert.equal((await f.request('ack', { protocol: 2, shareId: 'test-share', sessionId: 'test-session', requestId: 'not-prepared' })).status, 409)
  assert.equal((await f.prepare('test-session', 'missing')).status, 404)
  const prepared = await identity(f)
  for (const index of [-1, 129, '0', 1.5]) assert.equal((await f.request('file', { ...prepared, index })).status, 400)
  assert.equal((await f.file(3)).status, 404)
  assert.equal((await f.ack({ ...prepared, protocol: 1 })).status, 400)
  assert.equal(await exists(join(f.dir, '0.bin')), true)
})

test('restart restores the same pinned draft and never creates or executes a session', async t => {
  const f = await host(t); f.start()
  const prepared = await identity(f)
  await f.stop(); f.start(); await queued(f)
  assert.deepEqual(await (await f.pending()).json(), { protocol: 2, shareId: 'test-share', targetSessionId: 'test-session' })
  assert.deepEqual(await (await f.prepare()).json(), prepared)
  assert.equal(await (await f.file(0)).text(), 'original attachment bytes')
  assert.deepEqual(f.calls, [])
  await f.ack(prepared)
})

for (const accepted of [false, true]) test(`legacy accepted=${accepted} is quarantined without resending or deleting content`, async t => {
  const state = { version: 1, sessionId: 'legacy-session', requestId: 'legacy-request', accepted }
  const f = await host(t, { state }); f.start()
  const failed = join(f.inbox, 'failed', 'test-share')
  await until(() => exists(join(failed, '.error.json')))
  assert.equal(await readFile(join(failed, '0.bin'), 'utf8'), 'original attachment bytes')
  assert.deepEqual(JSON.parse(await readFile(join(failed, '.delivery.json'))), state)
  assert.match(await readFile(join(failed, '.error.json'), 'utf8'), /legacy delivery status is uncertain/)
  assert.equal((await f.pending()).status, 204)
  assert.deepEqual(f.calls, [])
})

for (const [label, manifest] of [
  ['escaping attachment path', { version: 1, text: '', urls: [], items: [{ kind: 'file', file: '../outside' }] }],
  ['unknown manifest version', { version: 2, text: 'text', urls: [], items: [] }],
  ['empty payload', { version: 1, text: ' ', urls: [], items: [] }],
]) test(`reject ${label} without executing anything`, async t => {
  const f = await host(t, { manifest }); f.start()
  await until(() => exists(join(f.inbox, 'failed', 'test-share', '.error.json')))
  assert.deepEqual(f.calls, [])
})

test('ACK storage failure preserves the bytes and pending offer for retry', async t => {
  const f = await host(t); f.start(); const prepared = await identity(f)
  const receipts = join(f.inbox, '.receipts'); await writeFile(receipts, 'blocked')
  assert.equal((await f.ack(prepared)).status, 500)
  assert.equal(await exists(join(f.dir, '0.bin')), true)
  assert.equal((await f.pending()).status, 200)
  await rm(receipts)
  assert.equal((await f.ack(prepared)).status, 200)
  assert.equal(await exists(f.dir), false)
})

test('failed preparation persistence does not pin only in memory or authorize an ACK', async t => {
  const f = await host(t); f.start(); await queued(f)
  const statePath = join(f.dir, '.delivery.json'); await mkdir(statePath)
  assert.equal((await f.prepare('first-thread')).status, 500)
  assert.deepEqual(await (await f.pending()).json(), { protocol: 2, shareId: 'test-share' })
  assert.equal((await f.request('ack', { protocol: 2, shareId: 'test-share', sessionId: 'first-thread', requestId: 'unpersisted' })).status, 409)
  assert.equal(await exists(join(f.dir, '0.bin')), true)
  await rm(statePath, { recursive: true })
  const response = await f.prepare('second-thread'); assert.equal(response.status, 200)
  const prepared = await response.json()
  assert.equal(JSON.parse(await readFile(statePath)).sessionId, 'second-thread')
  assert.equal((await f.ack(prepared)).status, 200)
})

test('an unacknowledged package survives a stale or mismatched completion receipt', async t => {
  const f = await host(t)
  await mkdir(join(f.inbox, '.receipts'))
  await writeFile(join(f.inbox, '.receipts', 'test-share.json'), JSON.stringify({
    version: 1, shareId: 'test-share', sessionId: 'old-session', requestId: 'old-request', accepted: true, acknowledgedAt: 1,
  }))
  f.start(); await until(async () => (await f.pending()).status === 204)
  assert.equal(await readFile(join(f.dir, '0.bin'), 'utf8'), 'original attachment bytes')
  assert.equal(await exists(join(f.inbox, '.receipts', 'test-share.json')), true)
  assert.deepEqual(f.calls, [])
})

test('a matching confirmed legacy receipt permits cleanup without repeating the old delivery', async t => {
  const state = { version: 1, sessionId: 'done-session', requestId: 'done-request', accepted: true }
  const f = await host(t, { state })
  await mkdir(join(f.inbox, '.receipts'))
  await writeFile(join(f.inbox, '.receipts', 'test-share.json'), JSON.stringify({ ...state, shareId: 'test-share', acknowledgedAt: 1 }))
  f.start(); await until(async () => !(await exists(f.dir)) && !(await exists(join(f.inbox, '.receipts'))))
  assert.deepEqual(f.calls, [])
})

test('interrupted ACK cleanup preserves proof and resumes cleanup without staging again',
  { skip: process.getuid?.() === 0 }, async t => {
    const f = await host(t); f.start(); const prepared = await identity(f)
    const blocked = join(f.dir, 'z-blocked'); await mkdir(blocked)
    await writeFile(join(blocked, 'payload'), 'already forwarded'); await chmod(blocked, 0o500)
    try {
      assert.equal((await f.ack(prepared)).status, 500)
      assert.equal(await exists(join(f.dir, '0.bin')), false)
      assert.equal(await exists(join(f.dir, '.delivery.json')), true)
      assert.equal(await exists(join(f.inbox, '.receipts', 'test-share.json')), true)
      await f.stop(); f.start()
      await until(async () => (await f.pending()).status === 204)
      assert.equal(await exists(join(f.dir, '.delivery.json')), true)
      assert.equal(await exists(join(f.inbox, 'failed', 'test-share')), false)
      assert.deepEqual(f.calls, [])
    } finally { await chmod(blocked, 0o700) }
    await until(async () => !(await exists(f.dir)) && !(await exists(join(f.inbox, '.receipts'))))
  })

test('cleanup recovers after the last acceptance file was removed from an empty package', async t => {
  const f = await host(t); await rm(join(f.dir, '0.bin')); await rm(join(f.dir, 'manifest.json'))
  await mkdir(join(f.inbox, '.receipts'))
  await writeFile(join(f.inbox, '.receipts', 'test-share.json'), JSON.stringify({
    version: 1, shareId: 'test-share', sessionId: 'done', requestId: 'done', accepted: true, acknowledgedAt: 1,
  }))
  f.start(); await until(async () => !(await exists(f.dir)) && !(await exists(join(f.inbox, '.receipts'))))
  assert.deepEqual(f.calls, [])
})

test('confirmed completion markers are removed without keeping history or an age limit', async t => {
  const f = await host(t); await rm(f.dir, { recursive: true })
  const receipts = join(f.inbox, '.receipts'); await mkdir(receipts)
  for (const [id, acknowledgedAt, suffix] of [
    ['old', 1, '.json'], ['recent', Date.now(), '.json'], ['future', Date.now() + 86400000, '.json'],
    ['temporary', 1, `.json.tmp-${randomUUID()}`],
  ]) await writeFile(join(receipts, id + suffix), JSON.stringify({
    version: 1, shareId: id, sessionId: id, requestId: id, accepted: true, acknowledgedAt,
  }))
  f.start(); await until(async () => !(await exists(receipts)))
  assert.deepEqual(await readdir(f.inbox), ['.consumer.lock'])
  assert.deepEqual(f.calls, [])
})

test('ACK refuses a symlinked receipts directory without writing to its target', async t => {
  const f = await host(t); f.start(); const prepared = await identity(f)
  const outside = join(f.inbox, '.external'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'external data')
  const receipts = join(f.inbox, '.receipts'); await symlink(outside, receipts)
  assert.equal((await f.ack(prepared)).status, 500)
  assert.deepEqual(await readdir(outside), ['keep'])
  assert.equal(await exists(join(f.dir, '0.bin')), true)
  await rm(receipts)
  assert.equal((await f.ack(prepared)).status, 200)
})

test('ambiguous completion markers and package symlinks are preserved', async t => {
  const f = await host(t); await rm(f.dir, { recursive: true })
  const outside = join(f.inbox, '.external'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'external data')
  await symlink(outside, f.dir)
  const receipts = join(f.inbox, '.receipts'); await mkdir(receipts)
  await writeFile(join(receipts, 'broken.json'), '{')
  await writeFile(join(receipts, 'test-share.json'), JSON.stringify({
    version: 1, shareId: 'test-share', sessionId: 'done', requestId: 'done', accepted: true, acknowledgedAt: 1,
  }))
  f.start(); await until(async () => (await f.pending()).status === 204)
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'external data')
  assert.deepEqual((await readdir(receipts)).sort(), ['broken.json', 'test-share.json'])
  assert.deepEqual(f.calls, [])
})
