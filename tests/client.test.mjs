import test from 'node:test'
import assert from 'node:assert/strict'
import { clientHarness, flush } from './fixtures/browser.mjs'

test('share becomes attachments in current thread while preserving text and existing attachments', async t => {
  const f = await clientHarness(t)
  assert.equal(f.remaining(), 0)
  assert.equal(f.shell('thread-one').value.draft, 'keep my original text')
  assert.deepEqual(f.shell('thread-one').value.attachmentIds, ['existing', 'new-0'])
  assert.equal(await f.registry.get('new-0').file.text(), 'shared bytes')
  assert.equal(f.registry.get('new-0').file.name, '原图 #?.png')
  assert.ok(f.calls.findIndex(c => c[0] === 'append') < f.calls.findIndex(c => c[0] === 'ack'))
  assert.ok(!f.calls.some(c => c[0].startsWith('FORBIDDEN')))
})

test('no current composer leaves shares queued without preparing or creating a session', async t => {
  const f = await clientHarness(t, { current: null })
  await f.tick()
  assert.equal(f.remaining(), 1)
  assert.equal(f.calls.length, 0)
  await f.switchTo('chosen-thread')
  assert.equal(f.remaining(), 0)
  assert.equal(f.calls.find(c => c[0] === 'drafts')[1], 'chosen-thread')
})

test('two shares to the same thread append independently', async t => {
  const f = await clientHarness(t)
  f.add({ shareId: 'two' }); await f.tick()
  assert.equal(f.remaining(), 0)
  assert.equal(f.shell('thread-one').value.attachmentIds.length, 3)
  assert.deepEqual(f.calls.filter(c => c[0] === 'ack').map(c => c[1].shareId), ['one', 'two'])
})

test('ACK failures and client hot reload retry only confirmation without duplicate drafts', async t => {
  const f = await clientHarness(t, { blockedAck: true })
  await f.tick(); await f.reload(); await f.tick()
  assert.equal(f.remaining(), 1)
  assert.equal(f.calls.filter(c => c[0] === 'append').length, 1)
  assert.equal(f.calls.filter(c => c[0] === 'file').length, 1)
  f.setAckBlocked(false); await f.tick()
  assert.equal(f.remaining(), 0)
  assert.equal(f.conversation[Symbol.for('dsh-share.unacknowledged-drafts.v2')].size, 0)
})

test('a rejected admission retains source and releases only its own draft files', async t => {
  const f = await clientHarness(t, { failAdmission: true })
  assert.equal(f.remaining(), 1)
  assert.equal(f.registry.size, 0)
  assert.deepEqual(f.shell('thread-one').value.attachmentIds, ['existing'])
  assert.ok(!f.calls.some(c => c[0] === 'ack'))
  f.setAdmissionBlocked(false); await f.tick()
  assert.equal(f.remaining(), 0)
})

test('failed file transfer does not acknowledge or append a partial share', async t => {
  const f = await clientHarness(t, { failedFile: true })
  assert.equal(f.remaining(), 1)
  assert.equal(f.registry.size, 0)
  assert.ok(!f.calls.some(c => ['ack', 'append'].includes(c[0])))
})

test('a busy composer waits and then appends without sending', async t => {
  const f = await clientHarness(t, { current: null })
  f.shell('thread-one').value.phase = 'submitting'
  await f.switchTo('thread-one')
  assert.equal(f.remaining(), 1)
  assert.equal(f.registry.size, 0)
  f.shell('thread-one').value.phase = 'idle'; await f.tick()
  assert.equal(f.remaining(), 0)
})

test('switching threads during a transfer never redirects the claimed share', async t => {
  const f = await clientHarness(t, { current: null })
  let release
  f.gateFiles(new Promise(resolve => { release = resolve }))
  await f.switchTo('thread-one')
  await f.switchTo('thread-two'); release(); await flush(); await f.tick()
  assert.equal(f.remaining(), 1)
  assert.ok(!f.calls.some(c => ['append', 'ack'].includes(c[0])))
  f.gateFiles(null); await f.switchTo('thread-one'); await f.tick()
  assert.equal(f.remaining(), 0)
  assert.equal(f.calls.find(c => c[0] === 'append')[1], 'thread-one')
})

test('disposal during transfer leaves package unacknowledged and draft untouched', async t => {
  const f = await clientHarness(t, { current: null })
  let release
  f.gateFiles(new Promise(resolve => { release = resolve }))
  await f.switchTo('thread-one'); f.stop(); release(); await flush()
  assert.equal(f.remaining(), 1)
  assert.equal(f.registry.size, 0)
  assert.ok(!f.calls.some(c => c[0] === 'ack'))
})

test('old protocol responses cannot make new client navigate, send or acknowledge', async t => {
  const f = await clientHarness(t, { oldProtocol: true })
  assert.equal(f.remaining(), 1)
  assert.ok(!f.calls.some(c => c[0] === 'prepare'))
})
