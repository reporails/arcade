import type { CommandRunInput, HttpInit, ImageSource, On, RenderSurface, SessionStartInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import {
  BUTTONS,
  KEY,
  STICK,
  blankCells,
  cellsLength,
  doomKeyOf,
  engineCandidates,
  freshKeys,
  listeningOf,
  GAME_KEYS_MS,
  promptKeyRoute,
  parseArgs,
  placementOf,
  platformOf,
  screenSize,
  stickOf,
  stickText,
} from '../hooks/lib'
import type { Pad, Platform } from '../hooks/lib'

const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }

function doom(args: string): CommandRunInput {
  return { command: 'doom', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }
}

// A stick as the strip posts it, resting unless told otherwise.
function pad(fields: Partial<Pad>): Pad {
  return { dx: 0, dy: 0, isHeld: false, isFiring: false, isStrafing: false, ...fields }
}

function last<T>(items: readonly T[]): T {
  const item = items.at(-1)
  if (item === undefined) throw new Error('nothing there yet')
  return item
}

function first<T>(items: readonly T[]): T {
  const item = items[0]
  if (item === undefined) throw new Error('nothing there yet')
  return item
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const PANE = {
  plugin: 'doom',
  component: 'Pane',
  requestId: 'doom',
  viewport: { columns: 180, rows: 60 },
  props: { title: 'Doom', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 56 }, view: {} },
} as const

// A frame of the size asked for: every cell a red upper half over blue, so
// a blit can be told from the blank screen.
function frameOf(url: string) {
  const query = new URL(url).searchParams
  const cells = Number(query.get('c')) * Number(query.get('r'))
  const words = new Uint32Array(cells * 3)
  for (let i = 0; i < cells; i++) words.set([0x2580, 0xff0000, 0x0000ff], i * 3)
  return base64(new Uint8Array(words.buffer))
}

// Answer everything the mod asks Claude Code for. `calls` collects the
// commands run, the engines spawned (each with `end()`, which ends its
// stream), the URLs fetched with their init, the cells blitted and the log
// written; `clock` moves the frame pull's timer. The engine prints the line
// that says it listens, then runs until /quit or `end()`.
type Spawn = { argv: string[]; env: Record<string, string>; end: () => void }
type Blit = { cells: string | undefined; columns: number | undefined; source: ImageSource | undefined }

function world(
  on: On,
  {
    surfaces = ['terminal'],
    isEngineUp = () => true,
    term = 'xterm-256color',
    drawsImages = true,
    os,
    arch,
    uname = 'Linux x86_64\n',
    exists = () => true,
    transport,
    listens = true,
  }: {
    surfaces?: RenderSurface[]
    isEngineUp?: () => boolean
    term?: string
    drawsImages?: boolean
    os?: string
    arch?: string
    uname?: string
    exists?: (path: string) => boolean
    transport?: string
    listens?: boolean
  } = {},
) {
  const calls = {
    runs: [] as string[][],
    spawns: [] as Spawn[],
    urls: [] as string[],
    inits: [] as (HttpInit | undefined)[],
    blits: [] as Blit[],
    opens: [] as (number | undefined)[],
    logs: [] as string[],
  }
  const env: Record<string, string | undefined> = {
    XDG_RUNTIME_DIR: '/run/user/1000',
    TERM: term,
    OS: os,
    PROCESSOR_ARCHITECTURE: arch,
    DOOM_CLAUDE_TRANSPORT: transport,
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('ui.open', (_$, e) => {
    calls.opens.push(e.columns)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('fs.exists', (_$, e) => ({ value: exists(e.path) }))
  on('fs.write', (_$, e) => {
    calls.logs.push(e.text)
    return { value: undefined }
  })
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('process.run', (_$, e) => {
    calls.runs.push([...e.argv])
    const ran = { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (e.argv[0] === 'uname') return { value: { ...ran, stdout: uname } }
    return { value: { ...ran, stdout: '' } }
  })
  on('process.spawn', async function* (_$, e) {
    let end = (): void => {}
    const ended = new Promise<void>((resolve) => (end = resolve))
    calls.spawns.push({ argv: [...e.argv], env: { ...(e.env ?? {}) }, end })
    if (!listens) {
      yield { stream: 'stderr' as const, text: "IWAD file 'freedoom1.wad' not found!\n" }
      return { value: { code: 255, signal: null } }
    }
    yield { stream: 'stdout' as const, text: 'Z_Init: Init zone memory allocation daemon.\n' }
    yield { stream: 'stdout' as const, text: e.argv.includes('--port') ? 'doom-claude listening port=4242\n' : 'doom-claude listening\n' }
    await ended
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', (_$, e) => {
    calls.urls.push(e.url)
    calls.inits.push(e.init)
    if (!isEngineUp()) return { deny: 'connect ECONNREFUSED' }
    const path = new URL(e.url).pathname
    if (path === '/frame') return { value: { status: 200, ok: true, headers: { 'x-frame': '7' }, text: frameOf(e.url) } }
    if (path === '/image') {
      const since = Number(new URL(e.url).searchParams.get('since'))
      return { value: { status: 200, ok: true, headers: { 'x-frame': String(since < 0 ? 7 : since + 1) }, text: '' } }
    }
    if (path === '/quit') calls.spawns.at(-1)?.end()
    return { value: { status: 204, ok: true, headers: {}, text: '' } }
  })
  on('ui.blit', (_$, e) => {
    const source = 'source' in e ? e.source : undefined
    calls.blits.push({ cells: 'cells' in e ? e.cells : undefined, columns: 'columns' in e ? e.columns : undefined, source })
    if (source !== undefined && !drawsImages) return { value: { deny: 'the Image draws its alt here' } }
    return { value: {} }
  })
  return { ...calls, clock: mock.clock(on) }
}

// The stick each /stick request carried.
function sticksOf(urls: readonly string[]): { t: string | null; f: string | null; b: string | null }[] {
  return urls
    .filter((url) => url.startsWith('http://doom/stick'))
    .map((url) => {
      const query = new URL(url).searchParams
      return { t: query.get('t'), f: query.get('f'), b: query.get('b') }
    })
}

test('a terminal key is the Doom key it stands for', async () => {
  expect(doomKeyOf({ key: 'up' })).toBe(KEY.up)
  expect(doomKeyOf({ key: 'W' })).toBe(KEY.up)
  expect(doomKeyOf({ key: 'a' })).toBe(KEY.left)
  expect(doomKeyOf({ key: ',' })).toBe(KEY.strafeLeft)
  // Space fires, e uses; f is nothing
  expect(doomKeyOf({ key: ' ' })).toBe(KEY.fire)
  expect(doomKeyOf({ key: 'space' })).toBe(KEY.fire)
  expect(doomKeyOf({ key: 'e' })).toBe(KEY.use)
  expect(doomKeyOf({ key: 'f' })).toBe(null)
  expect(doomKeyOf({ key: 'return' })).toBe(KEY.enter)
  // Return answers yes (the engine's confirm key), and y sends Return
  expect(doomKeyOf({ key: 'y' })).toBe(KEY.enter)
  expect(doomKeyOf({ key: 'n' })).toBe('n'.charCodeAt(0))
  expect(doomKeyOf({ key: 'm' })).toBe(KEY.escape)
  expect(doomKeyOf({ key: 'backspace' })).toBe(KEY.escape)
  expect(doomKeyOf({ key: '3' })).toBe('3'.charCodeAt(0))
  expect(doomKeyOf({ key: 'z' })).toBe(null)
  expect(doomKeyOf({ key: 'w', ctrl: true })).toBe(null)
})

test('the buttons: ok takes the focus ring, so Return works before a click; no fire or yes button', async () => {
  expect(BUTTONS.filter((b) => b.autoFocus).map((b) => b.label)).toEqual(['ok'])
  expect(BUTTONS.find((b) => b.label === 'ok')?.code).toBe(KEY.enter)
  expect(BUTTONS.some((b) => b.code === KEY.fire || b.hotkey === 'f' || b.hotkey === 'y')).toBe(false)
  // A hotkey is one lowercase letter or digit
  expect(BUTTONS.every((b) => /^[a-z0-9]$/.test(b.hotkey))).toBe(true)
})

test('the screen keeps 4:3 inside the pane body and the Raster bounds', async () => {
  expect(screenSize(120, 60)).toEqual({ columns: 120, rows: 45 })
  // Short body: the height decides and the width follows it
  expect(screenSize(200, 33)).toEqual({ columns: 80, rows: 30 })
  expect(screenSize(2000, 1000)).toEqual({ columns: 512, rows: 192 })
  expect(screenSize(4, 4).columns).toBe(16)
  expect(blankCells(3, 2).length).toBe(cellsLength({ columns: 3, rows: 2 }))
  expect(cellsLength({ columns: 120, rows: 45 })).toBe(86400)
})

test('a post that replaced an undelivered one loses no key, and none plays twice', async () => {
  const first = freshKeys({ type: 'keys', keys: [{ n: 1, code: 1 }, { n: 2, code: 2 }] }, 0)
  expect(first).toEqual({ seen: 2, codes: [1, 2] })
  const next = freshKeys({ type: 'keys', keys: [{ n: 1, code: 1 }, { n: 2, code: 2 }, { n: 3, code: 3 }, { n: 4, code: 4 }] }, first.seen)
  expect(next).toEqual({ seen: 4, codes: [3, 4] })
  expect(freshKeys('keys', 4)).toEqual({ seen: 4, codes: [] })
})

test('the stick turns as fast as the a and d keys however far it goes, never walks, and fires on its own', async () => {
  expect(stickOf(null)).toEqual({ turn: 0, forward: 0, buttons: 0 })
  expect(stickOf(pad({ dx: 0.2, dy: -0.2, isHeld: true }))).toEqual({ turn: 0, forward: 0, buttons: 0 })
  // 80 is Doom's mouse turning as fast as the arrow keys
  expect(STICK.turn).toBe(80)
  expect(stickOf(pad({ dx: 1, isHeld: true })).turn).toBe(STICK.turn)
  expect(stickOf(pad({ dx: 12, isHeld: true })).turn).toBe(STICK.turn)
  expect(stickOf(pad({ dx: -30, isHeld: true })).turn).toBe(-STICK.turn)
  // Up and down do nothing: walking is the keys' job
  expect(stickOf(pad({ dy: -3, isHeld: true }))).toEqual({ turn: 0, forward: 0, buttons: 0 })
  expect(stickOf(pad({ dx: 12, dy: 5, isHeld: true }))).toEqual({ turn: STICK.turn, forward: 0, buttons: 0 })
  expect(stickText(pad({ dy: -3, isHeld: true }))).toBe('◉ held: drag sideways to turn')
  expect(stickOf(pad({ dx: 5, isHeld: true, isStrafing: true })).buttons).toBe(STICK.strafe)
  // Let go, it moves nothing; the fire button holds alone
  expect(stickOf(pad({ dx: 5, dy: -3, isFiring: true }))).toEqual({ turn: 0, forward: 0, buttons: STICK.fire })
})

test('arguments, the platform, the engine to run and where it listens', async () => {
  expect(parseArgs('')).toEqual({ action: 'play' })
  expect(parseArgs('q')).toEqual({ action: 'quit' })
  const bad = parseArgs('nightmare')
  expect('error' in bad ? bad.error : '').toContain('"nightmare"')

  expect(platformOf({ uname: 'Linux x86_64\n' })).toEqual({ os: 'linux', arch: 'x86_64' })
  expect(platformOf({ uname: 'Linux aarch64' })).toEqual({ os: 'linux', arch: 'arm64' })
  expect(platformOf({ uname: 'Darwin arm64' })).toEqual({ os: 'macos', arch: 'arm64' })
  expect(platformOf({ os: 'Windows_NT', processorArch: 'AMD64' })).toEqual({ os: 'windows', arch: 'x86_64' })
  // A 32-bit host on 64-bit Windows: the machine's own architecture
  expect(platformOf({ os: 'Windows_NT', processorArch: 'x86', processorArch6432: 'ARM64' })).toEqual({ os: 'windows', arch: 'arm64' })
  expect(platformOf({ uname: 'FreeBSD amd64' })).toEqual({ os: null, arch: 'x86_64' })

  expect(engineCandidates('/m', { os: 'macos', arch: 'arm64' })).toEqual(['/m/engine/bin/macos-arm64/doom-claude', '/m/engine/doom-claude'])
  expect(engineCandidates('C:/m', { os: 'windows', arch: 'x86_64' })).toEqual(['C:/m/engine/bin/windows-x86_64/doom-claude.exe', 'C:/m/engine/doom-claude.exe'])
  expect(engineCandidates('/m', { os: null, arch: 'x86_64' })).toEqual(['/m/engine/doom-claude'])

  const linux: Platform = { os: 'linux', arch: 'x86_64' }
  expect(placementOf({ platform: linux, runtimeDir: '/run/user/1000', tmpDir: undefined, dataDir: '/m/data', id: 'abc' })).toEqual({
    transport: 'unix',
    socketPath: '/run/user/1000/claude-doom-abc.sock',
    imagePath: '/run/user/1000/claude-doom-abc.rgb',
  })
  // macOS: no runtime directory; the temporary one, its trailing slash dropped
  expect(placementOf({ platform: { os: 'macos', arch: 'arm64' }, tmpDir: '/var/folders/x/T/', dataDir: '/m/data', id: 'abc' }).socketPath).toBe('/var/folders/x/T/claude-doom-abc.sock')
  // A path too long for a socket anywhere: 127.0.0.1
  const long = '/' + 'd'.repeat(100)
  expect(placementOf({ platform: linux, runtimeDir: long, dataDir: long, id: 'abc' }).transport).toBe('tcp')
  expect(placementOf({ platform: { os: 'windows', arch: 'x86_64' }, tmpDir: 'C:\\Temp', dataDir: 'C:/m/data', id: 'abc' })).toEqual({
    transport: 'tcp',
    socketPath: null,
    imagePath: 'C:/m/data/claude-doom-abc.rgb',
  })
  expect(placementOf({ platform: linux, runtimeDir: '/run/user/1000', dataDir: '/m/data', id: 'abc', prefer: 'tcp' }).transport).toBe('tcp')

  expect(listeningOf('Z_Init\ndoom-claude listening\n')).toEqual({ port: null })
  expect(listeningOf('doom-claude listening port=50931\r\nmore')).toEqual({ port: 50931 })
  expect(listeningOf('doom-claude listen')).toBe(null)
})

test('/doom spawns the engine for this machine and paints its frames', async ($, on) => {
  const calls = world(on)
  await $.session.start(SESSION)
  expect(await $.command.run(doom(''))).toEqual({})
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await calls.clock.advance(100)

  expect(calls.spawns.length).toBe(1)
  const start = first(calls.spawns).argv
  expect(first(start).endsWith('/engine/bin/linux-x86_64/doom-claude')).toBe(true)
  expect(start.includes('-iwad')).toBe(true)
  expect(start.includes('--daemon')).toBe(false)
  const socket = start[start.indexOf('--socket') + 1] ?? ''
  expect(socket.startsWith('/run/user/1000/claude-doom-')).toBe(true)
  expect(first(calls.spawns).env['DOOM_CLAUDE_TOKEN']).toBeUndefined()
  // No build: the prebuilt engine is there
  expect(calls.runs.some((argv) => argv[0] === 'make')).toBe(false)
  expect(calls.inits.at(-1)).toEqual({ socketPath: socket })
  expect(calls.urls.some((url) => url === 'http://doom/frame?c=120&r=45&since=-1')).toBe(true)
  expect(calls.blits.some((b) => b.cells === frameOf('http://doom/frame?c=120&r=45') && b.columns === 120)).toBe(true)
  // The next pull asks only for a frame newer than the one painted
  expect(calls.urls.some((url) => url.endsWith('since=7'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /hold the left button on the game and drag sideways to turn/, in: 'pad' })).toBeDefined()
})

test('the strip and the buttons hand their keys to the engine', async ($, on) => {
  const calls = world(on)
  await $.session.start(SESSION)
  await $.command.run(doom(''))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // A click gives the strip the keyboard
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'pad' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'pad' })
  await ui.key({ key: 'up', in: 'pad' })
  await ui.key({ key: ' ', in: 'pad' })
  await calls.clock.advance(50)
  const keyUrls = calls.urls.filter((url) => url.startsWith('http://doom/key'))
  const sent = keyUrls.flatMap((url) => url.slice('http://doom/key?k='.length).split(',').map(Number))
  expect(sent).toEqual([KEY.up, KEY.fire])
  expect(await ui.find({ type: 'Text', text: /drag sideways on the game with the left button to turn/, in: 'pad' })).toBeDefined()

  await ui.press({ key: 'key-m' })
  expect(calls.urls.at(-1) === `http://doom/key?k=${KEY.escape}` || calls.urls.includes(`http://doom/key?k=${KEY.escape}`)).toBe(true)
})

test('a drag on the game turns and never walks, letting go stops, the right button fires', async ($, on) => {
  const calls = world(on)
  await $.session.start(SESSION)
  await $.command.run(doom(''))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await calls.clock.advance(50)
  const sticks = () => sticksOf(calls.urls)

  // The pointer's layer lies over the screen
  await ui.pointer({ type: 'down', x: 20, y: 10, button: 'left', in: 'look' })
  await ui.pointer({ type: 'move', x: 26, y: 8, button: 'left', in: 'look' })
  await calls.clock.advance(50)
  const held = last(sticks())
  // Up and right: it turns right and does not walk
  expect(Number(held.t) > 0 && held.f === '0' && held.b === '0').toBe(true)
  expect(await ui.find({ type: 'Text', text: /◉ turn right$/, in: 'pad' })).toBeDefined()

  await ui.pointer({ type: 'up', x: 26, y: 8, button: 'left', in: 'look' })
  await calls.clock.advance(50)
  expect(sticks().at(-1)).toEqual({ t: '0', f: '0', b: '0' })

  await ui.pointer({ type: 'down', x: 3, y: 4, button: 'right', in: 'look' })
  await calls.clock.advance(50)
  expect(sticks().at(-1)).toEqual({ t: '0', f: '0', b: '1' })
  await ui.pointer({ type: 'up', x: 3, y: 4, button: 'right', in: 'look' })
  await calls.clock.advance(50)
  expect(sticks().at(-1)).toEqual({ t: '0', f: '0', b: '0' })
  // The strip still takes a drag too
  await ui.pointer({ type: 'down', x: 20, y: 0, button: 'left', in: 'pad' })
  await ui.pointer({ type: 'move', x: 14, y: 2, button: 'left', in: 'pad' })
  await calls.clock.advance(50)
  const left = last(sticks())
  expect(Number(left.t) < 0 && left.f === '0').toBe(true)
})

test('a drag held still on the game is said again, so the engine keeps turning', async ($, on) => {
  const calls = world(on)
  await $.session.start(SESSION)
  await $.command.run(doom(''))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await calls.clock.advance(50)
  await ui.pointer({ type: 'down', x: 20, y: 10, button: 'left', in: 'look' })
  await ui.pointer({ type: 'move', x: 26, y: 10, button: 'left', in: 'look' })
  await calls.clock.advance(50)
  const before = sticksOf(calls.urls).length
  // The pointer stays still for longer than the engine waits (1.5 s). The kit
  // delivers one post per advance, so it steps as a session's frames do.
  for (let ms = 0; ms < 2000; ms += 300) await ui.advance(300)
  await calls.clock.advance(50)
  const after = sticksOf(calls.urls)
  expect(after.length - before >= 5).toBe(true)
  expect(last(after).t).toBe('80')
})

test('when the engine goes away the pane says so, and /doom quit ends it', async ($, on) => {
  let isUp = true
  const calls = world(on, { isEngineUp: () => isUp })
  await $.session.start(SESSION)
  await $.command.run(doom(''))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await calls.clock.advance(60)
  // Keys played on the first engine
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'pad' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'pad' })
  await ui.key({ key: 'm', in: 'pad' })
  await ui.key({ key: 'return', in: 'pad' })
  await calls.clock.advance(60)

  // The engine's process ends: its stream ends, the pane says so, and its
  // output is kept in data/engine.log
  isUp = false
  first(calls.spawns).end()
  await calls.clock.advance(60)
  expect(await ui.find({ type: 'Text', text: /Doom has quit/, in: 'pad' })).toBeDefined()
  expect(calls.logs.at(-1)).toContain('doom-claude listening')
  expect(calls.logs.at(-1)).toContain('[doom-claude ended: exit code 0]')

  // A fresh /doom starts it again, with the pane still open: the keys the
  // strip took for the old engine are not played again to the new one
  isUp = true
  await $.command.run(doom(''))
  await calls.clock.settle()
  expect(calls.spawns.length).toBe(2)
  const keysBefore = calls.urls.length
  await ui.key({ key: 'e', in: 'pad' })
  await calls.clock.advance(60)
  const sentAfter = calls.urls.slice(keysBefore).filter((url) => url.startsWith('http://doom/key'))
  expect(sentAfter).toEqual([`http://doom/key?k=${KEY.use}`])
  expect(await $.command.run(doom('quit'))).toEqual({ text: 'Doom has quit.' })
  expect(calls.urls.at(-1)).toBe('http://doom/quit')
})

test('an engine that cannot start says why', async ($, on) => {
  const calls = world(on, { listens: false })
  await $.session.start(SESSION)
  await $.command.run(doom(''))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await calls.clock.advance(60)
  expect(await ui.find({ type: 'Text', text: /Doom did not start: IWAD file 'freedoom1.wad' not found!/, in: 'pad' })).toBeDefined()
  expect(calls.urls.length).toBe(0)
})

test('on Windows the engine listens on 127.0.0.1 and every request carries its token', async ($, on) => {
  const calls = world(on, { os: 'Windows_NT', arch: 'AMD64' })
  await $.session.start(SESSION)
  await $.command.run(doom(''))
  await $.ui.mount({ ...PANE, surface: 'terminal' })
  await calls.clock.advance(100)

  const start = first(calls.spawns).argv
  expect(first(start).endsWith('/engine/bin/windows-x86_64/doom-claude.exe')).toBe(true)
  expect(start.slice(1, 3)).toEqual(['--port', '0'])
  expect(start.includes('--socket')).toBe(false)
  // No uname on Windows, and no chmod
  expect(calls.runs.length).toBe(0)
  const token = first(calls.spawns).env['DOOM_CLAUDE_TOKEN'] ?? ''
  expect(/^[0-9a-f]{64}$/.test(token)).toBe(true)
  expect(calls.urls.some((url) => url === 'http://127.0.0.1:4242/frame?c=120&r=45&since=-1')).toBe(true)
  expect(calls.inits.every((init) => init?.headers?.['x-doom-token'] === token && init.socketPath === undefined)).toBe(true)
  await $.command.run(doom('quit'))
  expect(calls.urls.at(-1)).toBe('http://127.0.0.1:4242/quit')
})

test('a machine with no prebuilt engine builds one', async ($, on) => {
  const calls = world(on, { uname: 'Linux riscv64', exists: (path) => !path.includes('/engine/') })
  await $.session.start(SESSION)
  await $.command.run(doom(''))
  await calls.clock.settle()
  expect(calls.runs.some((argv) => argv[0] === 'make')).toBe(true)
  expect(first(first(calls.spawns).argv).endsWith('/engine/doom-claude')).toBe(true)
})

test('Windows on a machine with no prebuilt engine says so', async ($, on) => {
  const calls = world(on, { os: 'Windows_NT', arch: 'x86', exists: () => false })
  await $.session.start(SESSION)
  await $.command.run(doom(''))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await calls.clock.settle()
  expect(calls.spawns.length).toBe(0)
  expect(await ui.find({ type: 'Text', text: /No engine for this machine/, in: 'pad' })).toBeDefined()
})

test('a dock wider than the screen its height allows is asked to narrow, once', async ($, on) => {
  const calls = world(on)
  await $.session.start(SESSION)
  await $.command.run(doom(''))
  // A 126 by 38 terminal: the dock's body is 102 wide but only 35 rows tall
  await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 102, scroll: { offset: 0, bodyRows: 35 } } })
  await calls.clock.advance(100)
  expect(screenSize(102, 35)).toEqual({ columns: 85, rows: 32 })
  expect(calls.opens.filter((columns) => columns === 85).length).toBe(1)
  expect(calls.urls.some((url) => url.startsWith('http://doom/frame?c=85&r=32'))).toBe(true)
  // Asking for the keyboard again keeps the fitted width
  await calls.clock.advance(300)
  expect(calls.opens.at(-1)).toBe(85)
})

test('in kitty the screen is an Image the terminal reads from the engine\'s file', async ($, on) => {
  const calls = world(on, { term: 'xterm-kitty' })
  await $.session.start(SESSION)
  await $.command.run(doom(''))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await calls.clock.advance(200)

  const start = first(calls.spawns).argv
  const file = start[start.indexOf('--image') + 1]
  expect(file).toBe((start[start.indexOf('--socket') + 1] ?? '').replace(/\.sock$/, '.rgb'))
  expect(calls.urls.some((url) => url.startsWith('http://doom/frame'))).toBe(false)
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  // Each later frame swaps the Image to the next generation of the same file
  const swaps = calls.blits.flatMap((b) => (b.source === undefined ? [] : [b.source]))
  expect(swaps.length > 0).toBe(true)
  const newest = last(swaps)
  const generation = 'generation' in newest ? (newest.generation ?? 0) : 0
  expect(newest).toEqual({ file, format: 'rgb', width: 320, height: 200, generation })
  expect(generation > 7).toBe(true)
})

test('a terminal that refuses the Image swap after swap gets the cells', async ($, on) => {
  const calls = world(on, { term: 'xterm-kitty', drawsImages: false })
  await $.session.start(SESSION)
  await $.command.run(doom(''))
  await $.ui.mount({ ...PANE, surface: 'terminal' })
  await calls.clock.advance(1000)
  expect(calls.blits.filter((b) => b.source).length >= 10).toBe(true)
  expect(calls.urls.some((url) => url.startsWith('http://doom/frame'))).toBe(true)
  expect(calls.blits.some((b) => b.cells)).toBe(true)
})

test('while Doom is played the prompt is Doom\'s; a / gives it back; a rest or the person\'s own text keeps it theirs', async () => {
  const base = { isRunning: true, text: '', isOurs: false, msSinceGame: 50, typed: 'w', hasModifier: false }
  expect(promptKeyRoute(base)).toBe('game')
  // Any key while playing, game key or not (an r by mistake)
  expect(promptKeyRoute({ ...base, typed: 'r' })).toBe('game')
  // What slipped into the prompt during play is still Doom's
  expect(promptKeyRoute({ ...base, text: 'rwwd', isOurs: true })).toBe('game')
  // A / gives it back
  expect(promptKeyRoute({ ...base, typed: '/' })).toBe('release')
  expect(promptKeyRoute({ ...base, text: 'ww', isOurs: true, typed: '/' })).toBe('release')
  // The person's own draft, a rest of GAME_KEYS_MS, ctrl, no Doom: theirs
  expect(promptKeyRoute({ ...base, text: 'hello' })).toBe('pass')
  expect(promptKeyRoute({ ...base, msSinceGame: GAME_KEYS_MS })).toBe('pass')
  expect(promptKeyRoute({ ...base, hasModifier: true })).toBe('pass')
  expect(promptKeyRoute({ ...base, isRunning: false })).toBe('pass')
})

test('/doom says where it cannot draw', async ($, on) => {
  world(on, { surfaces: ['vscode'] })
  await $.session.start(SESSION)
  expect(await $.command.run(doom(''))).toEqual({ text: 'Doom draws its screen in the terminal only.' })
})
