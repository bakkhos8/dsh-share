import './native-helper.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, fork } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, readdir, copyFile, chmod, readlink, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveNativeHelper } from '../plugins/dsh-macos-share/native-helper.js'
import { exists } from './helpers.mjs'

const exec = promisify(execFile)
const helper = process.env.DSH_SHARE_HELPER
const packageRoot = fileURLToPath(new URL('../plugins/dsh-macos-share/', import.meta.url))
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-share-setup-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'bundled plugin'), profile = join(root, 'profile'), target = join(root, 'installed', 'dsh-macos-share')
  await mkdir(source); await mkdir(profile)
  const manifest = join(profile, 'package.json')
  const original = '{"name":"fixture","dependencies":{"keep":"original"},"dsh":{"profile":{"bundles":["existing"]}}}\n'
  await writeFile(manifest, original)
  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  for (const name of [...pkg.files, 'package.json']) await copyFile(join(packageRoot, name), join(source, name))
  const install = async () => JSON.parse((await exec(helper, ['install-plugin', '--profile-dir', profile,
    '--source', source, '--destination', target, '--json'])).stdout)
  return { root, source, profile, target, manifest, original, install }
}

test('first-run installation copies declared files and records the stable native helper path', async t => {
  const f = await fixture(t)
  await writeFile(join(f.source, 'local-only.txt'), 'must not enter the app or installed plugin')
  const result = await f.install()
  assert.equal(result.status, 'installed')
  assert.equal(result.changed, true)
  const metadata = JSON.parse(await readFile(join(f.target, '.installation.json'), 'utf8'))
  assert.equal(await realpath(metadata.helperPath), await realpath(helper))
  assert.equal(metadata.formatVersion, 1)
  assert.equal(await exists(join(f.target, 'local-only.txt')), false)
  const installedPackage = JSON.parse(await readFile(join(f.target, 'package.json'), 'utf8'))
  assert.equal(typeof installedPackage.icon, 'string')
  assert.ok(installedPackage.files.includes(installedPackage.icon))
  const icon = await readFile(join(f.target, installedPackage.icon))
  assert.ok(icon.length <= 256 * 1024, 'Harness limits plugin icons to 256 KiB')
  assert.deepEqual(icon.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  assert.equal(await realpath(await readlink(join(f.profile, 'node_modules', 'dsh-macos-share'))), await realpath(f.target))
  const again = await f.install()
  assert.equal(again.changed, false)
  assert.equal((await readdir(f.profile)).filter(name => name.includes('dsh-share-backup-')).length, 1)
})

test('bundling the plugin excludes local installation metadata and undeclared files', async t => {
  const f = await fixture(t), destination = join(f.root, 'resources', 'dsh-macos-share')
  await writeFile(join(f.source, '.installation.json'), '{"helperPath":"local-only"}')
  await writeFile(join(f.source, 'local-only.txt'), 'private fixture')
  await exec(helper, ['bundle-plugin', '--source', f.source, '--destination', destination])
  const pkg = JSON.parse(await readFile(join(f.source, 'package.json'), 'utf8'))
  assert.deepEqual((await readdir(destination)).sort(), [...new Set([...pkg.files, 'package.json'])].sort())
})

test('installation through a directory alias is idempotent before and after destination creation', async t => {
  const f = await fixture(t), alias = join(f.root, 'directory-alias')
  await symlink(f.root, alias)
  const install = async () => JSON.parse((await exec(helper, ['install-plugin',
    '--profile-dir', join(alias, 'profile'), '--source', join(alias, 'bundled plugin'),
    '--destination', join(alias, 'installed', 'dsh-macos-share'), '--json'])).stdout)
  assert.equal((await install()).changed, true)
  assert.equal((await install()).changed, false)
  const pkg = JSON.parse(await readFile(f.manifest, 'utf8'))
  assert.equal(await realpath(pkg.dependencies['dsh-macos-share'].slice('file:'.length)), await realpath(f.target))
  assert.equal((await readdir(f.profile)).filter(name => name.includes('dsh-share-backup-')).length, 1)
})

test('unsafe package paths are rejected before profile or destination changes', async t => {
  const f = await fixture(t)
  const pkg = JSON.parse(await readFile(join(f.source, 'package.json'), 'utf8'))
  pkg.files.push('../outside')
  await writeFile(join(f.source, 'package.json'), JSON.stringify(pkg))
  await assert.rejects(f.install(), /unsafe file name/)
  assert.equal(await exists(f.target), false)
  assert.equal(await readFile(f.manifest, 'utf8'), f.original)
})

test('an existing plugin directory is backed up and unrelated modules are retained', async t => {
  const f = await fixture(t)
  await mkdir(f.target, { recursive: true }); await writeFile(join(f.target, 'old.txt'), 'old plugin bytes')
  await mkdir(join(f.profile, 'node_modules', 'dsh-macos-share'), { recursive: true })
  await writeFile(join(f.profile, 'node_modules', 'dsh-macos-share', 'legacy.txt'), 'legacy module bytes')
  await mkdir(join(f.profile, 'node_modules', 'keep'))
  const result = await f.install()
  assert.equal(await readFile(join(result.pluginBackup, 'old.txt'), 'utf8'), 'old plugin bytes')
  assert.equal(await exists(join(f.profile, 'node_modules', 'keep')), true)
  const backups = await readdir(join(f.root, 'installed', 'backups'))
  const oldLink = backups.find(name => name.startsWith('profile-link-'))
  assert.equal(await readFile(join(f.root, 'installed', 'backups', oldLink, 'legacy.txt'), 'utf8'), 'legacy module bytes')
})

test('profile-write failure rolls back installed code and module links', { skip: process.getuid?.() === 0 }, async t => {
  const f = await fixture(t), oldLinkTarget = join(f.root, 'previous-plugin')
  await mkdir(f.target, { recursive: true }); await writeFile(join(f.target, 'old.txt'), 'old plugin bytes')
  await mkdir(oldLinkTarget); await mkdir(join(f.profile, 'node_modules'))
  await symlink(oldLinkTarget, join(f.profile, 'node_modules', 'dsh-macos-share'))
  await chmod(f.profile, 0o500)
  try {
    await assert.rejects(f.install())
    assert.equal(await readFile(f.manifest, 'utf8'), f.original)
    assert.equal(await readFile(join(f.target, 'old.txt'), 'utf8'), 'old plugin bytes')
    assert.equal(await readlink(join(f.profile, 'node_modules', 'dsh-macos-share')), oldLinkTarget)
  } finally { await chmod(f.profile, 0o700) }
})

test('native-helper discovery uses installation metadata before conventional app locations', async t => {
  const f = await fixture(t); await f.install()
  assert.equal(await realpath(resolveNativeHelper({ override: '', installationFile: join(f.target, '.installation.json'), candidates: [] })), await realpath(helper))
})

test('broken installation metadata fails closed rather than selecting another app', async t => {
  const f = await fixture(t), metadata = join(f.root, 'broken.json')
  await writeFile(metadata, JSON.stringify({ formatVersion: 1, helperPath: join(f.root, 'missing-helper') }))
  assert.throws(() => resolveNativeHelper({ override: '', installationFile: metadata, candidates: [helper] }), /needs repair/)
  await writeFile(metadata, 'x'.repeat(16 * 1024 + 1))
  assert.throws(() => resolveNativeHelper({ override: '', installationFile: metadata, candidates: [helper] }), /too large/)
})

test('helper discovery supports a conventional app path without installation metadata', async t => {
  const f = await fixture(t)
  assert.equal(resolveNativeHelper({ override: '', installationFile: join(f.root, 'missing.json'), candidates: [join(f.root, 'missing'), helper] }), helper)
})

test('a copied receiving plugin consumes using its recorded helper with no environment override', async t => {
  const f = await fixture(t); await f.install()
  const inbox = join(f.root, 'inbox'); await mkdir(join(inbox, 'one'), { recursive: true })
  await writeFile(join(inbox, 'one', 'manifest.json'), JSON.stringify({ version: 1, text: 'synthetic', items: [], urls: [] }))
  const env = { ...process.env }; delete env.DSH_SHARE_HELPER
  const child = fork(new URL('./fixtures/consumer.mjs', import.meta.url), [inbox, f.target], {
    env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout.resume(); child.stderr.resume()
  let done = false
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('installed plugin timed out')) }, 5000)
    child.once('error', reject)
    child.once('close', code => { clearTimeout(timeout); done ? resolve() : reject(new Error('consumer exited: ' + code)) })
    child.on('message', message => {
      if (message.event === 'ready') child.send({ id: 1, command: 'pending' })
      if (message.id === 1) {
        if (message.status === 200) child.send({ id: 2, command: 'prepare', shareId: message.body.shareId })
        else if (message.body?.status === 'unavailable') { child.kill('SIGKILL'); reject(new Error(message.body.message)) }
        else setTimeout(() => { if (child.connected) child.send({ id: 1, command: 'pending' }) }, 10)
      }
      if (message.id === 2) {
        if (message.status !== 200) { child.kill('SIGKILL'); reject(new Error('prepare failed')); return }
        child.send({ id: 3, command: 'ack' })
      }
      if (message.id === 3) { done = message.status === 200; child.send({ command: 'stop' }) }
    })
  })
  assert.equal(await exists(join(inbox, 'one')), false)
})
