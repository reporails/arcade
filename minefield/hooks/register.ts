// minefield: Minesweeper in a pane.
//
// The hooks here deal the game, keep the best time and open the pane;
// board.ts, a surface module, plays it. No hook touches what the model
// reads: there is no prompt, tool or attachment hook in this mod.
//
// The host reads on(...) and $.noun.method(...) from source, so they are
// spelled literally, and helpers that take $ are top-level functions here.

import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { BoardProps } from './board'
import { CHROME_ROWS, betterBest, bestOf, mergeBest, messageOf, paneSize } from './lib'
import type { Act, Best, MoveType, Win } from './lib'

const PANE = 'minefield'
const BOARD = 'board'
const NO_BOARD = 'Minefield draws its board in the terminal and the desktop app only. In VS Code, run claude in the integrated terminal.'

// A pane takes the keyboard only over an empty prompt, and a command's own
// text stays in the prompt while the command runs. These are the waits
// after /mines returns before asking for the keyboard again, each tried only
// while the pane is open and still without it.
const FOCUS_RETRIES_MS = [250, 500, 1000] as const

// The moves a control button asks the board for, at its cursor. A pane's
// hotkeys reach only buttons drawn here, not ones a surface module draws.
const CONTROLS: readonly { type: MoveType; label: string; hotkey: string; isMove: boolean }[] = [
  { type: 'new', label: 'New', hotkey: 'n', isMove: false },
  { type: 'reveal', label: 'Reveal', hotkey: 'r', isMove: false },
  { type: 'flag', label: 'Flag', hotkey: 'f', isMove: false },
  { type: 'up', label: '↑', hotkey: 'w', isMove: true },
  { type: 'left', label: '←', hotkey: 'a', isMove: true },
  { type: 'down', label: '↓', hotkey: 's', isMove: true },
  { type: 'right', label: '→', hotkey: 'd', isMove: true },
]

// Moves kept for the board, so presses faster than its redraws all arrive.
const MAX_ACTS = 32

// The game the board is asked to play, the room the pane has for it, and
// whether the screen is the fullscreen layout. In memory; the best time is
// also stored.
const state: {
  seed: number
  id: number
  best: Best
  columns: number
  rows: number
  terminalColumns: number
  isFullscreen: boolean
  acts: readonly Act[]
} = {
  seed: 0,
  id: 0,
  best: null,
  columns: 80,
  rows: 0,
  terminalColumns: 80,
  isFullscreen: false,
  acts: [],
}

// One line under the controls, for the screen the pane is on: the mouse
// exists only in the fullscreen layout, and a pane without the keyboard
// takes them back with ctrl+x tab.
function hintFor(isFocused: boolean, isFullscreen: boolean): string {
  if (!isFocused) return 'ctrl+x tab gives the pane the keys again.'
  if (isFullscreen) return 'Click reveals, right-click flags; click a fully flagged number to open around it.'
  return 'Keys only on this screen: /tui fullscreen adds the mouse.'
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      state.best = bestOf(await $.store.get('best'))
    } catch {
      // Not readable now; a win reads the store again before writing to it.
    }
    try {
      await $.command.register({
        name: 'mines',
        description: 'Play Minefield in a pane',
        immediate: true,
      })
    } catch {
      // The name is taken; nothing else opens the pane.
    }
    return result
  })

  // `/mines` deals the first game and brings back the one in play after it.
  on('command.run', { command: 'mines' }, async ($, e) => {
    const surfaces = await $.session.surfaces()
    if (!surfaces.some(drawsBoard)) return { text: NO_BOARD }
    state.isFullscreen = e.presentation.isFullscreen
    state.terminalColumns = e.presentation.columns
    if (state.id === 0) await deal($)
    await openPane($)
    focusSoon($, 0)
    return {}
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const elements = $.ui.resolve(e)
    // The surface decides; the `in` check only tells the types what it decided.
    if (!drawsBoard(e.surface) || !('Client' in elements)) return elements.Text({ children: [NO_BOARD] })
    const { Box, Text, Button, Client } = elements
    state.columns = e.props.bodyColumns
    state.rows = Math.max(0, e.props.scroll.bodyRows - CHROME_ROWS)
    if (e.viewport?.isFullscreen !== undefined) state.isFullscreen = e.viewport.isFullscreen
    if (e.viewport !== undefined) state.terminalColumns = e.viewport.columns
    const controls = CONTROLS.map((control) =>
      Button({
        key: control.type,
        label: control.label,
        hotkey: control.hotkey,
        plain: true,
        dimColor: control.isMove,
        onPress: () => {
          ask(control.type)
          $.ui.invalidate('ui.render')
        },
      }),
    )
    return Box({
      flexDirection: 'column',
      children: [
        Text({ children: [' '] }),
        Client({ key: BOARD, module: './board.ts', props: boardProps() }),
        Box({ flexDirection: 'row', columnGap: 2, children: controls }),
        Text({ dimColor: true, wrap: 'truncate-end', children: [hintFor(e.props.isFocused, state.isFullscreen)] }),
      ],
    })
  })

  // The board reports a win.
  on('ui.message', async ($, e, next) => {
    const result = await next(e)
    if (e.requestId !== PANE || e.element !== BOARD) return result
    const message = messageOf(e.data)
    if (message === null) return result
    await recordWin($, message.won)
    return { props: boardProps() }
  })
}

// The surfaces that draw a surface module and hand it the pointer.
function drawsBoard(surface: RenderSurface): boolean {
  return surface === 'terminal' || surface === 'desktop'
}

// A new game, its mines laid from the time it is dealt. Without a clock,
// the next game in line.
async function deal($: EngineInterface): Promise<void> {
  try {
    state.seed = await $.clock.now()
  } catch {
    state.seed += 1
  }
  state.id += 1
}

function ask(type: MoveType): void {
  const n = (state.acts.at(-1)?.n ?? 0) + 1
  state.acts = [...state.acts, { n, type }].slice(-MAX_ACTS)
}

function boardProps(): BoardProps {
  return {
    id: state.id,
    seed: state.seed,
    best: state.best,
    columns: state.columns,
    rows: state.rows,
    acts: state.acts,
  }
}

// Keep a win's time when it beats the record. The store is read again first,
// so a read that failed at session start never costs a stored record; when
// it cannot be read now, the time stands for this session only.
async function recordWin($: EngineInterface, win: Win): Promise<void> {
  const best = betterBest(state.best, win.seconds)
  if (best === state.best) return
  state.best = best
  try {
    const merged = mergeBest(bestOf(await $.store.get('best')), best)
    state.best = merged
    await $.store.set('best', merged)
  } catch {
    // Not stored; the time still stands for this session.
  }
}

// Open the pane, or resize the open one, to fit the board.
async function openPane($: EngineInterface): Promise<void> {
  const size = paneSize(state.terminalColumns)
  try {
    await $.ui.open({ id: PANE, title: 'Minefield', focus: true, rows: size.rows, columns: size.columns })
  } catch {
    // Refused; the pane stays as it was.
  }
  $.ui.invalidate('ui.render')
}

// Ask for the keyboard again once /mines has returned, while the pane is open
// and still without it; never reopen a pane the person has closed.
function focusSoon($: EngineInterface, attempt: number): void {
  const wait = FOCUS_RETRIES_MS[attempt]
  if (wait === undefined) return
  try {
    $.clock.after(wait, () => void refocus($, attempt))
  } catch {
    // No timer; a click on the pane gives it the keyboard.
  }
}

async function refocus($: EngineInterface, attempt: number): Promise<void> {
  try {
    const pane = (await $.ui.panes()).find((p) => p.id === PANE)
    if (pane === undefined || pane.isFocused) return
    await openPane($)
    focusSoon($, attempt + 1)
  } catch {
    // The panes cannot be listed; a click on the pane gives it the keyboard.
  }
}
