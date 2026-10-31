import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../../plugin/dsh-share/client.js', import.meta.url), 'utf8')
export const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)) }

export async function clientHarness(t, options = {}) {
  const calls = [], shells = new Map(), registry = new Map()
  let current = options.current === undefined ? 'thread-one' : options.current
  let offered = [{ shareId: 'one', data: 'shared bytes', name: '原图 #?.png', type: 'image/png' }]
  let blockedAck = !!options.blockedAck, failAdmission = !!options.failAdmission
  let component, mountedCleanup, timer, dispose, client, fileGate
  const shell = id => {
    if (!shells.has(id)) {
      const state = { phase: 'idle', draft: 'keep my original text', attachmentIds: ['existing'] }
      const actions = {
        addAttachments(ids) { calls.push(['append', id, ...ids]); if (failAdmission) return false; state.attachmentIds.push(...ids); return true },
        removeAttachment(value) { state.attachmentIds = state.attachmentIds.filter(id => id !== value) },
        setDraft() { throw new Error('must never replace draft text') },
        submit() { calls.push(['FORBIDDEN submit']); throw new Error('must never submit') },
      }
      shells.set(id, { state: { getSnapshot: () => state }, actions, value: state })
    }
    return shells.get(id)
  }
  const conversation = {
    input: { for: id => shell(id) },
    createDrafts(id, files) {
      calls.push(['drafts', id, files])
      return files.map(file => { const draft = { id: 'new-' + registry.size, file }; registry.set(draft.id, draft); return draft })
    },
    releaseDraftAttachments(drafts) { for (const draft of drafts) registry.delete(draft.id) },
    send() { calls.push(['FORBIDDEN send']); throw new Error('must never send') },
  }
  const sessions = { list: { getSnapshot: () => ({ phase: 'ready', ids: [...shells.keys()], byId: {} }) }, scope: id => id, binding: id => shells.has(id) ? {} : undefined }
  const request = async (url, init = {}) => {
    const route = url.split('.').at(-1), body = init.body ? JSON.parse(init.body) : null
    calls.push([route, body])
    const offer = offered[0]
    if (route === 'pending') return offer ? Response.json({ protocol: options.oldProtocol ? 1 : 2, shareId: offer.shareId, targetSessionId: offer.target }) : new Response(null, { status: 204 })
    assert.equal(body.protocol, 2)
    if (route === 'ack') {
      if (blockedAck) return new Response(null, { status: 503 })
      offered = offered.filter(value => value.shareId !== body.shareId)
      return Response.json({ ok: true })
    }
    if (!offer || (offer.target && body.sessionId !== offer.target)) return new Response(null, { status: 409 })
    if (route === 'prepare') {
      offer.target = body.sessionId
      return Response.json({ protocol: 2, shareId: offer.shareId, sessionId: offer.target, requestId: 'request-' + offer.shareId,
        files: [{ index: 0, name: offer.name, type: offer.type, size: new TextEncoder().encode(offer.data).length }] })
    }
    if (route === 'file') {
      if (fileGate) await fileGate
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      if (options.failedFile) return new Response(null, { status: 500 })
      return new Response(offer.data)
    }
    throw new Error('unexpected route: ' + url)
  }
  const load = () => {
    vm.runInNewContext(options.source ?? source, {
      window: { __ModuleLoader__: { load({ factory }) { client = factory(name => { assert.equal(name, 'react'); return { useEffect(fn) { mountedCleanup = fn() } } }) } } },
      fetch: options.fetch ?? request, File, Blob, Response, AbortController, console,
      setInterval(fn) { timer = fn; return 1 }, clearInterval() {},
    })
    client.apply({
      get(name) { return { conversation, sessions, uiSession: { adapter: { current: { value: { key: current } } } } }[name] },
      slots: { inject(name, fn) { assert.equal(name, 'conversation.input.overlay'); fn() }, register(meta, value) { component = value } },
      effect(fn) { dispose = fn() },
    })
  }
  const mount = () => {
    mountedCleanup?.(); mountedCleanup = null
    if (current) component({ sessionId: current, inputActions: shell(current).actions, useSessions: select => select({ current }) })
  }
  load(); mount(); await flush()
  const stop = () => { mountedCleanup?.(); mountedCleanup = null; dispose?.() }
  t.after(stop)
  return { calls, shell, registry, conversation,
    async tick() { timer(); await flush() },
    async switchTo(id) { current = id; mount(); await flush() },
    async reload() { stop(); load(); mount(); await flush() },
    setAckBlocked(value) { blockedAck = value }, setAdmissionBlocked(value) { failAdmission = value },
    add(value) { offered.push({ data: 'another share', name: '分享内容.txt', type: 'text/plain', ...value }) },
    gateFiles(promise) { fileGate = promise },
    remaining: () => offered.length,
    stop,
  }
}
