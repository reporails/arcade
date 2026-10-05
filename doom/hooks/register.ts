// doom: Doom in a pane.
//
// The game runs in a process of its own (engine/doom-claude, doomgeneric with
// Freedoom), prebuilt per platform under engine/bin, run with $.process.spawn
// for as long as the session lasts, and talked to over a Unix socket (Linux,
// macOS) or 127.0.0.1 (Windows). The hooks here start it, pull each new frame
// as Raster cells and blit them onto the screen, and hand it the keys the
// strip (pad.js) and the buttons take. No hook touches what the model reads.
//
// The host reads on(...) and $.noun.method(...) from source, so they are
// spelled literally, and helpers that take $ are top-level functions here.

import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, Timer } from 'claude-code'

import type { PadProps } from './pad'
import {
  BUTTONS,
  GAME_KEYS_MS,
  IMAGE,
  blankCells,
  cellsLength,
  connectionOf,
  drawsImages,
  engineArgs,
  engineCandidates,
  frameUrl,
  doomKeyOf,
  freshKeys,
  imageSource,
  promptKeyRoute,
  imageUrl,
  keyUrl,
  listeningOf,
  newToken,
  padOf,
  paneRequest,
  parseArgs,
  placementOf,
  platformOf,
  quitUrl,
  sameStick,
  screenSize,
  stickOf,
  stickText,
  stickUrl,
} from './lib'
import type { Connection, Platform, Size, Stick } from './lib'

type Status = 'off' | 'building' | 'starting' | 'running' | 'exited'
type Child = HookStream<ProcessSpawnChunk, ProcessSpawnResult>
type Env = {
  OS: string | undefined
  PROCESSOR_ARCHITECTURE: string | undefined
  PROCESSOR_ARCHITEW6432: string | undefined
  XDG_RUNTIME_DIR: string | undefined
  TMPDIR: string | undefined
  TERM: string | undefined
  TERM_PROGRAM: string | undefined
  DOOM_CLAUDE_TRANSPORT: string | undefined
}

const PANE = 'doom'
const SCREEN = 'screen'
const PAD = 'pad'
const LOOK = 'look'
const FRAME_MS = 28
const FOCUS_DELAY_MS = 250
const START_TIMEOUT_MS = 15000
const FIT_SLACK = 2
const IMAGE_REFUSALS = 10
const BUILD_TIMEOUT_MS = 600000
const LOG_MAX = 65536
const PROMPT_CHECK_MS = 250
const NO_SCREEN = 'Doom draws its screen in the terminal only.'

// The game as the hooks know it. In memory; the engine holds the rest.
const state: {
  status: Status
  note: string
  mode: 'image' | 'cells'
  imagePath: string | null
  imageFrame: number | null
  imageRefusals: number
  conn: Connection | null
  child: Child | null
  run: number
  size: Size
  frame: number
  cells: string | null
  cellsSize: Size | null
  timer: Timer | null
  isPulling: boolean
  isPainting: boolean
  isPaintWaiting: boolean
  seenKeys: Record<string, number>
  stick: Stick | null
  stickText: string | null
  isArmed: boolean
  isStickSending: boolean
  stickWaiting: Stick | null
  fittedTo: number | null
  gameInputAt: number
  queuedKeys: number[]
  promptCheckAt: number
  isPromptOurs: boolean
} = {
  status: 'off',
  note: '',
  // `image`: the screen is an Image the terminal reads from the engine's file
  // (kitty, Ghostty); `cells`: a Raster of quadrant blocks, anywhere else.
  mode: 'cells',
  imagePath: null,
  imageFrame: null,
  imageRefusals: 0,
  // How to reach the engine (connectionOf), null while none runs; the
  // spawned engine's stream, and which start it belongs to.
  conn: null,
  child: null,
  run: 0,
  size: { columns: 120, rows: 45 },
  frame: -1,
  cells: null,
  cellsSize: null,
  timer: null,
  isPulling: false,
  isPainting: false,
  isPaintWaiting: false,
  seenKeys: {},
  stick: null,
  stickText: null,
  isArmed: false,
  isStickSending: false,
  stickWaiting: null,
  fittedTo: null,
  // When the game last had input: a key, a click or drag, a button.
  gameInputAt: 0,
  // Keys taken out of the prompt, for the frame pull to send, and when to
  // look at the prompt once more for one that slipped in at the end.
  queuedKeys: [],
  promptCheckAt: 0,
  // Whether the prompt is Doom's: empty when play took it, holding nothing of
  // the person's since.
  isPromptOurs: false,
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      await $.command.register({
        name: 'doom',
        description: 'Play Doom (Freedoom) in a pane',
        argumentHint: '[quit]',
        immediate: true,
      })
    } catch {
      // The name is taken; nothing else opens the pane.
    }
    return result
  })

  on('command.run', { command: 'doom' }, async ($, e) => {
    const asked = parseArgs(e.args)
    if ('error' in asked) return { text: asked.error }
    if (asked.action === 'quit') {
      await stopEngine($)
      try {
        await $.ui.close({ id: PANE })
      } catch {
        // Not open.
      }
      return { text: 'Doom has quit.' }
    }
    const surfaces = await $.session.surfaces()
    if (!surfaces.includes('terminal')) return { text: NO_SCREEN }
    await openPane($)
    focusSoon($)
    if (state.status !== 'running' && state.status !== 'starting' && state.status !== 'building') {
      void startEngine($)
    }
    return {}
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const elements = $.ui.resolve(e)
    // The surface decides; the `in` checks only tell the types what it decided.
    if (e.surface !== 'terminal' || !('Raster' in elements) || !('Image' in elements) || !('Client' in elements)) {
      return elements.Text({ children: [NO_SCREEN] })
    }
    const { Box, Text, Button, Raster, Image, Client } = elements
    const props = e.props
    const size = screenSize(props.bodyColumns, props.scroll.bodyRows, state.mode === 'image' ? IMAGE.maxColumns : undefined)
    if (size.columns !== state.size.columns || size.rows !== state.size.rows) {
      state.size = size
      state.frame = -1
    }
    // A dock wider than the screen the height allows: ask for the width the
    // screen needs, once per size, so the transcript keeps the rest.
    if (props.placement === 'dock' && props.bodyColumns > size.columns + FIT_SLACK && state.fittedTo !== size.columns) {
      state.fittedTo = size.columns
      fitPane($, size.columns)
    }
    const isShown = state.cells !== null && state.cellsSize !== null && state.cellsSize.columns === size.columns && state.cellsSize.rows === size.rows
    const buttons = BUTTONS.map((b) =>
      Button({
        key: 'key-' + b.hotkey,
        label: b.label,
        hotkey: b.hotkey,
        plain: true,
        dimColor: true,
        ...(b.autoFocus ? { autoFocus: true } : {}),
        onPress: () => {
          playing()
          return sendKeys($, [b.code])
        },
      }),
    )
    return Box({
      flexDirection: 'column',
      children: [
        // The screen, and over it the pointer's layer, which draws nothing.
        Box({
          width: size.columns,
          height: size.rows,
          children: [
            state.mode === 'image'
              ? state.imageFrame === null
                ? Box({ height: size.rows, width: size.columns, children: [Text({ dimColor: true, children: ['Starting Doom…'] })] })
                : Image({ key: SCREEN, source: imageSource(state.imagePath ?? '', state.imageFrame), columns: size.columns, rows: size.rows, alt: 'Doom' })
              : Raster({ key: SCREEN, columns: size.columns, rows: size.rows, cells: isShown && state.cells !== null ? state.cells : blankCells(size.columns, size.rows) }),
            Box({
              position: 'absolute',
              top: 0,
              left: 0,
              width: size.columns,
              height: size.rows,
              children: [Client({ key: LOOK, module: './pad.ts', props: { role: 'look' } satisfies PadProps, width: size.columns, height: size.rows })],
            }),
          ],
        }),
        Client({ key: PAD, module: './pad.ts', props: { role: 'strip', status: statusLine(), stick: state.stickText, isArmed: state.isArmed } satisfies PadProps }),
        Box({ flexDirection: 'row', columnGap: 2, children: buttons }),
      ],
    })
  })

  // The strip posts the keys it took.
  on('ui.message', async ($, e, next) => {
    const result = await next(e)
    if (e.requestId !== PANE || (e.element !== PAD && e.element !== LOOK)) return result
    playing()
    // Each instance numbers its own keys.
    const fresh = freshKeys(e.data, state.seenKeys[e.element] ?? 0)
    state.seenKeys[e.element] = fresh.seen
    if (fresh.codes.length > 0) await sendKeys($, fresh.codes)
    if (!state.isArmed) {
      state.isArmed = true
      $.ui.invalidate('ui.render')
    }
    const pad = padOf(e.data)
    if (pad !== null) {
      const text = stickText(pad)
      if (text !== state.stickText) {
        state.stickText = text
        $.ui.invalidate('ui.render')
      }
      const stick = stickOf(pad)
      // Held, it is sent again now and then, so the engine keeps it.
      if (!sameStick(stick, state.stick) || stick.turn || stick.forward || stick.buttons) await sendStick($, stick)
    }
    return result
  })

  // Keys that land in Claude Code's prompt while Doom is played (after Esc,
  // or before a click) are Doom's (promptKeyRoute). Decided with no call on
  // $: the editor waits on this answer, and a slow answer is a key let
  // through. The frame pull sends the queued keys.
  on('prompt.edit', async (_$, e, next) => {
    const now = Date.now()
    const route = promptKeyRoute({
      isRunning: state.status === 'running' && state.conn !== null,
      text: e.text,
      isOurs: state.isPromptOurs,
      msSinceGame: now - state.gameInputAt,
      typed: e.key ? e.key.key : String(e.inputText ?? ''),
      hasModifier: Boolean(e.key && (e.key.ctrl || e.key.meta)),
    })
    if (route === 'pass') {
      state.isPromptOurs = false
      return next(e)
    }
    if (route === 'release') {
      // The `/` goes into an empty prompt, whatever play left there.
      state.isPromptOurs = false
      state.gameInputAt = 0
      return next({ ...e, text: '', cursor: 0, start: 0, end: 0 })
    }
    state.isPromptOurs = true
    const keys = e.key ? [e.key] : Array.from(String(e.inputText ?? '')).map((ch) => ({ key: ch }))
    const codes = keys.map(doomKeyOf).filter((code) => code !== null)
    if (codes.length > 0) {
      state.gameInputAt = now
      state.queuedKeys.push(...codes)
    }
    state.promptCheckAt = now + PROMPT_CHECK_MS
    return { text: '', cursor: 0 }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await stopEngine($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await stopEngine($)
    return next(e)
  })
}

function statusLine(): string {
  if (state.status === 'building') return 'Building the engine (first run only, about ten seconds)…'
  if (state.status === 'starting') return 'Starting Doom…'
  if (state.status === 'exited') return state.note || 'Doom has quit. /doom starts it again.'
  if (state.status === 'off') return 'Doom is not running. /doom starts it.'
  return 'Freedoom 0.13 · doomgeneric · /doom quit ends it'
}

// A key that slipped into the prompt last, with no key after it to take it
// back out: clear it, while the prompt is still Doom's. Not sent on: that
// late, a move would outlast the key.
async function clearLeakedPrompt($: EngineInterface): Promise<void> {
  if (!state.isPromptOurs || Date.now() - state.gameInputAt >= GAME_KEYS_MS) return
  try {
    const box = await $.prompt.read()
    if (box.text !== '' && !box.text.startsWith('/')) await $.prompt.fill({ text: '' })
  } catch {
    // No box (a -p run): nothing to clear.
  }
}

// The game had input (a key, a click or drag, a button press).
function playing(): void {
  state.gameInputAt = Date.now()
}

function setStatus($: EngineInterface, status: Status, note?: string): void {
  state.status = status
  state.note = note ?? ''
  $.ui.invalidate('ui.render')
}

// Open the pane, or bring the open one forward, with the keyboard if it can;
// at the width it was fitted to, once it has been.
async function openPane($: EngineInterface): Promise<void> {
  const size = paneRequest()
  try {
    // No closeOnEscape: Esc is Doom's menu key by habit, and with it a second
    // Esc would close the pane and end the game. /doom quit or Ctrl+X X close it.
    await $.ui.open({ id: PANE, title: 'Doom', focus: true, rows: size.rows, columns: state.fittedTo ?? size.columns })
  } catch {
    // Refused; the pane stays as it was.
  }
  $.ui.invalidate('ui.render')
}

function fitPane($: EngineInterface, columns: number): void {
  try {
    $.clock.after(0, async () => {
      try {
        await $.ui.open({ id: PANE, title: 'Doom', columns })
      } catch {
        // Refused; the pane keeps its width.
      }
    })
  } catch {
    // No timer; the pane keeps its width.
  }
}

// A pane takes the keyboard only over an empty prompt, and the command's own
// text is still in it while the command runs: ask again once it has returned.
function focusSoon($: EngineInterface): void {
  try {
    $.clock.after(FOCUS_DELAY_MS, () => void openPane($))
  } catch {
    // No timer; a click on the pane gives it the keyboard.
  }
}

// Find the engine for this machine (building it when there is none), start
// it, wait for the line that says it listens, and pull its frames.
async function startEngine($: EngineInterface): Promise<void> {
  const root = $.plugin.root
  const run = ++state.run
  try {
    const env = await readEnv($)
    let uname: string | undefined
    if (env.OS !== 'Windows_NT') {
      try {
        uname = (await $.process.run(['uname', '-sm'])).stdout
      } catch {
        // No uname: only an engine built here will do.
      }
    }
    const platform = platformOf({ os: env.OS, processorArch: env.PROCESSOR_ARCHITECTURE, processorArch6432: env.PROCESSOR_ARCHITEW6432, uname })
    const binary = await findEngine($, root, platform)
    if (binary === null) return
    if (run !== state.run) return

    setStatus($, 'starting')
    const placement = placementOf({
      platform,
      runtimeDir: env.XDG_RUNTIME_DIR,
      tmpDir: env.TMPDIR,
      dataDir: `${root}/data`,
      id: Math.floor(Math.random() * 1e9).toString(36),
      prefer: env.DOOM_CLAUDE_TRANSPORT,
    })
    const token = placement.transport === 'tcp' ? newToken() : null
    const child = $.process.spawn({ argv: engineArgs(binary, root, placement), env: token !== null ? { DOOM_CLAUDE_TOKEN: token } : {} })
    state.child = child
    const listening = await watchEngine($, child, run, root)
    if (run !== state.run) return
    if (listening === null) return
    state.conn = connectionOf(placement.transport, { socketPath: placement.socketPath, port: listening.port, token })
    state.imagePath = placement.imagePath
    state.imageFrame = null
    state.mode = drawsImages(env.TERM, env.TERM_PROGRAM) ? 'image' : 'cells'
    state.frame = -1
    state.stick = null
    state.stickText = null
    // The game is in front of the person now: their keys are for it.
    state.isPromptOurs = false
    playing()
    setStatus($, 'running')
    startPulling($)
  } catch (error) {
    if (run === state.run) setStatus($, 'exited', 'Doom did not start: ' + messageOf(error))
  }
}

// The variables startEngine reads, each undefined when unset or unread.
// $.env.get takes its name as a literal: the host reads them off the source.
async function readEnv($: EngineInterface): Promise<Env> {
  const [OS, PROCESSOR_ARCHITECTURE, PROCESSOR_ARCHITEW6432, XDG_RUNTIME_DIR, TMPDIR, TERM, TERM_PROGRAM, DOOM_CLAUDE_TRANSPORT] = await Promise.all([
    $.env.get('OS').catch(() => undefined),
    $.env.get('PROCESSOR_ARCHITECTURE').catch(() => undefined),
    $.env.get('PROCESSOR_ARCHITEW6432').catch(() => undefined),
    $.env.get('XDG_RUNTIME_DIR').catch(() => undefined),
    $.env.get('TMPDIR').catch(() => undefined),
    $.env.get('TERM').catch(() => undefined),
    $.env.get('TERM_PROGRAM').catch(() => undefined),
    $.env.get('DOOM_CLAUDE_TRANSPORT').catch(() => undefined),
  ])
  return { OS, PROCESSOR_ARCHITECTURE, PROCESSOR_ARCHITEW6432, XDG_RUNTIME_DIR, TMPDIR, TERM, TERM_PROGRAM, DOOM_CLAUDE_TRANSPORT }
}

// The first engine that is there for this machine; one built by `make` when
// none is (not on Windows, which has no compiler to count on). Null, with the
// pane saying why, when there is none.
async function findEngine($: EngineInterface, root: string, platform: Platform): Promise<string | null> {
  const candidates = engineCandidates(root, platform)
  for (const path of candidates) {
    if (await $.fs.exists(path)) {
      if (platform.os !== 'windows') {
        // An install that dropped the execute bit would refuse to run it.
        await $.process.run(['chmod', '+x', path]).catch(() => undefined)
      }
      return path
    }
  }
  const where = platform.os && platform.arch ? `${platform.os}-${platform.arch}` : 'this machine'
  if (platform.os === 'windows') {
    setStatus($, 'exited', `No engine for ${where}: engine/bin/ has none.`)
    return null
  }
  setStatus($, 'building')
  const built = await $.process.run(['make', '-C', `${root}/engine`], { timeoutMs: BUILD_TIMEOUT_MS })
  if (built.exitCode !== 0) {
    setStatus($, 'exited', `No engine for ${where}, and it did not build: ` + lastLine(built.stderr || built.stdout))
    return null
  }
  return candidates.at(-1) ?? null
}

// Read the engine's output for as long as it runs. Resolves with
// listeningOf's `{ port }` once the engine listens, or null when it ends or
// stays silent past START_TIMEOUT_MS first; when it ends, the pane says so
// and data/engine.log keeps what it wrote.
function watchEngine($: EngineInterface, child: Child, run: number, root: string): Promise<{ port: number | null } | null> {
  return new Promise((resolve) => {
    let isSettled = false
    const settle = (value: { port: number | null } | null): void => {
      if (isSettled) return
      isSettled = true
      resolve(value)
    }
    let timer: Timer | null = null
    try {
      timer = $.clock.after(START_TIMEOUT_MS, () => {
        if (isSettled) return
        settle(null)
        if (run === state.run) setStatus($, 'exited', 'Doom did not start: the engine did not answer.')
        child.return({ code: null, signal: null }).catch(() => undefined)
      })
    } catch {
      // No timer: the engine's own exit still ends the wait.
    }
    void (async () => {
      let output = ''
      let ending: ProcessSpawnResult | null = null
      try {
        for (;;) {
          const step = await child.next()
          if (step.done) {
            ending = step.value
            break
          }
          output = (output + step.value.text).slice(-LOG_MAX)
          if (!isSettled) {
            const listening = listeningOf(output)
            if (listening !== null) {
              if (timer) timer.cancel()
              settle(listening)
            }
          }
        }
      } catch (error) {
        output += `\n${messageOf(error)}\n`
      }
      if (timer) timer.cancel()
      const wasListening = isSettled
      settle(null)
      const how = ending ? (ending.signal ? `signal ${ending.signal}` : `exit code ${ending.code}`) : 'did not run'
      try {
        await $.fs.write(`${root}/data/engine.log`, output + `[doom-claude ended: ${how}]\n`)
      } catch {
        // No log; the pane still says how it ended.
      }
      if (run !== state.run || state.child !== child) return
      state.child = null
      stopPulling()
      state.conn = null
      state.cells = null
      const isClean = ending && ending.code === 0 && !ending.signal
      if (!wasListening) setStatus($, 'exited', 'Doom did not start: ' + lastLine(output))
      else setStatus($, 'exited', isClean ? '' : `Doom stopped (${how}): ` + lastLine(output))
    })()
  })
}

function lastLine(text: string | undefined): string {
  const lines = String(text ?? '').trim().split('\n')
  return lines[lines.length - 1] || 'no output'
}

function startPulling($: EngineInterface): void {
  if (state.timer !== null) state.timer.cancel()
  state.timer = $.clock.every(FRAME_MS, () => void pullFrame($))
}

function stopPulling(): void {
  if (state.timer !== null) state.timer.cancel()
  state.timer = null
}

// Fetch the newest frame, if there is one since the last, and paint it.
async function pullFrame($: EngineInterface): Promise<void> {
  if (state.queuedKeys.length > 0 && state.conn !== null) {
    void sendKeys($, state.queuedKeys.splice(0))
  }
  if (state.promptCheckAt !== 0 && Date.now() >= state.promptCheckAt) {
    state.promptCheckAt = 0
    void clearLeakedPrompt($)
  }
  if (state.isPulling || state.conn === null) return
  state.isPulling = true
  const size = state.size
  const conn = state.conn
  try {
    if (state.mode === 'image') {
      // The engine writes the frame to its file; the terminal reads it there.
      const response = await $.http.fetch(imageUrl(conn.base, state.frame), conn.init)
      if (response.status === 200) {
        state.frame = Number(response.headers['x-frame'] ?? -1)
        if (state.imageFrame === null) {
          // The first frame mounts the Image; blits swap it from then on.
          state.imageFrame = state.frame
          $.ui.invalidate('ui.render')
        } else {
          paint($)
        }
      }
    } else {
      const response = await $.http.fetch(frameUrl(conn.base, size, state.frame), conn.init)
      // A frame for another size (the pane was resized under the request) waits for the next.
      if (response.status === 200 && response.text.length === cellsLength(size)) {
        state.frame = Number(response.headers['x-frame'] ?? -1)
        state.cells = response.text
        state.cellsSize = size
        paint($)
      }
    }
  } catch {
    // The engine is gone: Doom's own Quit, or it stopped. The watch on its
    // output says how, once its stream ends.
    stopPulling()
    state.conn = null
    state.cells = null
    if (state.status === 'running') setStatus($, 'exited')
  } finally {
    state.isPulling = false
  }
}

// Paint the newest frame: swap the Image to it, or blit its cells. A blit
// resolves once Claude Code has painted it, so one is in flight at a time and
// a frame that arrives meanwhile waits for it (a newer one replacing it); the
// next fetch does not wait for the paint. The strip (pad.js) keeps Claude
// Code drawing frames.
function paint($: EngineInterface): void {
  if (state.isPainting) {
    state.isPaintWaiting = true
    return
  }
  const isImage = state.mode === 'image'
  const cells = state.cells
  const cellsSize = state.cellsSize
  if (isImage ? state.imageFrame === null || state.imagePath === null : cells === null || cellsSize === null) return
  state.isPainting = true
  const blit =
    isImage || cells === null || cellsSize === null
      ? $.ui.blit({ requestId: PANE, key: SCREEN, source: imageSource(state.imagePath ?? '', state.frame) })
      : $.ui.blit({ requestId: PANE, key: SCREEN, cells, columns: cellsSize.columns, rows: cellsSize.rows })
  blit
    .then((result) => {
      // Refused swap after swap: the terminal draws no pictures after all
      // (the Image shows its alt). Back to the cells. One refusal alone can be
      // a pane hidden for a moment.
      if (!isImage) return
      state.imageRefusals = 'deny' in result && result.deny ? state.imageRefusals + 1 : 0
      if (state.imageRefusals >= IMAGE_REFUSALS) {
        state.mode = 'cells'
        state.imageFrame = null
        state.imageRefusals = 0
        state.frame = -1
        $.ui.invalidate('ui.render')
      }
    })
    .catch(() => undefined)
    .finally(() => {
      state.isPainting = false
      if (state.isPaintWaiting) {
        state.isPaintWaiting = false
        paint($)
      }
    })
}

async function sendKeys($: EngineInterface, codes: readonly number[]): Promise<void> {
  if (state.conn === null) return
  try {
    await $.http.fetch(keyUrl(state.conn.base, codes), state.conn.init)
  } catch {
    // The frame pull notices the engine is gone.
  }
}

// One stick request at a time; the newest waits for it, replacing any older.
async function sendStick($: EngineInterface, stick: Stick): Promise<void> {
  if (state.conn === null) return
  if (state.isStickSending) {
    state.stickWaiting = stick
    return
  }
  state.isStickSending = true
  try {
    await $.http.fetch(stickUrl(state.conn.base, stick), state.conn.init)
    state.stick = stick
  } catch {
    // The frame pull notices the engine is gone.
  } finally {
    state.isStickSending = false
  }
  const next = state.stickWaiting
  state.stickWaiting = null
  if (next !== null) await sendStick($, next)
}

// Ask the engine to quit, and end its stream, which ends the process
// should it not answer. A later start is a new run: the old run's watch then
// leaves the pane alone.
async function stopEngine($: EngineInterface): Promise<void> {
  stopPulling()
  state.run++
  const conn = state.conn
  const child = state.child
  state.conn = null
  state.child = null
  state.cells = null
  state.status = 'off'
  // The pane's surface modules end with it and count their keys from 1 again
  // when it reopens. While it stays open (an engine that ended by itself and
  // is started again) they go on counting, so their counts are kept.
  state.seenKeys = {}
  if (conn !== null) {
    try {
      await $.http.fetch(quitUrl(conn.base), conn.init)
      return
    } catch {
      // Not answering: end its stream instead.
    }
  }
  if (child !== null) child.return({ code: null, signal: null }).catch(() => undefined)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
