import { spawn } from 'node:child_process'
import { resolveNativeHelper } from './native-helper.js'

// The installed app supplies a native executable for the kernel flock operation.
// A pipe holds the lease; parent death closes it, and the kernel releases the lock.
export function acquireInboxLock(inbox, { signal, waitMs = 2000, onLost = () => {} } = {}) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const helper = resolveNativeHelper()
    const child = spawn(helper, [
      'hold', '--inbox', inbox, '--wait-ms', String(waitMs),
      '--parent-pid', String(process.pid),
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    let ready = false
    let expectedExit = false
    let output = ''
    let diagnostic = ''
    let releasePromise
    let close
    const closed = new Promise(resolve => { close = resolve })
    const fail = (message, code = 'LOCK_UNAVAILABLE') => {
      const error = new Error(message)
      error.code = code
      reject(error)
    }
    const cancelStartup = () => {
      if (ready) return
      expectedExit = true
      child.kill('SIGTERM')
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      expectedExit = true
      child.kill('SIGTERM')
      fail('native inbox helper did not start; reinstall DSHShare.app or check DSH_SHARE_HELPER')
    }, waitMs + 5000)
    const release = () => {
      if (releasePromise) return releasePromise
      expectedExit = true
      child.stdin.end()
      const timeout = setTimeout(() => child.kill('SIGTERM'), 1000)
      releasePromise = closed.finally(() => clearTimeout(timeout))
      return releasePromise
    }
    child.stdin.on('error', () => {}) // EPIPE is handled by the child close event.
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4096) })
    child.stdout.on('data', chunk => {
      output += chunk
      if (output.length > 8192) {
        child.kill('SIGTERM')
        fail('invalid inbox lock helper response')
        return
      }
      if (!ready && output.includes('\n')) {
        try {
          const response = JSON.parse(output.split('\n')[0])
          if (response.status !== 'locked') return
          if (signal?.aborted) { cancelStartup(); return }
          ready = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', cancelStartup)
          resolve({ release, pid: child.pid })
        } catch {
          child.kill('SIGTERM')
          fail('invalid inbox lock helper response')
        }
      }
    })
    child.once('error', error => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancelStartup)
      fail(`cannot start native inbox helper: ${error.message}; reinstall DSHShare.app or set DSH_SHARE_HELPER`)
      close()
    })
    child.once('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancelStartup)
      close()
      if (ready) {
        if (!expectedExit) onLost(new Error('inbox lock helper exited; consumption stopped to preserve queued content'))
      } else if (!expectedExit) {
        fail(code === 75
          ? 'inbox is already in use; disable dsh-macos-share in the other profile before reloading this plugin'
          : `inbox lock unavailable: ${diagnostic.trim() || output.trim() || `exit ${code}`}`,
        code === 75 ? 'INBOX_BUSY' : 'LOCK_UNAVAILABLE')
      }
    })
    signal?.addEventListener('abort', cancelStartup, { once: true })
    if (signal?.aborted) cancelStartup()
  })
}
