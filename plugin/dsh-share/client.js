/** Stage a share in the current composer's attachment rail; sending belongs to the user. */
window.__ModuleLoader__.load({
  id: 'dsh-share',
  factory: (require) => {
    const React = require('react')
    const BASE = '/api/dsh-share.draft.'
    const PROTOCOL = 2
    const LIMIT = 256 * 1024 * 1024
    const PENDING_DRAFTS = Symbol.for('dsh-share.unacknowledged-drafts.v2')

    function apply(ctx) {
      const conversation = ctx.get('conversation')
      const sessions = ctx.get('sessions')
      // Survives a plugin hot reload, but disappears immediately after ACK.
      // This is pending transaction state, never forwarding history.
      const staged = conversation[PENDING_DRAFTS] ??= new Map()
      let active = null
      let disposed = false
      let inFlight = false
      let transfer = null

      // The catalog is not the selected view. Use the same main binding source
      // that Harness's session-scope UI adapter uses, including main-view retention.
      const currentId = () => ctx.get('uiSession')?.adapter?.current?.value?.key
      const isCurrent = binding => !disposed && active === binding && currentId() === binding.sessionId
      const post = (route, body, signal) => fetch(BASE + route, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocol: PROTOCOL, ...body }), signal, cache: 'no-store',
      })
      const acknowledge = async (key, proof) => {
        try {
          const response = await post('ack', proof)
          if (response.ok) staged.delete(key)
        } catch { /* Retry only the ACK; the composer already owns the files. */ }
      }
      const scopeFor = binding => {
        if (!isCurrent(binding) || sessions.binding(binding.sessionId) === undefined) return null
        const input = conversation.input?.for(sessions.scope(binding.sessionId))
        return input?.actions === binding.actions && !input.disposed ? input : null
      }

      const poll = async () => {
        if (disposed || inFlight) return
        inFlight = true
        try {
          for (const [key, proof] of staged) {
            if (disposed) return
            await acknowledge(key, proof)
          }
          const binding = active
          if (!binding || !scopeFor(binding)) return
          const response = await fetch(BASE + 'pending', {
            cache: 'no-store', headers: { accept: 'application/json', 'x-dsh-share-session': binding.sessionId },
          })
          if (!response.ok || response.status === 204 || !isCurrent(binding)) return
          const offer = await response.json()
          if (offer.protocol !== PROTOCOL || typeof offer.shareId !== 'string'
              || (offer.targetSessionId && offer.targetSessionId !== binding.sessionId)) return
          const controller = new AbortController()
          transfer = controller
          const prepared = await post('prepare', { shareId: offer.shareId, sessionId: binding.sessionId }, controller.signal)
          if (!prepared.ok || !isCurrent(binding)) return
          const item = await prepared.json()
          if (item.protocol !== PROTOCOL || item.shareId !== offer.shareId || item.sessionId !== binding.sessionId
              || typeof item.requestId !== 'string' || !item.requestId || !Array.isArray(item.files)
              || !item.files.length || item.files.length > 129) return
          const proof = { shareId: item.shareId, sessionId: item.sessionId, requestId: item.requestId }
          const key = JSON.stringify([item.shareId, item.requestId])
          if (staged.has(key)) { await acknowledge(key, proof); return }
          let total = 0
          for (const file of item.files) {
            if (!Number.isSafeInteger(file.index) || file.index < 0 || !Number.isSafeInteger(file.size)
                || file.size < 0 || typeof file.name !== 'string' || !file.name
                || /[\x00-\x1f\x7f/\\]/.test(file.name) || typeof file.type !== 'string') return
            total += file.size
            if (total > LIMIT) return
          }
          const files = []
          for (const file of item.files) {
            if (!scopeFor(binding)) return
            const result = await post('file', { ...proof, index: file.index }, controller.signal)
            if (!result.ok) return
            const blob = await result.blob()
            if (blob.size !== file.size || !isCurrent(binding)) return
            files.push(new File([blob], file.name, { type: file.type }))
          }
          const input = scopeFor(binding)
          if (!input || ['adjudicating', 'submitting'].includes(input.state.getSnapshot().phase)) return
          // Synchronous append only: no navigation, replacement, prompt or submit.
          const drafts = conversation.createDrafts(binding.sessionId, files)
          const ids = drafts.map(draft => draft.id)
          let admitted = false
          try {
            const accepted = binding.actions.addAttachments(ids) === true
            const present = input.state.getSnapshot().attachmentIds ?? []
            admitted = accepted && ids.every(id => present.includes(id))
            if (!admitted) return
            staged.set(key, proof)
          } finally {
            if (!admitted) {
              for (const id of ids) binding.actions.removeAttachment(id)
              conversation.releaseDraftAttachments(drafts)
            }
          }
          await acknowledge(key, proof)
        } catch {
          // Offline, busy or incompatible SDK: keep the package for another try.
          // Never fall back to sending a message.
        } finally {
          transfer = null
          inFlight = false
        }
      }

      function Receiver(props) {
        const selected = props.useSessions(() => currentId())
        React.useEffect(() => {
          if (!props.sessionId || selected !== props.sessionId || !props.inputActions) return
          const binding = { sessionId: props.sessionId, actions: props.inputActions }
          active = binding
          void poll()
          return () => {
            if (active === binding) {
              active = null
              transfer?.abort()
            }
          }
        }, [props.sessionId, props.inputActions, selected])
        return null
      }
      ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay', id: 'dsh-share-draft-receiver', order: 100,
      }, Receiver))
      ctx.effect(() => {
        const timer = setInterval(() => { void poll() }, 1000)
        return () => {
          disposed = true
          active = null
          transfer?.abort()
          clearInterval(timer)
        }
      }, 'dsh-share: current composer drafts')
    }

    return { apply, inject: ['sessions', 'uiSession', 'conversation', 'slots'] }
  },
})
