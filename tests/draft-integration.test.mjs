import test from 'node:test'
import assert from 'node:assert/strict'
import { exists, host, until } from './helpers.mjs'
import { clientHarness } from './fixtures/browser.mjs'

function transport(receiver, intercept) {
  return async (url, init = {}) => {
    const request = new Request('http://localhost' + url, init)
    if (intercept) { const response = await intercept(request); if (response) return response }
    const route = receiver.routes.get(new URL(request.url).pathname)
    assert.ok(route, 'only dedicated draft routes are available')
    return route.fetch(request)
  }
}

test('real host stream reaches current composer as files and text, then source is deleted', async t => {
  const receiver = await host(t, { manifest: { version: 1, text: '原文保留 #?', urls: ['https://example.com/a#b?c=d'],
    items: [{ kind: 'file', name: '报告 #?.txt', file: '0.bin' }] } })
  receiver.start()
  await until(async () => (await receiver.pending()).status === 200)
  const browser = await clientHarness(t, { fetch: transport(receiver) })
  await until(async () => !(await exists(receiver.dir)) && !(await exists(receiver.inbox + '/.receipts')))
  const files = [...browser.registry.values()].map(draft => draft.file)
  assert.deepEqual(files.map(file => file.name), ['报告 #?.txt', '分享内容.txt'])
  assert.equal(await files[0].text(), 'original attachment bytes')
  assert.equal(await files[1].text(), '原文保留 #?\n\nhttps://example.com/a#b?c=d')
  assert.equal(browser.shell('thread-one').value.draft, 'keep my original text')
  assert.equal(browser.shell('thread-one').value.attachmentIds.length, 3)
  assert.equal(await exists(receiver.inbox + '/.receipts'), false)
  assert.deepEqual(receiver.calls, [], 'host never creates a session, uploads or prompts')
})

test('real receiver restart and browser plugin reload retry ACK without duplicate attachments', async t => {
  const receiver = await host(t)
  receiver.start()
  await until(async () => (await receiver.pending()).status === 200)
  let block = true
  const browser = await clientHarness(t, { fetch: transport(receiver, request => {
    if (block && request.url.endsWith('.ack')) return new Response(null, { status: 503 })
  }) })
  await until(() => browser.registry.size === 2)
  await browser.tick()
  assert.equal(await exists(receiver.dir), true)
  await receiver.stop(); receiver.start()
  await until(async () => (await receiver.pending()).status === 200)
  await browser.reload(); await browser.tick()
  assert.equal(browser.calls.filter(call => call[0] === 'append').length, 1)
  block = false; await browser.tick()
  await until(async () => !(await exists(receiver.dir)))
  assert.equal(browser.registry.size, 2)
  assert.deepEqual(receiver.calls, [])
})
