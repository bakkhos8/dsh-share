import './native-helper.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, fork } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, readdir, readlink, realpath, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exists } from './helpers.mjs'

const exec = promisify(execFile)
const installer = fileURLToPath(new URL('../scripts/install-plugin.sh', import.meta.url))
const cleaner = fileURLToPath(new URL('../scripts/cleanup-inbox.sh', import.meta.url))

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-share-native-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = join(root, 'profile with spaces')
  const target = join(root, "plugin #?'\" $(literal) " + String.fromCodePoint(0x4e2d, 0x6587))
  const blocked = join(root, 'blocked-interpreters')
  const log = join(root, 'unexpected-interpreter-use')
  await mkdir(profile)
  await mkdir(blocked)
  for (const name of ['python', 'python3']) {
    const path = join(blocked, name)
    await writeFile(path, '#!/bin/sh\nprintf "blocked interpreter\\n" >> "$DSH_BLOCKED_INTERPRETER_LOG"\nexit 97\n')
    await chmod(path, 0o755)
  }
  const env = { ...process.env, DSH_PROFILE_DIR: profile, DSH_PLUGIN_DIR: target,
    PATH: `${blocked}:/usr/bin:/bin:/usr/sbin:/sbin`, DSH_BLOCKED_INTERPRETER_LOG: log }
  return { root, profile, target, log, env, manifest: join(profile, 'package.json') }
}

test('plugin installation uses the native helper, preserves profile data and needs no Python or standalone Node', async t => {
  const f = await fixture(t)
  const original = { name: 'synthetic-profile', dependencies: { keep: 'file:original' },
    custom: { literal: 'spaces #? "quotes" and $values' },
    dsh: { unrelated: true, profile: { bundles: ['existing'], keep: [1, 2, 3] } } }
  const bytes = JSON.stringify(original, null, 2) + '\n'
  await writeFile(f.manifest, bytes)
  await exec('/bin/bash', [installer], { env: f.env })
  const installed = JSON.parse(await readFile(f.manifest, 'utf8'))
  assert.equal(installed.dependencies['dsh-share'].startsWith('file:'), true)
  assert.equal(await realpath(installed.dependencies['dsh-share'].slice('file:'.length)), await realpath(f.target))
  assert.equal(installed.dependencies.keep, original.dependencies.keep)
  assert.deepEqual(installed.custom, original.custom)
  assert.deepEqual(installed.dsh.profile.keep, original.dsh.profile.keep)
  assert.deepEqual(installed.dsh.profile.bundles, ['existing', 'dsh-share'])
  assert.equal(await realpath(await readlink(join(f.profile, 'node_modules', 'dsh-share'))), await realpath(f.target))
  const backups = (await readdir(f.profile)).filter(name => name.startsWith('package.json.dsh-share-backup-'))
  assert.equal(backups.length, 1)
  assert.equal(await readFile(join(f.profile, backups[0]), 'utf8'), bytes)
  assert.equal(await exists(join(f.target, 'inbox-lock.js')), true)
  assert.equal(await exists(join(f.target, 'inbox_tools.py')), false)
  await exec('/bin/bash', [installer], { env: f.env })
  assert.equal((await readdir(f.profile)).filter(name => name.includes('dsh-share-backup-')).length, 1)
  assert.equal(await exists(f.log), false)
})

test('malformed profile JSON is never overwritten', async t => {
  const f = await fixture(t)
  await writeFile(f.manifest, '{ malformed profile')
  await assert.rejects(exec('/bin/bash', [installer], { env: f.env }))
  assert.equal(await readFile(f.manifest, 'utf8'), '{ malformed profile')
  assert.equal((await readdir(f.profile)).some(name => name.includes('dsh-share-backup-')), false)
})

test('a missing native helper stops installation before copying or editing profile data', async t => {
  const f = await fixture(t)
  const original = '{"name":"untouched"}\n'
  await writeFile(f.manifest, original)
  await assert.rejects(exec('/bin/bash', [installer], {
    env: { ...f.env, DSH_SHARE_HELPER: join(f.root, 'missing-native-helper') },
  }), /not executable/)
  assert.equal(await exists(f.target), false)
  assert.equal(await readFile(f.manifest, 'utf8'), original)
})

test('invalid profile field types are rejected without a rewrite or backup', async t => {
  const f = await fixture(t)
  const original = '{"dsh":{"profile":{"bundles":"invalid"}}}\n'
  await writeFile(f.manifest, original)
  await assert.rejects(exec(process.env.DSH_SHARE_HELPER, [
    'configure-profile', '--profile', f.manifest, '--plugin', f.target,
  ], { env: f.env }), /must be an array/)
  assert.equal(await readFile(f.manifest, 'utf8'), original)
  assert.equal((await readdir(f.profile)).some(name => name.includes('dsh-share-backup-')), false)
})

test('a real consumer delivers and ACKs, then native cleanup runs with Python blocked', async t => {
  const f = await fixture(t)
  const inbox = join(f.root, 'inbox')
  await mkdir(join(inbox, 'one'), { recursive: true })
  await writeFile(join(inbox, 'one', 'manifest.json'), JSON.stringify({ version: 1, text: 'synthetic', items: [], urls: [] }))
  const child = fork(new URL('./fixtures/consumer.mjs', import.meta.url), [inbox], {
    execArgv: [], env: f.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout.resume(); child.stderr.resume()
  let completed = false
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('native runtime probe timed out')) }, 5000)
    child.once('error', reject)
    child.once('close', code => { clearTimeout(timer); completed ? resolve() : reject(new Error('runtime probe exited: ' + code)) })
    child.on('message', message => {
      if (message.event === 'ready') child.send({ id: 1, command: 'pending' })
      if (message.id === 1) {
        if (message.status === 200) child.send({ id: 2, command: 'prepare', shareId: message.body.shareId })
        else setTimeout(() => { if (child.connected) child.send({ id: 1, command: 'pending' }) }, 10)
      }
      if (message.id === 2) {
        if (message.status !== 200) { child.kill('SIGKILL'); reject(new Error('prepare failed')); return }
        child.send({ id: 3, command: 'ack' })
      }
      if (message.id === 3) {
        if (message.status !== 200) { child.kill('SIGKILL'); reject(new Error('ACK failed')); return }
        completed = true
        child.send({ command: 'stop' })
      }
    })
  })
  assert.equal(await exists(join(inbox, 'one')), false)
  assert.equal(await exists(join(inbox, '.receipts')), false)
  await mkdir(join(inbox, 'pending'))
  await writeFile(join(inbox, 'pending', 'manifest.json'), '{}')
  const result = await exec('/bin/bash', [cleaner, '--inbox', inbox, '--older-than-days', '0', '--apply', '--json'], { env: f.env })
  const report = JSON.parse(result.stdout)
  assert.equal(report.removed.length, 0)
  assert.equal(await exists(join(inbox, 'pending', 'manifest.json')), true)
  assert.equal(await exists(f.log), false)
})
