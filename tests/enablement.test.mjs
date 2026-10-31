import './native-helper.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, fork } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { until, exists } from './helpers.mjs'

const exec = promisify(execFile), probe = process.env.DSH_ENABLEMENT_PROBE, helper = process.env.DSH_SHARE_HELPER
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-share-checks-'))
  const consumers = []
  t.after(async () => {
    for (const { child, closed } of consumers) {
      if (child.exitCode === null) child.kill('SIGTERM')
      await closed
    }
    await rm(root, { recursive: true, force: true })
  })
  const profile = join(root, 'desktop #?'), inbox = join(root, 'inbox')
  const plugin = join(profile, 'node_modules/dsh-share')
  await mkdir(plugin, { recursive: true }); await mkdir(inbox)
  const manifest = { dependencies: { 'dsh-share': 'file:' + plugin }, dsh: { profile: { bundles: ['dsh-share'] } } }
  await writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
  await writeFile(join(plugin, 'package.json'), '{"name":"dsh-share"}')
  await writeFile(join(plugin, '.installation.json'), JSON.stringify({ formatVersion: 1, helperPath: helper }))
  async function receiver(extra = []) {
    return JSON.parse((await exec(probe, ['receiver', '--profile', profile, '--inbox', inbox,
      '--harness-running', 'yes', '--host-executable', process.execPath, '--helper', helper, ...extra])).stdout).receiver
  }
  async function consumer(cwd = profile) {
    const child = fork(new URL('./fixtures/consumer.mjs', import.meta.url), [inbox], {
      cwd, env: process.env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    child.stdout.resume(); child.stderr.resume()
    const closed = new Promise(resolve => child.once('close', resolve))
    consumers.push({ child, closed })
    await until(async () => {
      try { return JSON.parse(await readFile(join(inbox, '.consumer.lock'), 'utf8')).pid === child.pid }
      catch { return false }
    })
    return child
  }
  return { root, profile, inbox, plugin, manifest, receiver, consumer }
}

test('readiness proves a live receiver in the selected profile without changing its lock', async t => {
  const f = await fixture(t); await f.consumer()
  const before = await readFile(join(f.inbox, '.consumer.lock'))
  assert.equal(await f.receiver(), 'ready')
  assert.deepEqual(await readFile(join(f.inbox, '.consumer.lock')), before)
})
test('a missing receiver configuration is not reported as ready', async t => {
  const f = await fixture(t)
  await writeFile(join(f.profile, 'package.json'), '{}')
  assert.equal(await f.receiver(), 'notInstalled')
  assert.equal(await exists(join(f.inbox, '.consumer.lock')), false)
})
test('a stopped Harness is distinguished from an inactive plugin', async t => {
  const f = await fixture(t)
  assert.equal(await f.receiver(['--harness-running', 'no']), 'harnessClosed')
  assert.equal(await f.receiver(), 'inactive')
})
test('checks do not create an absent inbox or lock file', async t => {
  const f = await fixture(t); await rm(f.inbox, { recursive: true })
  assert.equal(await f.receiver(), 'inactive')
  assert.equal(await exists(f.inbox), false)
})
test('an unlocked stale record cannot mark a receiver as running even with live PIDs', async t => {
  const f = await fixture(t)
  await writeFile(join(f.inbox, '.consumer.lock'), JSON.stringify({ version: 1, pid: process.pid, helperPid: process.pid }))
  assert.equal(await f.receiver(), 'inactive')
})
test('an active receiver in a different profile does not pass the desktop check', async t => {
  const f = await fixture(t), other = join(f.root, 'other-profile')
  await mkdir(other); await f.consumer(other)
  assert.equal(await f.receiver(), 'otherProfile')
})
test('an unexpected helper executable fails closed', async t => {
  const f = await fixture(t); await f.consumer()
  await writeFile(join(f.plugin, '.installation.json'), JSON.stringify({ formatVersion: 1, helperPath: '/unexpected/helper' }))
  assert.equal(await f.receiver(), 'unknown')
})
test('lock symlinks are not followed and their targets are preserved', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside')
  await writeFile(outside, 'private fixture'); await symlink(outside, join(f.inbox, '.consumer.lock'))
  assert.equal(await f.receiver(), 'unknown')
  assert.equal(await readFile(outside, 'utf8'), 'private fixture')
})
test('malformed configuration does not pass the check', async t => {
  const f = await fixture(t); await writeFile(join(f.profile, 'package.json'), '{')
  assert.equal(await f.receiver(), 'unknown')
})

const extension = '/Applications/DSHShare.app/Contents/PlugIns/DSHShareExtension.appex'
const line = (tag, location = extension) => `${tag}    com.movy.dshshare.host.share(1.0)\tUUID\t2026-10-31 00:00:00 +0000\t${location}\n (1 plug-in)\n`
for (const [label, report, available, expected] of [
  ['enabled and offered', line('+'), true, 'ready'],
  ['default election and offered', line(' '), true, 'ready'],
  ['ignored despite a cached service', line('-'), true, 'disabled'],
  ['selected but unavailable to the share host', line('+'), false, 'disabled'],
  ['superseded', line('='), true, 'otherCopy'],
  ['debugger-only', line('!'), true, 'unknown'],
  ['unknown election', line('?'), true, 'unknown'],
  ['another app copy', line('+', '/Volumes/DSH Share/DSHShare.app/Contents/PlugIns/DSHShareExtension.appex'), true, 'otherCopy'],
  ['unregistered', ' (0 plug-ins)\n', true, 'notRegistered'],
]) test(`system-sharing check: ${label}`, async t => {
  const f = await fixture(t), file = join(f.root, 'registry.txt'); await writeFile(file, report)
  const result = JSON.parse((await exec(probe, ['sharing', '--report', file, '--extension', extension,
    '--service-available', available ? 'yes' : 'no'])).stdout)
  assert.equal(result.sharing, expected)
})
test('a failed system query is unknown rather than enabled', async () => {
  const result = JSON.parse((await exec(probe, ['sharing', '--extension', extension, '--service-available', 'yes'])).stdout)
  assert.equal(result.sharing, 'unknown')
})
test('a stalled registry query times out rather than hanging the assistant', async t => {
  const f = await fixture(t), command = join(f.root, 'slow-query')
  await writeFile(command, '#!/bin/sh\nexec /bin/sleep 10\n'); await chmod(command, 0o700)
  const start = Date.now()
  const result = JSON.parse((await exec(probe, ['registry', '--command', command])).stdout)
  assert.equal(result.available, false)
  assert.ok(Date.now() - start < 3000)
})
