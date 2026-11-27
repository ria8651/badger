// Builds Badger.app: the web app, the server with its production dependencies and Node, staged in
// app/resources, bundled by Tauri, then signed (see scripts/make-cert.sh).
//
//   --dmg       also make a disk image, in app/target/release/bundle/dmg
//   --release   fail rather than sign ad-hoc when the certificate's missing
//   --updater   also pack the app for the updater, Badger.app.tar.gz, signed with the update key (see below)
//
// Anything else goes to `tauri build`.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STAGE = 'app/resources'
const SERVER = join(STAGE, 'badger')
const BUNDLE = 'app/target/release/bundle'
const APP = join(BUNDLE, 'macos/Badger.app')
const IDENTITY = process.env.BADGER_SIGN_IDENTITY || 'Badger'
const NODE_CACHE = 'app/target/node'
const NODE_VERSION = `v${readFileSync('.node-version', 'utf8').trim()}`

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const run = (cmd, argv, cwd = '.') => execFileSync(cmd, argv, { cwd, stdio: 'inherit' })
const succeeds = (cmd, argv) => {
  try {
    execFileSync(cmd, argv, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** nodejs.org's Node of NODE_VERSION, for this Mac's arch: downloaded once, checked against its checksums. */
async function officialNode() {
  const name = `node-${NODE_VERSION}-darwin-${process.arch}`
  const bin = join(NODE_CACHE, name, 'bin/node')
  if (existsSync(bin)) return bin
  const base = `https://nodejs.org/dist/${NODE_VERSION}`
  console.log(`==> downloading ${name} from nodejs.org`)
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text()
  const expected = sums.split('\n').find((line) => line.endsWith(`  ${name}.tar.gz`))?.split(' ')[0]
  const res = await fetch(`${base}/${name}.tar.gz`)
  if (!res.ok || !expected) throw new Error(`No ${name}.tar.gz at ${base}`)
  const archive = Buffer.from(await res.arrayBuffer())
  if (createHash('sha256').update(archive).digest('hex') !== expected) throw new Error(`${name}.tar.gz doesn't match its checksum`)
  mkdirSync(NODE_CACHE, { recursive: true })
  const file = join(NODE_CACHE, `${name}.tar.gz`)
  writeFileSync(file, archive)
  run('tar', ['-xzf', file, '-C', NODE_CACHE])
  rmSync(file)
  return bin
}

run('pnpm', ['build'])

rmSync(STAGE, { recursive: true, force: true })
mkdirSync(SERVER, { recursive: true })
for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'server', 'shared', 'dist']) {
  cpSync(path, join(SERVER, path), { recursive: true })
}
// Hoisted, so the copy has real folders rather than pnpm's symlinks.
run('pnpm', ['install', '--prod', '--frozen-lockfile', '--config.node-linker=hoisted'], SERVER)
rmSync(join(SERVER, 'node_modules/.bin'), { recursive: true, force: true })

// The server runs on the Node .node-version pins, which CI runs too, so every build carries the same one, and on
// nodejs.org's build of it: one file, where some installs, like Homebrew's, load libnode and more from elsewhere.
copyFileSync(await officialNode(), join(STAGE, 'node'))
chmodSync(join(STAGE, 'node'), 0o755)

// Tauri copies the resources next to the binary too, and can't copy over a read-only file an earlier build left.
for (const name of ['badger', 'node']) rmSync(join('app/target/release', name), { recursive: true, force: true })

run('pnpm', ['exec', 'tauri', 'build', '--config', 'app/tauri.bundle.json', ...args.filter((a) => !['--dmg', '--release', '--updater'].includes(a))])

// Signed with the certificate, what you've allowed the app (like ~/Documents) carries over to the next build;
// signed ad-hoc, it's asked again every time. --deep signs the Node and Claude binaries inside it too.
if (succeeds('security', ['find-certificate', '-c', IDENTITY])) {
  console.log(`==> signing as "${IDENTITY}"`)
  run('codesign', ['--force', '--deep', '--timestamp=none', '--sign', IDENTITY, APP])
} else if (flag('--release')) {
  console.error(`No certificate named "${IDENTITY}" to sign with: see scripts/make-cert.sh.`)
  process.exit(1)
} else {
  console.warn(`==> signing ad-hoc, as there's no certificate named "${IDENTITY}" (scripts/make-cert.sh makes one)`)
  run('codesign', ['--force', '--deep', '--sign', '-', APP])
}
run('codesign', ['--verify', '--deep', '--strict', APP])

// What the app's updater downloads, packed after signing so it's the signed app. The update key that signs it is
// the TAURI_SIGNING_PRIVATE_KEY secret in CI, or ~/.tauri/badger-updater.key here; the app has its public half
// (tauri.conf.json) and won't install anything else.
if (flag('--updater')) {
  const archive = join(BUNDLE, 'macos/Badger.app.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', join(BUNDLE, 'macos'), 'Badger.app'], { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const key = process.env.TAURI_SIGNING_PRIVATE_KEY ? [] : ['-f', join(homedir(), '.tauri/badger-updater.key')]
  execFileSync('pnpm', ['exec', 'tauri', 'signer', 'sign', ...key, archive], {
    stdio: 'inherit',
    env: { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '', ...process.env },
  })
}

// Made here rather than by Tauri, whose disk image scripts the Finder to lay its window out.
if (flag('--dmg')) {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
  const contents = join(BUNDLE, 'dmg-contents')
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch
  const dmg = join(BUNDLE, `dmg/Badger_${version}_${arch}.dmg`)
  rmSync(contents, { recursive: true, force: true })
  mkdirSync(contents, { recursive: true })
  mkdirSync(join(BUNDLE, 'dmg'), { recursive: true })
  run('ditto', [APP, join(contents, 'Badger.app')])
  symlinkSync('/Applications', join(contents, 'Applications'))
  run('hdiutil', ['create', '-volname', 'Badger', '-srcfolder', contents, '-format', 'UDZO', '-ov', dmg])
  rmSync(contents, { recursive: true, force: true })
}
