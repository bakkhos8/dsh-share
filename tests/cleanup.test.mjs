import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireInboxLock } from '../plugin/dsh-share/inbox-lock.js'
import { exists } from './helpers.mjs'

const exec = promisify(execFile)
const command = fileURLToPath(new URL('../scripts/cleanup-inbox.sh', import.meta.url))
const old = Date.now() - 90 * 86400 * 1000
const receipt = (id, overrides = {}) => ({
  version: 1, shareId: id, sessionId: `session-${id}`, requestId: `request-${id}`,
  accepted: true, acknowledgedAt: old, ...overrides,
})
async function fixture(t) {
  const inbox = await mkdtemp(join(tmpdir(), 'dsh-share-cleanup-'))
  t.after(() => rm(inbox, { recursive: true, force: true }))
  const receipts = join(inbox, '.receipts')
  await mkdir(receipts)
  const writeReceipt = (id, value = receipt(id)) => writeFile(join(receipts, `${id}.json`), JSON.stringify(value))
  async function packageAt(name, state) {
    const directory = join(inbox, name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, '0.bin'), `preserved ${name}`)
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ version: 1, createdAt: 1, text: name, items: [], urls: [] }))
    if (state) await writeFile(join(directory, '.delivery.json'), JSON.stringify(state))
    return directory
  }
  async function clean(...args) {
    const result = await exec(command, ['--inbox', inbox, '--json', ...args])
    return JSON.parse(result.stdout)
  }
  return { inbox, receipts, writeReceipt, packageAt, clean }
}

test('cleanup previews by default and applies only old acknowledged records and matching leftovers', async t => {
  const f = await fixture(t)
  await f.packageAt('pending')
  await f.packageAt('unconfirmed', { version: 1, accepted: true, sessionId: 'u', requestId: 'u' })
  await f.packageAt('failed/old')
  await f.packageAt('.tmp-old')
  await f.writeReceipt('complete')
  await f.packageAt('leftover', receipt('leftover'))
  await f.writeReceipt('leftover')
  await f.writeReceipt('recent', receipt('recent', { acknowledgedAt: Date.now() }))
  await f.writeReceipt('pending') // A receipt cannot authorize deletion of an unaccepted package.
  await f.writeReceipt('unconfirmed', receipt('unconfirmed', { accepted: false }))
  await writeFile(join(f.receipts, 'broken.json'), '{')
  const preview = await f.clean('--older-than-days', '30')
  assert.equal(preview.mode, 'preview')
  assert.deepEqual(preview.eligible.map(item => item.shareId), ['complete', 'leftover'])
  assert.equal(preview.removed.length, 0)
  assert.equal(await exists(join(f.receipts, 'complete.json')), true)
  assert.equal(await exists(join(f.inbox, 'leftover', '0.bin')), true)
  const applied = await f.clean('--older-than-days', '30', '--apply')
  assert.deepEqual(applied.removed.map(item => item.shareId), ['complete', 'leftover'])
  assert.equal(await exists(join(f.receipts, 'complete.json')), false)
  assert.equal(await exists(join(f.inbox, 'leftover')), false)
  for (const name of ['pending', 'unconfirmed', 'failed/old', '.tmp-old']) {
    assert.equal(await readFile(join(f.inbox, name, '0.bin'), 'utf8'), `preserved ${name}`)
  }
  for (const name of ['recent', 'pending', 'unconfirmed', 'broken']) {
    assert.equal(await exists(join(f.receipts, `${name}.json`)), true)
  }
})

test('cleanup preserves acknowledged-but-unconfirmed packages at any age', async t => {
  const f = await fixture(t)
  await f.packageAt('no-ack', { version: 1, accepted: true, sessionId: 's', requestId: 'r', deliveredAt: 1 })
  await f.packageAt('failed/very-old')
  const result = await f.clean('--older-than-days', '0', '--apply')
  assert.equal(result.removed.length, 0)
  assert.equal(await exists(join(f.inbox, 'no-ack', '0.bin')), true)
  assert.equal(await exists(join(f.inbox, 'failed', 'very-old', '0.bin')), true)
})

test('cleanup refuses to run while a consumer owns the inbox', async t => {
  const f = await fixture(t)
  await f.writeReceipt('complete')
  const owner = await acquireInboxLock(f.inbox)
  try {
    await assert.rejects(f.clean('--apply'), error => error.code === 75 && /in use/.test(error.stderr))
    assert.equal(await exists(join(f.receipts, 'complete.json')), true)
  } finally {
    await owner.release()
  }
})

test('cleanup preserves receipt symlinks, package symlinks and external targets', async t => {
  const f = await fixture(t)
  const outside = await f.packageAt('outside')
  const external = join(outside, 'external.json')
  await writeFile(external, JSON.stringify(receipt('receipt-link')))
  await symlink(external, join(f.receipts, 'receipt-link.json'))
  await f.writeReceipt('package-link')
  await symlink(outside, join(f.inbox, 'package-link'))
  const result = await f.clean('--apply')
  assert.equal(result.removed.length, 0)
  assert.equal(result.preserved.length, 2)
  assert.equal(await readFile(join(outside, '0.bin'), 'utf8'), 'preserved outside')
  assert.equal(await exists(external), true)
})

test('a symlinked receipts directory stops cleanup without following it', async t => {
  const f = await fixture(t)
  await rm(f.receipts, { recursive: true })
  const outside = await f.packageAt('outside')
  await writeFile(join(outside, 'complete.json'), JSON.stringify(receipt('complete')))
  await symlink(outside, f.receipts)
  await assert.rejects(f.clean('--apply'), /real directory/)
  assert.equal(await exists(join(outside, 'complete.json')), true)
})

test('negative retention intervals are rejected without deleting anything', async t => {
  const f = await fixture(t)
  await f.writeReceipt('complete')
  await assert.rejects(f.clean('--older-than-days', '-1', '--apply'), error => error.code === 2)
  assert.equal(await exists(join(f.receipts, 'complete.json')), true)
})

test('invalid acknowledgement field types cannot authorize cleanup', async t => {
  const f = await fixture(t)
  await f.writeReceipt('boolean-version', receipt('boolean-version', { version: true }))
  await f.writeReceipt('boolean-time', receipt('boolean-time', { acknowledgedAt: true }))
  await f.writeReceipt('unaccepted', receipt('unaccepted', { accepted: false }))
  const result = await f.clean('--older-than-days', '0', '--apply')
  assert.equal(result.removed.length, 0)
  assert.equal(result.preserved.length, 3)
})

test('native cleanup unlinks nested symlinks without traversing their targets', async t => {
  const f = await fixture(t)
  const outside = await f.packageAt('outside')
  const packagePath = await f.packageAt('complete', receipt('complete'))
  await f.writeReceipt('complete')
  await mkdir(join(packagePath, 'nested'))
  await symlink(outside, join(packagePath, 'nested', 'external-link'))
  const result = await f.clean('--apply')
  assert.equal(result.removed.length, 1)
  assert.equal(await exists(packagePath), false)
  assert.equal(await readFile(join(outside, '0.bin'), 'utf8'), 'preserved outside')
})

test('cleanup defaults to all proven completions and recovers an empty leftover directory', async t => {
  const f = await fixture(t)
  await mkdir(join(f.inbox, 'empty'))
  await f.writeReceipt('empty', receipt('empty', { acknowledgedAt: Date.now() + 86400000 }))
  const temporary = receipt('temporary')
  await writeFile(join(f.receipts, 'temporary.json.tmp-00000000-0000-0000-0000-000000000001'), JSON.stringify(temporary))
  const result = await f.clean('--apply')
  assert.equal(result.removed.length, 2)
  assert.equal(await exists(join(f.inbox, 'empty')), false)
  assert.equal(await exists(f.receipts), false)
})

test('native interrupted cleanup keeps acceptance last and can resume safely',
  { skip: process.getuid?.() === 0 }, async t => {
    const f = await fixture(t), directory = await f.packageAt('complete', receipt('complete'))
    await f.writeReceipt('complete')
    const blocked = join(directory, 'z-blocked'); await mkdir(blocked)
    await writeFile(join(blocked, 'content'), 'already forwarded'); await chmod(blocked, 0o500)
    try {
      const result = await f.clean('--apply')
      assert.equal(result.removed.length, 0)
      assert.equal(result.preserved.length, 1)
      assert.equal(await exists(join(directory, '0.bin')), false)
      assert.equal(await exists(join(directory, '.delivery.json')), true)
      assert.equal(await exists(join(f.receipts, 'complete.json')), true)
    } finally { await chmod(blocked, 0o700) }
    assert.equal((await f.clean('--apply')).removed.length, 1)
    assert.equal(await exists(directory), false)
    assert.equal(await exists(f.receipts), false)
  })
