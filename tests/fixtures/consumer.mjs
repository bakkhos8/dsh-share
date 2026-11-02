// A real Node consumer process with synthetic DSH services and no model/network access.
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
const { apply } = await import(process.argv[3]
  ? pathToFileURL(join(process.argv[3], 'index.js')).href
  : new URL('../../plugins/dsh-macos-share/index.js', import.meta.url).href)

const inbox = process.argv[2]
const routes = new Map()
const disposers = []
const send = message => { if (process.connected) process.send(message) }
const forbidden = name => () => { send({ event: name }); throw new Error(`forbidden automatic ${name}`) }
apply({
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
  connection: { fetch: { register(route) { routes.set(route.path, route); return () => {} } } },
  sessionController: { create: forbidden('create'), resolveAgent: forbidden('resolveAgent'), prompt: forbidden('prompt') },
  fileUploads: { upload: forbidden('upload'), uploadStream: forbidden('uploadStream') },
  uiWorkspace: { openSession: forbidden('openSession') },
}, { inbox })

let stopping = false
let prepared
async function stop(id) {
  if (stopping) return
  stopping = true
  await Promise.all(disposers.splice(0).map(fn => fn()))
  if (process.connected) process.send({ id, stopped: true }, () => process.exit(0))
  else process.exit(0)
}
process.on('message', async message => {
  if (message.command === 'stop') { await stop(message.id); return }
  try {
    if (message.command === 'pending') {
      const request = new Request('http://localhost/api/dsh-share.draft.pending', {
        headers: message.sessionId ? { 'x-dsh-share-session': message.sessionId } : {},
      })
      const result = await routes.get('/api/dsh-share.draft.pending').fetch(request)
      send({ id: message.id, status: result.status, body: result.status === 204 ? null : await result.json() })
    }
    if (['prepare', 'ack'].includes(message.command)) {
      const body = message.body ?? (message.command === 'prepare'
        ? { protocol: 2, shareId: 'one', sessionId: 'shared-session' }
        : prepared ?? { protocol: 2, shareId: 'one', sessionId: 'shared-session', requestId: 'not-prepared' })
      const result = await routes.get(`/api/dsh-share.draft.${message.command}`).fetch(new Request(`http://localhost/api/dsh-share.draft.${message.command}`, {
        method: 'POST', body: JSON.stringify(body),
      }))
      const response = result.status === 204 ? null : await result.json()
      if (message.command === 'prepare' && result.ok) prepared = response
      send({ id: message.id, status: result.status, body: response })
    }
  } catch (error) { send({ id: message.id, status: 500, body: { error: String(error.message) } }) }
})
process.once('SIGTERM', () => { void stop() })
send({ event: 'ready' })
