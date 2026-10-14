import { randomBytes } from 'node:crypto'
import { readFile, lstat, open, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import QRCode from 'qrcode'
import { ensurePrivateDirectory, protectPrivatePath } from './private-files.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
export const startCommand = 'docker-compose --env-file .env --env-file .env.admin -f compose.yaml -f compose.auth.yaml up -d --wait api worker'
const help = `Go + PostgreSQL 管理员初始化（在项目根目录运行 npm run admin:setup）。
需要管理员用户名、邮箱、Resend 已验证的发件邮箱与 API 密钥。
密钥仅在本机隐藏输入；向导不会发送邮件，也不会自动启动服务。
配置写入 services/storefront/.env.admin 和 .secrets/，二维码写入 .admin-auth/go-setup.html。
已有管理员文件不会覆盖。完成后按提示重启 API 与 Worker。
Cloudflare Workers 请按 README 配置 .dev.vars；此向导仅适用于 Go 后端。`

export function base32(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0, value = 0, result = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) { bits -= 5; result += alphabet[(value >>> bits) & 31] }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31]
  return result
}

function paths(directory) {
  const service = join(directory, 'services/storefront')
  return {
    service,
    config: join(service, '.env.admin'),
    totp: join(service, '.secrets/admin-totp'),
    resend: join(service, '.secrets/resend-key'),
    enrollment: join(directory, '.admin-auth/go-setup.html'),
  }
}

async function checkNewFiles(p) {
  for (const key of ['config', 'totp', 'resend', 'enrollment']) {
    try { await lstat(p[key]) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    throw new Error(`已有配置 ${p[key]}，为保留现有身份，向导不会覆盖。请按后端 README 手动维护。`)
  }
  for (const name of ['auth-secret', 'owner-password', 'app-password']) {
    const value = (await readFile(join(p.service, '.secrets', name), 'utf8')).trim()
    if (!value) throw new Error('请先按后端 README 初始化基础秘密文件。')
  }
  await readFile(join(p.service, '.env'), 'utf8')
}

export async function setupAdmin(directory, input) {
  const username = input.username.trim()
  const email = input.email.trim().toLowerCase()
  const from = input.from.trim().toLowerCase()
  const apiKey = input.apiKey.trim()
  if (!/^[\p{L}\p{N}_.@-]{1,80}$/u.test(username)) throw new Error('用户名请使用 1–80 个字母、数字、中文或 _.@-。')
  const emailPattern = /^[a-z0-9.!#$%&*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i
  if (email.length > 254 || from.length > 254 || !emailPattern.test(email) || !emailPattern.test(from)) throw new Error('管理员邮箱和发件邮箱必须是有效的纯邮箱地址。')
  if (!apiKey || /\s/.test(apiKey)) throw new Error('Resend API 密钥不能为空或含空白字符。')
  const p = paths(directory)
  await checkNewFiles(p)
  const secret = base32(randomBytes(20))
  const uri = 'otpauth://totp/' + encodeURIComponent('GPTibo:' + username) + '?secret=' + secret + '&issuer=GPTibo&algorithm=SHA1&digits=6&period=30'
  const svg = await QRCode.toString(uri, { type: 'svg', margin: 4 })
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>GPTibo 管理员验证器</title><style>body{font:16px system-ui;max-width:560px;margin:40px auto;padding:20px}svg{width:300px}code{overflow-wrap:anywhere}</style><h1>绑定管理员验证器</h1><p>使用验证器扫描二维码。此页面包含登录秘密，请勿分享。</p>${svg}<p>手动输入密钥：<code>${secret}</code></p><p>类型：TOTP，SHA1，6 位，30 秒。登录还需要邮件验证码。</p></html>`
  await ensurePrivateDirectory(join(p.service, '.secrets'))
  await ensurePrivateDirectory(join(directory, '.admin-auth'))
  const created = []
  try {
    for (const [path, value] of [
      [p.totp, secret + '\n'], [p.resend, apiKey + '\n'], [p.enrollment, html],
      // Single quotes prevent Compose interpolation of dollar signs in email addresses.
      [p.config, `# Generated locally; never commit.\nADMIN_USERNAME='${username}'\nADMIN_EMAIL='${email}'\nMAIL_FROM='${from}'\n`],
    ]) {
      const file = await open(path, 'wx', 0o600)
      created.push(path)
      try { await protectPrivatePath(path); await file.writeFile(value) } finally { await file.close() }
    }
  } catch (error) {
    for (const path of created) await unlink(path).catch(() => {})
    throw error
  }
  return p
}

async function main() {
  if (process.argv.includes('--help')) { console.log(help); return }
  if (process.argv.length > 2) throw new Error('不支持此参数；使用 npm run admin:setup -- --help 查看说明。')
  console.log(help)
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('请在交互终端运行向导，勿通过命令参数或管道传入密钥。')
  await checkNewFiles(paths(root))
  let muted = false
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback() } })
  const rl = createInterface({ input: process.stdin, output, terminal: true })
  const controller = new AbortController()
  rl.on('SIGINT', () => controller.abort())
  const ask = text => rl.question(text, { signal: controller.signal })
  try {
    const username = await ask('管理员用户名：')
    const email = await ask('管理员邮箱：')
    const from = await ask('Resend 已验证的发件邮箱（纯邮箱地址）：')
    process.stdout.write('Resend API 密钥（输入不显示）：')
    muted = true
    const apiKey = await ask('')
    muted = false
    process.stdout.write('\n')
    const p = await setupAdmin(root, { username, email, from, apiKey })
    console.log(`配置已保存。请在本机浏览器打开以下文件并绑定验证器：\n${p.enrollment}\n\n然后执行：\ncd services/storefront\n${startCommand}\n\n返回 /admin 点击“已配置，重新检查”。`)
  } finally { muted = false; rl.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.code === 'ENOENT' ? '请先按 services/storefront/README.md 完成基础部署，生成 .env 和 .secrets/。' : error.message); process.exitCode = 1 })
}
