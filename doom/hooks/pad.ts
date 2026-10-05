// doom: the surface module taking the pointer and the keys. Two instances:
// `look`, laid over the screen and drawing nothing there, so the mouse works
// on the game itself (a surface module cannot draw the screen, so it lies on
// top of it); and `strip`, the red line under it, which says what the stick is
// doing. A click on either gives it the keyboard; every key it takes and the
// stick go to the hooks module, which hands them to the engine.

import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

import { doomKeyOf } from './lib'
import type { Pad } from './lib'

// What the hooks module hands each instance: the layer over the screen needs
// nothing; the strip shows the status line, the stick in words, and whether
// it has been clicked yet.
export type PadProps = { role: 'look' } | { role: 'strip'; status: string; stick: string | null; isArmed: boolean }

type Mode = 'idle' | 'armed' | 'playing'
type PadState = { mode: Mode; beat: 0 | 1 }

// How many recent keys each post carries. A post replaces one not yet
// delivered, so each carries the last few, numbered, and the hooks module
// keeps the ones it has not seen.
const RECENT = 24

// Claude Code paints a blitted Raster at its next frame, and with nothing
// else moving it draws a frame only about three times a second. The strip
// redraws itself PUMP_MS apart (a blank that alternates between two blank
// characters) so every frame the engine sends gets painted. That costs far
// less than redrawing the whole pane from the hooks module.
const PUMP_MS = 30
const BEATS = [' ', '⠀'] as const

// While the stick is held, say so again this often (in beats), so the
// engine, which lets a stick go when it hears nothing for 1.5 s, keeps it.
// The strip says so on its heartbeat; the layer over the screen, which has no
// heartbeat, on a timer of its own that redraws nothing.
const RESEND_BEATS = 10
const RESEND_MS = PUMP_MS * RESEND_BEATS

type Point = { x: number; y: number }
type Keys = { n: number; recent: { n: number; code: number }[]; stick: Pad; anchor: Point | null; beats: number }

// Each instance's key count, recent keys and stick. Not state: they redraw
// nothing by themselves.
const pads = new WeakMap<ClientSurface<PadState>, Keys>()

function padOf(surface: ClientSurface<PadState>): Keys {
  let pad = pads.get(surface)
  if (pad === undefined) {
    pad = { n: 0, recent: [], stick: { dx: 0, dy: 0, isHeld: false, isFiring: false, isStrafing: false }, anchor: null, beats: 0 }
    pads.set(surface, pad)
  }
  return pad
}

// Everything the strip has to say in one post: a post replaces one not yet
// delivered, so keys and stick travel together.
function send(surface: ClientSurface<PadState>, pad: Keys): void {
  surface.post({ type: 'keys', keys: pad.recent, stick: pad.stick })
}

// Where the pointer is, to the fraction of a cell where the terminal says.
function where(e: ClientPointerEvent): Point {
  return e.fine ? { x: e.fine.x, y: e.fine.y } : { x: e.x + 0.5, y: e.y + 0.5 }
}

function stateOf(surface: ClientSurface<PadState>): PadState {
  return surface.state ?? { mode: 'idle', beat: 0 }
}

function typed(surface: ClientSurface<PadState>, e: ClientKeyEvent): void {
  const code = doomKeyOf(e)
  if (code === null) return
  const pad = padOf(surface)
  pad.n += 1
  pad.recent.push({ n: pad.n, code })
  if (pad.recent.length > RECENT) pad.recent.shift()
  send(surface, pad)
  const state = stateOf(surface)
  if (state.mode !== 'playing') surface.setState({ ...state, mode: 'playing' })
}

// The left button holds the stick where it went down; the right fires.
function pointed(surface: ClientSurface<PadState>, e: ClientPointerEvent): void {
  const pad = padOf(surface)
  const stick = pad.stick
  const at = where(e)
  if (e.type === 'down' && e.button === 'left') {
    pad.anchor = at
    pad.stick = { ...stick, dx: 0, dy: 0, isHeld: true, isStrafing: e.shift === true }
  } else if (e.type === 'down' && e.button === 'right') {
    pad.stick = { ...stick, isFiring: true }
  } else if (e.type === 'move' && stick.isHeld && pad.anchor) {
    pad.stick = { ...stick, dx: at.x - pad.anchor.x, dy: at.y - pad.anchor.y, isStrafing: e.shift === true }
  } else if (e.type === 'up') {
    const isLeft = e.button === 'left' || e.button === undefined
    const isRight = e.button === 'right' || e.button === undefined
    pad.stick = {
      dx: isLeft ? 0 : stick.dx,
      dy: isLeft ? 0 : stick.dy,
      isHeld: isLeft ? false : stick.isHeld,
      isFiring: isRight ? false : stick.isFiring,
      isStrafing: isLeft ? false : stick.isStrafing,
    }
    if (isLeft) pad.anchor = null
  } else {
    return
  }
  send(surface, pad)
  const state = stateOf(surface)
  if (state.mode === 'idle') surface.setState({ ...state, mode: 'armed' })
}

function resend(surface: ClientSurface<PadState>): void {
  const pad = padOf(surface)
  if (pad.stick.isHeld || pad.stick.isFiring) send(surface, pad)
}

function beat(surface: ClientSurface<PadState>): void {
  const pad = padOf(surface)
  pad.beats += 1
  if ((pad.stick.isHeld || pad.stick.isFiring) && pad.beats % RESEND_BEATS === 0) send(surface, pad)
  const state = stateOf(surface)
  surface.setState({ ...state, beat: state.beat === 0 ? 1 : 0 })
}

const PadModule: ClientModule<PadProps, PadState> = (props, surface) => {
  const { Box, Text } = surface.elements
  const isLook = props.role === 'look'
  if (surface.state === undefined) {
    surface.setState({ mode: 'idle', beat: 0 })
    // One heartbeat is enough: the strip's. The layer over the screen still
    // says a held stick again, or the engine would let it go.
    if (isLook) surface.every(RESEND_MS, () => resend(surface))
    else surface.every(PUMP_MS, () => beat(surface))
  }
  surface.onKey((e) => typed(surface, e))
  surface.onPointer((e) => pointed(surface, e))
  // Over the screen: nothing drawn, so the picture shows through.
  if (props.role === 'look') return Box({ flexDirection: 'column' })

  const state = stateOf(surface)
  const line =
    props.stick ??
    (props.isArmed
      ? '▶ drag sideways on the game with the left button to turn, right button fires · keys: w s walk, space fires, e use, 1-7 weapons, m menu, return picks and says yes · while you play, the prompt is Doom\'s: type / (or rest 10 s) to talk to Claude'
      : '▶ hold the left button on the game and drag sideways to turn (shift: strafe) · w s walk · right button fires · a click also gives Doom the keys')
  return Box({
    flexDirection: 'column',
    children: [
      Box({
        flexDirection: 'row',
        children: [
          Text({ children: [BEATS[state.beat]] }),
          Text({ bold: state.mode !== 'playing', color: 'red', wrap: 'truncate-end', children: [line] }),
        ],
      }),
      Text({ dimColor: true, wrap: 'truncate-end', children: [props.status === '' ? ' ' : props.status] }),
    ],
  })
}

export default PadModule
