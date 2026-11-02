import './native-helper.mjs'
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../plugins/dsh-macos-share/index.js'

export const exists = async path => { try { await access(path); return true } catch { return false } }
export async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('diagnostic timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

export async function host(t, { manifest, state } = {}) {
  const inbox = await mkdtemp(join(tmpdir(), 'dsh-share-test-'))
  const dir = join(inbox, 'test-share')
  await mkdir(dir)
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest ?? {
    version: 1, text: 'regression test', urls: [], items: [{ kind: 'file', name: 'test.txt', file: '0.bin' }],
  }))
  await writeFile(join(dir, '0.bin'), 'original attachment bytes')
  if (state) await writeFile(join(dir, '.delivery.json'), JSON.stringify(state))
  const routes = new Map(), calls = [], disposers = []
  const forbidden = kind => () => { calls.push({ kind }); throw new Error(`forbidden automatic ${kind}`) }
  const ctx = {
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => {} } } },
    sessionController: {
      create: forbidden('create'), resolveAgent: forbidden('resolveAgent'), prompt: forbidden('prompt'),
    },
    fileUploads: { upload: forbidden('upload'), uploadStream: forbidden('uploadStream') },
    uiWorkspace: { openSession: forbidden('openSession') },
  }
  const stop = async () => { await Promise.all(disposers.splice(0).map(fn => fn())) }
  const start = () => apply(ctx, { inbox, cwd: inbox })
  const pending = sessionId => routes.get('/api/dsh-share.draft.pending').fetch(new Request('http://localhost/api/dsh-share.draft.pending', {
    headers: sessionId ? { 'x-dsh-share-session': sessionId } : {},
  }))
  const request = (kind, body) => routes.get(`/api/dsh-share.draft.${kind}`).fetch(new Request(`http://localhost/api/dsh-share.draft.${kind}`, {
    method: 'POST', body: JSON.stringify(body),
  }))
  let prepared
  const prepare = async (sessionId = 'test-session', shareId = 'test-share') => {
    const response = await request('prepare', { protocol: 2, shareId, sessionId })
    if (response.ok) prepared = await response.clone().json()
    return response
  }
  const ack = (identity = prepared) => request('ack', identity)
  const file = (index = 0, identity = prepared) => request('file', { ...identity, index })
  t.after(async () => { await stop(); await rm(inbox, { recursive: true, force: true }) })
  return { inbox, dir, calls, routes, start, stop, pending, prepare, file, ack, request }
}
