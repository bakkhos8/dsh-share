import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const probe = process.env.DSH_ENABLEMENT_PROBE
async function activation(primary, fallback) {
  return JSON.parse((await exec(probe, ['activation', '--primary', primary, '--fallback', fallback])).stdout)
}

test('launch waits for the URL callback and completes once after confirmed success', async () => {
  const result = await activation('success', 'failure')
  assert.deepEqual(result.beforeReply, ['open-url'])
  assert.deepEqual(result.events, ['open-url', 'complete'])
})

test('failed URL activation waits for fallback launch instead of reporting early success', async () => {
  const result = await activation('failure', 'success')
  assert.deepEqual(result.afterPrimary, ['open-url', 'open-app'])
  assert.deepEqual(result.events, ['open-url', 'open-app', 'complete'])
})

test('launch failure cancels with a visible localized explanation that content remains queued', async () => {
  const result = await activation('failure', 'failure')
  assert.deepEqual(result.events, ['open-url', 'open-app', 'cancel'])
  assert.equal(result.message, '无法打开 DeepSeek Harness。分享内容已暂存，请手动打开应用后继续，无需重复分享。')
})
