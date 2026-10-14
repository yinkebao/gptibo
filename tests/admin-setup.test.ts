import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { randomBytes } from 'node:crypto'
import { base32, setupAdmin } from '../scripts/setup-admin.mjs'

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'gptibo-setup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = join(root, 'services/storefront')
  await mkdir(join(service, '.secrets'), { recursive: true })
  for (const name of ['auth-secret', 'owner-password', 'app-password']) await writeFile(join(service, '.secrets', name), randomBytes(32).toString('hex'))
  await writeFile(join(service, '.env'), 'PUBLIC_ORIGIN=http://127.0.0.1:8093\n')
  return { root, service }
}
const input = () => ({ username: 'local-admin', email: 'admin+$test@example.test', from: 'sender@example.test', apiKey: randomBytes(24).toString('hex') })

test('administrator setup preserves deployment settings, writes private enrollment and refuses replacement', async t => {
  const { root, service } = await fixture(t)
  const credentials = input()
  const before = await readFile(join(service, '.env'), 'utf8')
  const p = await setupAdmin(root, credentials)
  assert.equal(await readFile(join(service, '.env'), 'utf8'), before)
  assert.deepEqual({ ...parseEnv(await readFile(p.config, 'utf8')) }, {
    ADMIN_USERNAME: credentials.username, ADMIN_EMAIL: credentials.email, MAIL_FROM: credentials.from,
  })
  const secret = (await readFile(p.totp, 'utf8')).trim()
  assert.match(secret, /^[A-Z2-7]{32}$/)
  assert.equal((await readFile(p.resend, 'utf8')).trim(), credentials.apiKey)
  const html = await readFile(p.enrollment, 'utf8')
  assert.ok(html.includes(secret))
  assert.ok(html.includes('<svg'))
  assert.ok(!html.includes(credentials.apiKey))
  if (process.platform !== 'win32') {
    for (const path of [p.config, p.totp, p.resend, p.enrollment]) assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal((await stat(join(root, '.admin-auth'))).mode & 0o777, 0o700)
  }
  await assert.rejects(setupAdmin(root, input()), /不会覆盖/)
  assert.equal((await readFile(p.totp, 'utf8')).trim(), secret)
})

test('invalid administrator configuration cannot inject Compose settings or leave partial credentials', async t => {
  const { root, service } = await fixture(t)
  for (const value of [
    { ...input(), username: "admin'\nMAIL_ENABLED=false" },
    { ...input(), email: 'invalid' },
    { ...input(), from: "sender'@example.test" },
    { ...input(), apiKey: '' },
  ]) await assert.rejects(setupAdmin(root, value))
  assert.deepEqual((await readdir(join(service, '.secrets'))).sort(), ['app-password', 'auth-secret', 'owner-password'])
  await assert.rejects(readFile(join(service, '.env.admin')), { code: 'ENOENT' })
})

test('base32 enrollment uses standard encoding understood by TOTP applications', () => {
  assert.equal(base32(Buffer.from('12345678901234567890')), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
})
