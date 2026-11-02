import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireInboxLock } from '../plugins/dsh-macos-share/inbox-lock.js'
import { exists, until, host } from './helpers.mjs'

async function processFixture(t) {
  const inbox = await mkdtemp(join(tmpdir(), 'dsh-share-process-test-'))
  const workers = []
  t.after(async () => {
    await Promise.all(workers.map(worker => worker.stop()))
    await rm(inbox, { recursive: true, force: true })
  })
  const dir = join(inbox, 'one')
  await mkdir(dir)
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ version: 1, text: 'synthetic', urls: [], items: [] }))
  async function start() {
    const child = fork(new URL('./fixtures/consumer.mjs', import.meta.url), [inbox], {
      execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const events = [], replies = new Map()
    let nextId = 0, ended = false
    let closed
    const completion = new Promise(resolve => { closed = resolve })
    child.stdout.resume()
    child.stderr.resume()
    child.on('message', message => {
      if (message.event) events.push(message.event)
      if (message.id) { replies.get(message.id)?.(message); replies.delete(message.id) }
    })
    child.once('close', () => { ended = true; closed() })
    const request = (command, body) => new Promise((resolve, reject) => {
      const id = ++nextId
      replies.set(id, resolve)
      child.send({ id, command, body }, error => { if (error) reject(error) })
    })
    const stop = async () => {
      if (ended) return
      if (child.connected) child.send({ command: 'stop' })
      const timeout = setTimeout(() => child.kill('SIGKILL'), 3000)
      await completion
      clearTimeout(timeout)
    }
    const worker = { child, events, stop, completion, pending: () => request('pending'),
      prepare: body => request('prepare', body), ack: body => request('ack', body) }
    workers.push(worker)
    await until(() => events.includes('ready'))
    return worker
  }
  return { inbox, dir, start }
}

test('two independent Node processes never consume the inbox concurrently', async t => {
  const f = await processFixture(t)
  const owner = await f.start()
  await until(async () => (await owner.pending()).status === 200)
  const competitor = await f.start()
  await until(async () => (await competitor.pending()).body?.status === 'busy')
  const prepared = await owner.prepare()
  assert.equal(prepared.status, 200)
  assert.equal(owner.events.filter(event => event === 'create').length, 0)
  assert.equal(owner.events.filter(event => event === 'prompt').length, 0)
  assert.equal((await competitor.prepare()).status, 503)
  assert.equal(competitor.events.includes('create'), false)
  assert.equal(competitor.events.includes('prompt'), false)
  await competitor.stop()
  await owner.stop()
  const replacement = await f.start()
  await until(async () => (await replacement.pending()).status === 200)
  assert.equal(replacement.events.includes('prompt'), false)
  assert.equal((await replacement.pending()).body.targetSessionId, 'shared-session')
  assert.equal((await replacement.prepare()).body.requestId, prepared.body.requestId)
})

test('simultaneous consumer startups admit exactly one owner', async t => {
  const f = await processFixture(t)
  const workers = await Promise.all([f.start(), f.start(), f.start()])
  await until(async () => {
    const states = await Promise.all(workers.map(worker => worker.pending()))
    return states.filter(state => state.status === 200).length === 1
      && states.filter(state => state.body?.status === 'busy').length === 2
  })
  const states = await Promise.all(workers.map(worker => worker.pending()))
  const ownerIndex = states.findIndex(state => state.status === 200)
  assert.equal((await workers[ownerIndex].prepare()).status, 200)
  assert.equal(workers.flatMap(worker => worker.events).filter(event => event === 'create').length, 0)
  assert.equal(workers.flatMap(worker => worker.events).filter(event => event === 'prompt').length, 0)
})

test('parent SIGKILL releases the OS lock and preserves a pinned draft for recovery', async t => {
  const f = await processFixture(t)
  const owner = await f.start()
  await until(async () => (await owner.pending()).status === 200)
  const prepared = await owner.prepare()
  owner.child.kill('SIGKILL')
  await owner.completion
  const replacement = await f.start()
  await until(async () => (await replacement.pending()).status === 200)
  assert.equal(replacement.events.includes('create'), false)
  assert.equal(replacement.events.includes('prompt'), false)
  assert.equal((await replacement.pending()).body.targetSessionId, 'shared-session')
  assert.equal((await replacement.prepare()).body.requestId, prepared.body.requestId)
  assert.equal(await exists(join(f.dir, 'manifest.json')), true)
})

test('unexpected lock-helper death stops consumption and refuses ACKs', async t => {
  const f = await processFixture(t)
  const owner = await f.start()
  await until(async () => (await owner.pending()).status === 200)
  await owner.prepare()
  const metadata = JSON.parse(await readFile(join(f.inbox, '.consumer.lock'), 'utf8'))
  process.kill(metadata.helperPid, 'SIGKILL')
  await until(async () => (await owner.pending()).body?.status === 'lost')
  assert.equal((await owner.ack()).status, 503)
  assert.equal(await exists(join(f.dir, 'manifest.json')), true)
  await mkdir(join(f.inbox, 'two'))
  await writeFile(join(f.inbox, 'two', 'manifest.json'), JSON.stringify({ version: 1, text: 'second', urls: [], items: [] }))
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal(owner.events.filter(event => event === 'prompt').length, 0)
  assert.equal(await exists(join(f.inbox, 'two', 'manifest.json')), true)
})

test('plugin disposal cancels outstanding file bodies before releasing its lock', async t => {
  const f = await host(t)
  f.start()
  await until(async () => (await f.pending()).status === 200)
  await f.prepare()
  const reader = (await f.file()).body.getReader()
  await f.stop()
  await assert.rejects(reader.read(), { name: 'AbortError' })
  assert.deepEqual(f.calls, [])
  assert.equal(await exists(join(f.dir, '0.bin')), true)
  const next = await acquireInboxLock(f.inbox, { waitMs: 0 })
  await next.release()
})

test('a missing native helper fails closed without starting a consumer', async t => {
  const inbox = await mkdtemp(join(tmpdir(), 'dsh-share-no-helper-'))
  t.after(() => rm(inbox, { recursive: true, force: true }))
  const previous = process.env.DSH_SHARE_HELPER
  try {
    process.env.DSH_SHARE_HELPER = join(inbox, 'missing-native-helper')
    await assert.rejects(acquireInboxLock(inbox), { code: 'LOCK_UNAVAILABLE' })
  } finally {
    if (previous === undefined) delete process.env.DSH_SHARE_HELPER
    else process.env.DSH_SHARE_HELPER = previous
  }
})

test('a symlink at the lock path is refused without changing its target', async t => {
  const inbox = await mkdtemp(join(tmpdir(), 'dsh-share-lock-symlink-'))
  t.after(() => rm(inbox, { recursive: true, force: true }))
  const target = join(inbox, 'keep.txt')
  await writeFile(target, 'preserve me')
  await symlink(target, join(inbox, '.consumer.lock'))
  await assert.rejects(acquireInboxLock(inbox), { code: 'LOCK_UNAVAILABLE' })
  assert.equal(await readFile(target, 'utf8'), 'preserve me')
})
