// Pure functions for the doom mod: which Doom key a terminal key is, how big
// the screen is drawn, the engine's URLs and arguments. Nothing here takes $,
// so the tests import it directly.

import type { ClientKeyEvent, HttpInit, ImageSource } from 'claude-code'

export type Size = { columns: number; rows: number }
export type Transport = 'unix' | 'tcp'
export type Connection = { base: string; init: HttpInit }
export type Platform = { os: 'windows' | 'linux' | 'macos' | null; arch: 'x86_64' | 'arm64' | null }
export type Placement = { transport: 'unix'; socketPath: string; imagePath: string } | { transport: 'tcp'; socketPath: null; imagePath: string }
export type Route = 'pass' | 'release' | 'game'
// The strip's stick as the surface module posts it, and the engine's.
export type Pad = { dx: number; dy: number; isHeld: boolean; isFiring: boolean; isStrafing: boolean }
export type Stick = { turn: number; forward: number; buttons: number }
export type Button = { label: string; hotkey: string; code: number; autoFocus?: true }
export type Args = { action: 'play' } | { action: 'quit' } | { error: string }

// Doom's own key codes (engine/doomgeneric/doomkeys.h).
export const KEY = {
  right: 0xae,
  left: 0xac,
  up: 0xad,
  down: 0xaf,
  strafeLeft: 0xa0,
  strafeRight: 0xa1,
  use: 0xa2,
  fire: 0xa3,
  escape: 27,
  enter: 13,
  tab: 9,
  backspace: 0x7f,
  pause: 0xff,
}

// The keys the screen takes once a click on the game (or the strip under it)
// has given it the keyboard. Escape never reaches it (it hands the keyboard
// back), so the menu is `m` or backspace. Space fires and `e` uses. Return
// picks in a menu and answers yes to Doom's questions (the engine makes Enter
// its confirm key), and `y` sends Return too.
const KEYS: Readonly<Record<string, number>> = {
  up: KEY.up,
  down: KEY.down,
  left: KEY.left,
  right: KEY.right,
  w: KEY.up,
  s: KEY.down,
  a: KEY.left,
  d: KEY.right,
  ',': KEY.strafeLeft,
  '.': KEY.strafeRight,
  ' ': KEY.fire,
  space: KEY.fire,
  e: KEY.use,
  return: KEY.enter,
  enter: KEY.enter,
  y: KEY.enter,
  o: KEY.enter,
  m: KEY.escape,
  tab: KEY.tab,
  p: KEY.pause,
  n: 'n'.charCodeAt(0),
}

// The Doom key a terminal key stands for, or null for one it does not take.
// A digit picks a weapon; backspace opens the menu as Escape would, and in a
// menu goes back, as Doom's own backspace does.
export function doomKeyOf(e: ClientKeyEvent | null | undefined): number | null {
  if (!e || typeof e.key !== 'string' || e.ctrl || e.meta) return null
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (key === 'backspace') return KEY.escape
  if (/^[1-7]$/.test(key)) return key.charCodeAt(0)
  return Object.hasOwn(KEYS, key) ? (KEYS[key] ?? null) : null
}

// The buttons the hooks module draws under the screen. A pane's hotkeys reach
// only buttons the hooks module draws, and work before any click; a hotkey is
// one letter or digit, so space and Return cannot be one. Return presses the
// button the pane's focus ring is on, so `ok` takes the ring (autoFocus):
// Return picks and answers yes before any click too.
export const BUTTONS: readonly Button[] = [
  { label: 'menu', hotkey: 'm', code: KEY.escape },
  { label: 'ok', hotkey: 'o', code: KEY.enter, autoFocus: true },
  { label: '↑', hotkey: 'w', code: KEY.up },
  { label: '←', hotkey: 'a', code: KEY.left },
  { label: '↓', hotkey: 's', code: KEY.down },
  { label: '→', hotkey: 'd', code: KEY.right },
  { label: 'use', hotkey: 'e', code: KEY.use },
]

// Rows the pane spends on things other than the screen: the strip, its
// status line and the buttons.
export const CHROME_ROWS = 3

const MIN_COLUMNS = 16
const MAX_COLUMNS = 512
const MAX_ROWS = 256

// The screen's size in cells for a pane body of `bodyColumns` by `bodyRows`.
// A terminal cell is about twice as tall as it is wide, and Doom's 320×200
// was shown at 4:3: the screen is 3/8 as many rows as columns. An Image is at
// most 255 cells either way, a Raster 512 by 256.
export function screenSize(bodyColumns: number | undefined, bodyRows: number | undefined, maxColumns: number = MAX_COLUMNS): Size {
  const width = Math.min(maxColumns, Math.max(MIN_COLUMNS, Math.floor(bodyColumns ?? 80)))
  const height = Math.max(6, Math.floor(bodyRows ?? 30) - CHROME_ROWS)
  let columns = width
  let rows = Math.floor((columns * 3) / 8)
  if (rows > height) {
    rows = height
    columns = Math.min(width, Math.floor((rows * 8) / 3))
  }
  return { columns: Math.max(MIN_COLUMNS, columns), rows: Math.min(MAX_ROWS, Math.max(6, rows)) }
}

// The pane the command asks for: docked, a width the render then fits to
// the screen the pane's height allows; inline above the prompt, tall enough
// for an 80-column screen.
export function paneRequest(): Size {
  return { columns: 90, rows: 30 + CHROME_ROWS }
}

const DEFAULT_COLOR = 0x01000000

// A blank screen, the cells drawn before the engine's first frame arrives.
export function blankCells(columns: number, rows: number): string {
  const words = new Uint32Array(columns * rows * 3)
  for (let i = 0; i < columns * rows; i++) {
    words[i * 3] = 0x20
    words[i * 3 + 1] = DEFAULT_COLOR
    words[i * 3 + 2] = 0x000000
  }
  const bytes = new Uint8Array(words.buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

// How long a size's cells are as text: twelve bytes a cell, base64.
export function cellsLength(size: Size): number {
  return Math.ceil((size.columns * size.rows * 12) / 3) * 4
}

// How the hooks reach the engine: `base` for its URLs and `init` for
// $.http.fetch. Over a Unix socket the URL's host is only a name; over
// 127.0.0.1 each request carries the token the engine was started with.
export function connectionOf(
  transport: Transport,
  { socketPath, port, token }: { socketPath: string | null; port: number | null; token: string | null },
): Connection {
  if (transport === 'unix') return { base: 'http://doom', init: socketPath === null ? {} : { socketPath } }
  return { base: `http://127.0.0.1:${port ?? 0}`, init: { headers: { 'x-doom-token': token ?? '' } } }
}

export function frameUrl(base: string, size: Size, since: number): string {
  return `${base}/frame?c=${size.columns}&r=${size.rows}&since=${since}`
}

export function keyUrl(base: string, codes: readonly number[]): string {
  return `${base}/key?k=${codes.join(',')}`
}

export function imageUrl(base: string, since: number): string {
  return `${base}/image?since=${since}`
}

export function quitUrl(base: string): string {
  return `${base}/quit`
}

// Keys reach a Client only after a click, and Esc (which a mod never gets)
// hands them back to Claude Code's prompt; before a click, the pane's focus
// sends space, digits and the like to the prompt too. So while Doom is being
// played (input in the last GAME_KEYS_MS), the prompt is Doom's: a key that
// lands there is taken out (`game`), and a game key goes on to Doom, any
// other key is dropped. It stays Doom's while it holds only what play typed
// into it (`isOurs`: empty when the game took it), so keys Claude Code let
// through anyway come back out. A `/` gives it back at once (`release`):
// commands like `/doom quit`, or a message once deleted. A prompt that held
// the person's own text, or a game left alone that long, is theirs (`pass`).
export const GAME_KEYS_MS = 10000

export function promptKeyRoute({
  isRunning,
  text,
  isOurs,
  msSinceGame,
  typed,
  hasModifier,
}: {
  isRunning: boolean
  text: string
  isOurs: boolean
  msSinceGame: number
  typed: string
  hasModifier: boolean
}): Route {
  if (!isRunning || hasModifier || msSinceGame >= GAME_KEYS_MS) return 'pass'
  if (text !== '' && !isOurs) return 'pass'
  if (typed.startsWith('/')) return 'release'
  return 'game'
}

// The stick: a drag on the screen (or the strip) with the left button held,
// measured in cells from where the button went down. It only turns: a drag
// left or right past the dead zone turns that way (strafes with shift) as
// fast as the `a` and `d` keys turn, however far it goes, and an up or down
// drag does nothing, so walking stays on the keys while the mouse turns. The
// right button fires. Doom takes it as its mouse each tic: `turn` as the
// mouse's sideways move, where 80 turns as fast as the arrow keys; the engine
// turns it at half that for its first six tics, as Doom does a held key.
export const STICK = { dead: 0.3, turn: 80, fire: 1, strafe: 2 }

// The engine's stick for the strip's: `{ dx, isHeld, isFiring, isStrafing }`.
// `forward` is always 0: the stick does not walk.
export function stickOf(pad: Pad | null): Stick {
  if (!pad) return { turn: 0, forward: 0, buttons: 0 }
  const dx = pad.isHeld ? pad.dx : 0
  const turn = Math.abs(dx) > STICK.dead ? Math.sign(dx) * STICK.turn : 0
  const buttons = (pad.isFiring ? STICK.fire : 0) | (pad.isHeld && pad.isStrafing ? STICK.strafe : 0)
  return { turn, forward: 0, buttons }
}

export function stickUrl(base: string, stick: Stick): string {
  return `${base}/stick?t=${stick.turn}&f=${stick.forward}&b=${stick.buttons}`
}

// What the stick is doing, in words, for the strip; null when it rests.
export function stickText(pad: Pad | null): string | null {
  if (!pad || (!pad.isHeld && !pad.isFiring)) return null
  const parts: string[] = []
  if (pad.isHeld) {
    if (pad.dx > STICK.dead) parts.push(pad.isStrafing ? 'strafe right' : 'turn right')
    if (pad.dx < -STICK.dead) parts.push(pad.isStrafing ? 'strafe left' : 'turn left')
    if (parts.length === 0) parts.push('held: drag sideways to turn')
  }
  if (pad.isFiring) parts.push('fire')
  return '◉ ' + parts.join(' · ')
}

export function sameStick(a: Stick | null, b: Stick | null): boolean {
  return a !== null && b !== null && a.turn === b.turn && a.forward === b.forward && a.buttons === b.buttons
}

// Doom's own screen, as the engine writes it for an Image: raw RGB.
export const IMAGE = { width: 320, height: 200, maxColumns: 255 } as const

// An Image's source for frame `generation` of that file: the terminal reads
// the file itself, and a new generation makes it read it again.
export function imageSource(path: string, generation: number): ImageSource {
  return { file: path, format: 'rgb', width: IMAGE.width, height: IMAGE.height, generation }
}

// Whether the terminal draws pictures (kitty's graphics protocol): kitty and
// Ghostty say so in TERM or TERM_PROGRAM. A terminal that does not still gets
// the cells: a refused Image blit switches back.
export function drawsImages(term: string | undefined, termProgram: string | undefined): boolean {
  return /kitty|ghostty/i.test(String(term ?? '')) || /ghostty/i.test(String(termProgram ?? ''))
}

// The machine the engine runs on, as the name of its folder under
// engine/bin: `{ os, arch }`, each null when unknown. On Windows from
// %OS% and %PROCESSOR_ARCHITECTURE% (a 32-bit host reports the machine's
// own in %PROCESSOR_ARCHITEW6432%); elsewhere from `uname -sm`.
export function platformOf({
  os,
  processorArch,
  processorArch6432,
  uname,
}: {
  os?: string | undefined
  processorArch?: string | undefined
  processorArch6432?: string | undefined
  uname?: string | undefined
} = {}): Platform {
  if (os === 'Windows_NT') {
    const arch = String(processorArch6432 || processorArch || '').toUpperCase()
    return { os: 'windows', arch: arch === 'AMD64' ? 'x86_64' : arch === 'ARM64' ? 'arm64' : null }
  }
  const [system = '', machine = ''] = String(uname ?? '').trim().split(/\s+/)
  const name = system === 'Linux' ? 'linux' : system === 'Darwin' ? 'macos' : null
  const arch = /^(x86_64|amd64)$/i.test(machine) ? 'x86_64' : /^(arm64|aarch64)$/i.test(machine) ? 'arm64' : null
  return { os: name, arch }
}

// The engines to try, best first: the prebuilt one for this machine, then
// one built here by `make` (engine/doom-claude).
export function engineCandidates(root: string, platform: Platform): string[] {
  const exe = platform.os === 'windows' ? '.exe' : ''
  const prebuilt = platform.os && platform.arch ? [`${root}/engine/bin/${platform.os}-${platform.arch}/doom-claude${exe}`] : []
  return [...prebuilt, `${root}/engine/doom-claude${exe}`]
}

// A Unix socket's path fits in about 100 bytes (104 on macOS, 108 on Linux).
export const SOCKET_PATH_MAX = 100

// Where the engine listens and writes its frames. A Unix socket in the first
// private directory whose path fits (the session's runtime directory, the
// user's temporary directory, the mod's data directory); 127.0.0.1 on
// Windows, when none fits, or when `prefer` is `tcp`. The frame file sits in
// that same directory.
export function placementOf({
  platform,
  runtimeDir,
  tmpDir,
  dataDir,
  id,
  prefer,
}: {
  platform: Platform
  runtimeDir?: string | undefined
  tmpDir?: string | undefined
  dataDir: string
  id: string
  prefer?: string | undefined
}): Placement {
  const dirs = [runtimeDir, tmpDir]
    .filter((dir): dir is string => typeof dir === 'string' && dir.startsWith('/'))
    .map((dir) => dir.replace(/\/+$/, ''))
  dirs.push(dataDir)
  const name = `claude-doom-${id}`
  if (platform.os !== 'windows' && prefer !== 'tcp') {
    for (const dir of dirs) {
      const socketPath = `${dir}/${name}.sock`
      if (socketPath.length <= SOCKET_PATH_MAX) return { transport: 'unix', socketPath, imagePath: `${dir}/${name}.rgb` }
    }
  }
  return { transport: 'tcp', socketPath: null, imagePath: `${dirs[0] ?? dataDir}/${name}.rgb` }
}

// The engine's command line.
export function engineArgs(binary: string, root: string, placement: Placement): string[] {
  return [
    binary,
    ...(placement.transport === 'unix' ? ['--socket', placement.socketPath] : ['--port', '0']),
    '--image',
    placement.imagePath,
    '--dir',
    `${root}/data`,
    '-iwad',
    `${root}/wad/freedoom1.wad`,
  ]
}

// The line the engine prints once it listens: `{ port }` (null over a Unix
// socket), or null when `text` does not hold it yet.
export function listeningOf(text: string): { port: number | null } | null {
  const match = /^doom-claude listening(?: port=(\d+))?\r?$/m.exec(text)
  if (!match) return null
  return { port: match[1] ? Number(match[1]) : null }
}

// A token for the engine's TCP listener: 64 hex digits.
export function newToken(): string {
  return (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', '')
}

// The strip posts every key it has taken lately, numbered, so a post that
// replaces an undelivered one loses nothing: keep the ones newer than `seen`.
export function freshKeys(message: unknown, seen: number): { seen: number; codes: number[] } {
  if (!isRecord(message) || message['type'] !== 'keys' || !Array.isArray(message['keys'])) return { seen, codes: [] }
  let last = seen
  const codes: number[] = []
  for (const k of message['keys'] as unknown[]) {
    if (!isRecord(k)) continue
    const n = k['n']
    const code = k['code']
    if (typeof n !== 'number' || typeof code !== 'number') continue
    if (n <= seen) continue
    codes.push(code)
    last = Math.max(last, n)
  }
  return { seen: last, codes }
}

// The stick a post carries, or null when it is not a well-formed one.
export function padOf(message: unknown): Pad | null {
  if (!isRecord(message) || !isRecord(message['stick'])) return null
  const s = message['stick']
  const dx = s['dx']
  const dy = s['dy']
  if (typeof dx !== 'number' || typeof dy !== 'number') return null
  return { dx, dy, isHeld: s['isHeld'] === true, isFiring: s['isFiring'] === true, isStrafing: s['isStrafing'] === true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// `/doom` alone opens the game; `/doom quit` ends it.
export function parseArgs(args: string | undefined): Args {
  const word = (args ?? '').trim().toLowerCase()
  if (word === '') return { action: 'play' }
  if ('quit'.startsWith(word) || word === 'stop') return { action: 'quit' }
  return { error: `Unknown argument "${word}". Use /doom or /doom quit.` }
}
