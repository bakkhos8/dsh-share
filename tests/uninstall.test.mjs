import './native-helper.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, readdir, copyFile, chmod, symlink, readlink, rename, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exists } from './helpers.mjs'
const exec = promisify(execFile), helper = process.env.DSH_SHARE_HELPER
const sourceRoot = fileURLToPath(new URL('../plugin/dsh-share/', import.meta.url))
async function fixture(t, decoration = '') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-share-uninstall-test-' + decoration))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profiles = join(root, 'profiles'), profile = join(profiles, 'desktop')
  const source = join(root, 'source'), target = join(root, 'managed', 'dsh-share'), inbox = join(root, 'data', 'inbox')
  await mkdir(profile, { recursive: true }); await mkdir(source); await mkdir(inbox, { recursive: true })
  const original = { name: 'synthetic', dependencies: { keep: 'unchanged' },
    dsh: { profile: { bundles: ['existing'], keep: 'setting' } }, unrelated: ['#?', 42] }
  const bytes = JSON.stringify(original) + '\n'
  await writeFile(join(profile, 'package.json'), bytes)
  const pkg = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
  for (const name of [...pkg.files, 'package.json']) await copyFile(join(sourceRoot, name), join(source, name))
  const install = async (selected = profile) => JSON.parse((await exec(helper, [
    'install-plugin', '--profile-dir', selected, '--source', source, '--destination', target, '--json',
  ])).stdout)
  const uninstall = async (args = []) => JSON.parse((await exec(helper, [
    'uninstall-plugin', '--profiles-root', profiles, '--destination', target, '--inbox', inbox, '--json', ...args,
  ])).stdout)
  return { root, profiles, profile, source, target, inbox, bytes, original, install, uninstall }
}
test('uninstall removes this receiver and preserves unfinished shares and unrelated configuration', async t => {
  const f = await fixture(t); await f.install()
  await mkdir(join(f.profile, 'node_modules', 'other')); await writeFile(join(f.profile, 'node_modules', 'other', 'keep'), 'other module')
  const retained = ['pending/item', 'failed/item', '.tmp-share/item', '.receipts/receipt']
  for (const name of retained) {
    await mkdir(join(f.inbox, name, '..'), { recursive: true })
    await writeFile(join(f.inbox, name), 'retained bytes: ' + name)
  }
  const session = join(f.root, 'Harness sessions'); await mkdir(session); await writeFile(join(session, 'session'), 'chat and attachments')
  const result = await f.uninstall()
  assert.equal(result.status, 'uninstalled'); assert.equal(result.changed, true)
  assert.equal(await exists(f.target), false)
  assert.equal(await exists(join(f.profile, 'node_modules', 'dsh-share')), false)
  assert.deepEqual(JSON.parse(await readFile(join(f.profile, 'package.json'), 'utf8')), f.original)
  assert.equal(await readFile(join(f.profile, 'node_modules', 'other', 'keep'), 'utf8'), 'other module')
  for (const name of retained) assert.equal(await readFile(join(f.inbox, name), 'utf8'), 'retained bytes: ' + name)
  assert.equal(await readFile(join(session, 'session'), 'utf8'), 'chat and attachments')
  assert.equal(JSON.parse(await readFile(join(result.pluginBackup, 'package.json'), 'utf8')).name, 'dsh-share')
  assert.equal(result.configurationBackups.length, 1)
})

test('uninstall clears only proven completed payloads and history, without an age limit', async t => {
  const f = await fixture(t); await f.install()
  const receipts = join(f.inbox, '.receipts'); await mkdir(receipts)
  const state = { version: 1, sessionId: 'forwarded', requestId: 'forwarded', accepted: true }
  for (const id of ['completed', 'unconfirmed', 'pending']) {
    const dir = join(f.inbox, id); await mkdir(dir)
    await writeFile(join(dir, '0.bin'), id + ' bytes')
    if (id !== 'pending') await writeFile(join(dir, '.delivery.json'), JSON.stringify(state))
  }
  for (const id of ['completed', 'orphan']) await writeFile(join(receipts, id + '.json'), JSON.stringify({
    ...state, shareId: id, acknowledgedAt: Date.now() + 86400000,
  }))
  const result = await f.uninstall()
  assert.equal(result.completedTransfersRemoved, 2)
  assert.equal(await exists(receipts), false)
  assert.equal(await exists(join(f.inbox, 'completed')), false)
  for (const id of ['unconfirmed', 'pending']) {
    assert.equal(await readFile(join(f.inbox, id, '0.bin'), 'utf8'), id + ' bytes')
  }
})

test('failed completed-data cleanup blocks uninstall before active configuration is changed',
  { skip: process.getuid?.() === 0 }, async t => {
    const f = await fixture(t); await f.install()
    const before = await readFile(join(f.profile, 'package.json'))
    const state = { version: 1, sessionId: 'forwarded', requestId: 'forwarded', accepted: true }
    const dir = join(f.inbox, 'completed'), receipts = join(f.inbox, '.receipts')
    await mkdir(dir); await mkdir(receipts)
    await writeFile(join(dir, '.delivery.json'), JSON.stringify(state))
    await writeFile(join(dir, '0.bin'), 'forwarded bytes')
    const blocked = join(dir, 'z-blocked'); await mkdir(blocked)
    await writeFile(join(blocked, 'payload'), 'forwarded bytes')
    await writeFile(join(receipts, 'completed.json'), JSON.stringify({ ...state, shareId: 'completed', acknowledgedAt: 1 }))
    await chmod(blocked, 0o500)
    try {
      await assert.rejects(f.uninstall(), /cleanup could not finish/)
      assert.deepEqual(await readFile(join(f.profile, 'package.json')), before)
      assert.equal(await exists(f.target), true)
      assert.equal(await exists(join(dir, '.delivery.json')), true)
    } finally { await chmod(blocked, 0o700) }
    assert.equal((await f.uninstall()).status, 'uninstalled')
    assert.equal(await exists(dir), false)
    assert.equal(await exists(receipts), false)
  })
test('repeated uninstall is idempotent and adds no profile backup', async t => {
  const f = await fixture(t); await f.install(); await f.uninstall()
  const before = (await readdir(f.profile)).filter(name => name.includes('backup')).sort()
  assert.equal((await f.uninstall()).changed, false)
  assert.deepEqual((await readdir(f.profile)).filter(name => name.includes('backup')).sort(), before)
})
test('uninstall discovers standard profiles and recorded custom profiles outside the default root', async t => {
  const f = await fixture(t), second = join(f.profiles, 'another'), custom = join(f.root, 'custom environment')
  for (const dir of [second, custom]) { await mkdir(dir); await writeFile(join(dir, 'package.json'), f.bytes) }
  for (const dir of [f.profile, second, custom]) await f.install(dir)
  assert.equal((await f.install(custom)).changed, false)
  assert.equal(JSON.parse(await readFile(join(f.target, '.installation.json'), 'utf8')).profileDirectories.length, 3)
  assert.equal((await f.uninstall()).profiles.length, 3)
  for (const dir of [f.profile, second, custom]) {
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')), f.original)
    assert.equal(await exists(join(dir, 'node_modules', 'dsh-share')), false)
  }
})
test('uninstall supports earlier installation records without custom-profile tracking', async t => {
  const f = await fixture(t); await f.install()
  const record = JSON.parse(await readFile(join(f.target, '.installation.json'), 'utf8')); delete record.profileDirectories
  delete record.applicationIdentifier
  await writeFile(join(f.target, '.installation.json'), JSON.stringify(record))
  assert.equal((await f.uninstall()).changed, true)
  assert.deepEqual(JSON.parse(await readFile(join(f.profile, 'package.json'), 'utf8')), f.original)
})
test('development links are removed without moving or deleting source code', async t => {
  const f = await fixture(t), originalCode = await readFile(join(f.source, 'index.js'))
  await mkdir(join(f.profile, 'node_modules')); await symlink(f.source, join(f.profile, 'node_modules', 'dsh-share'))
  const configured = structuredClone(f.original); configured.dependencies['dsh-share'] = 'file:' + f.source
  configured.dsh.profile.bundles.push('dsh-share')
  await writeFile(join(f.profile, 'package.json'), JSON.stringify(configured))
  await f.uninstall()
  assert.equal(await exists(join(f.profile, 'node_modules', 'dsh-share')), false)
  assert.deepEqual(await readFile(join(f.source, 'index.js')), originalCode)
  assert.deepEqual(JSON.parse(await readFile(join(f.profile, 'package.json'), 'utf8')), f.original)
})
test('malformed owned configuration blocks uninstall before any active profile or code changes', async t => {
  const f = await fixture(t), second = join(f.profiles, 'broken')
  await mkdir(second); await writeFile(join(second, 'package.json'), f.bytes)
  await f.install(); await f.install(second)
  const before = await readFile(join(f.profile, 'package.json'))
  await writeFile(join(second, 'package.json'), '{invalid')
  await assert.rejects(f.uninstall())
  assert.deepEqual(await readFile(join(f.profile, 'package.json')), before)
  assert.equal(await exists(f.target), true)
  assert.equal(await exists(join(f.profile, 'node_modules', 'dsh-share')), true)
  assert.equal(await readFile(join(second, 'package.json'), 'utf8'), '{invalid')
})
test('unrelated and malformed unrelated profiles are left byte-for-byte unchanged', async t => {
  const f = await fixture(t), other = join(f.profiles, 'unrelated'), broken = join(f.profiles, 'unrelated-broken')
  await f.install()
  for (const dir of [other, broken]) await mkdir(dir)
  await writeFile(join(other, 'package.json'), f.bytes); await writeFile(join(broken, 'package.json'), '{unrelated invalid')
  await f.uninstall()
  assert.equal(await readFile(join(other, 'package.json'), 'utf8'), f.bytes)
  assert.equal(await readFile(join(broken, 'package.json'), 'utf8'), '{unrelated invalid')
  assert.deepEqual(await readdir(other), ['package.json'])
})
test('a failed code archive rolls back updated manifests and module links', { skip: process.getuid?.() === 0 }, async t => {
  const f = await fixture(t); await f.install()
  const before = await readFile(join(f.profile, 'package.json')), originalLink = await readlink(join(f.profile, 'node_modules', 'dsh-share'))
  const backups = join(f.root, 'managed', 'backups'); await mkdir(backups); await chmod(backups, 0o500)
  try {
    await assert.rejects(f.uninstall())
    assert.deepEqual(await readFile(join(f.profile, 'package.json')), before)
    assert.equal(await readlink(join(f.profile, 'node_modules', 'dsh-share')), originalLink)
    assert.equal(await exists(f.target), true)
    assert.equal((await readdir(f.profile)).filter(name => name.includes('backup')).length, 2)
  } finally { await chmod(backups, 0o700) }
})
test('symlinked node_modules is refused without touching its external contents', async t => {
  const f = await fixture(t); await f.install()
  const before = await readFile(join(f.profile, 'package.json')), modules = join(f.profile, 'node_modules')
  const external = join(f.root, 'external-modules'); await rename(modules, external); await symlink(external, modules)
  await assert.rejects(f.uninstall(), /real directory/)
  assert.deepEqual(await readFile(join(f.profile, 'package.json')), before)
  assert.equal(await exists(join(external, 'dsh-share')), true); assert.equal(await exists(f.target), true)
})
test('symlinked or unrelated plugin destinations are preserved', async t => {
  const f = await fixture(t); await mkdir(join(f.root, 'managed')); await symlink(f.source, f.target)
  await assert.rejects(f.uninstall(), /real directory/)
  assert.equal(await realpath(f.target), await realpath(f.source))
  await rm(f.target); await mkdir(f.target); await writeFile(join(f.target, 'package.json'), '{"name":"other-product"}')
  await writeFile(join(f.target, 'user-data'), 'keep')
  await assert.rejects(f.uninstall(), /does not identify/)
  assert.equal(await readFile(join(f.target, 'user-data'), 'utf8'), 'keep')
})
test('an active receiving process blocks uninstall and keeps configuration and shared bytes', async t => {
  const f = await fixture(t); await f.install()
  const before = await readFile(join(f.profile, 'package.json')); await writeFile(join(f.inbox, 'pending'), 'undelivered')
  const child = spawn(helper, ['hold', '--inbox', f.inbox, '--parent-pid', String(process.pid)], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume()
  const closed = new Promise(resolve => child.once('close', resolve))
  t.after(async () => { child.stdin.end(); await closed })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lock helper timed out')), 3000)
    child.once('error', reject)
    child.stdout.once('data', data => { clearTimeout(timer); assert.equal(JSON.parse(data.toString()).status, 'locked'); resolve() })
  })
  await assert.rejects(f.uninstall(), error => error.code === 75)
  assert.deepEqual(await readFile(join(f.profile, 'package.json')), before)
  assert.equal(await readFile(join(f.inbox, 'pending'), 'utf8'), 'undelivered'); assert.equal(await exists(f.target), true)
})
test('invalid installation records cannot redirect uninstall to unrelated configuration', async t => {
  const f = await fixture(t); await f.install()
  const before = await readFile(join(f.profile, 'package.json')), marker = join(f.target, '.installation.json')
  const record = JSON.parse(await readFile(marker, 'utf8'))
  for (const [extra, reason] of [
    [{ profileDirectories: ['../escape'] }, /invalid recorded/],
    [{ applicationIdentifier: 'com.example.unrelated' }, /another application/],
  ]) {
    await writeFile(marker, JSON.stringify({ ...record, ...extra }))
    await assert.rejects(f.uninstall(), reason)
    assert.deepEqual(await readFile(join(f.profile, 'package.json')), before)
    assert.equal(await exists(f.target), true)
  }
})
test('reinstall repairs invalid helper metadata and retained data survives an uninstall/reinstall cycle', async t => {
  const f = await fixture(t); await f.install()
  await writeFile(join(f.target, '.installation.json'), '{invalid')
  assert.equal((await f.install()).changed, true); assert.equal((await f.install()).changed, false)
  await writeFile(join(f.inbox, 'undelivered'), 'retained original')
  await f.uninstall(); await f.install()
  assert.equal(await readFile(join(f.inbox, 'undelivered'), 'utf8'), 'retained original')
  assert.deepEqual(JSON.parse(await readFile(join(f.profile, 'package.json'), 'utf8')).dsh.profile.bundles, ['existing', 'dsh-share'])
})
test('native App removal uses Trash and the disposable fixture can be restored', async t => {
  const f = await fixture(t), app = join(f.root, 'DSH Share uninstall fixture.app')
  await mkdir(app); await writeFile(join(app, 'test-marker'), 'DSH_SHARE_UNINSTALL_TEST')
  assert.equal(JSON.parse((await exec(process.env.DSH_SETUP_PROBE, [app])).stdout).trashedAndRestored, true)
  assert.equal(await readFile(join(app, 'test-marker'), 'utf8'), 'DSH_SHARE_UNINSTALL_TEST')
})

test('uninstall safely handles spaces, Unicode and literal shell or URL characters in paths', async t => {
  const f = await fixture(t, " #?'\" $(literal) 中文-")
  await f.install(); await writeFile(join(f.inbox, 'keep #?.txt'), 'original data')
  await f.uninstall()
  assert.deepEqual(JSON.parse(await readFile(join(f.profile, 'package.json'), 'utf8')), f.original)
  assert.equal(await readFile(join(f.inbox, 'keep #?.txt'), 'utf8'), 'original data')
  assert.equal(await exists(f.target), false)
})

test('valid ownership records allow uninstalling corrupted installed code while preserving a backup', async t => {
  const f = await fixture(t); await f.install()
  await writeFile(join(f.target, 'package.json'), '{damaged installed package')
  const result = await f.uninstall()
  assert.equal(await exists(f.target), false)
  assert.equal(await readFile(join(result.pluginBackup, 'package.json'), 'utf8'), '{damaged installed package')
  assert.deepEqual(JSON.parse(await readFile(join(f.profile, 'package.json'), 'utf8')), f.original)
})
