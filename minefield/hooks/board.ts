// minefield: the board, a surface module. It keeps the game in its local
// state, takes the pointer and the keys, and reports wins and asked-for
// levels to the hooks module.
//
// The board is drawn first, so a pointer position in the region is a board
// position: nothing above it can push the rows down.

import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

import {
  FACE_WIDTH,
  LEVELS,
  LEVEL_NAMES,
  act,
  applyActs,
  attend,
  boardRows,
  cellAt,
  faceRows,
  fitFor,
  firstMood,
  looks,
  moveTo,
  newGame,
  nextMood,
  outcomeLine,
  randomOf,
  react,
  reactionTo,
  reveal,
  statusLine,
  statusParts,
  tick,
  toggleFlag,
} from './lib'
import type { Act, Best, Fit, Game, LevelName, Mood, MoveType, Win } from './lib'

// What the hooks module hands the board: which game to deal, the best times,
// the room the pane has for it, and the moves the control buttons asked for,
// oldest first.
export type BoardProps = {
  id: number
  level: LevelName
  seed: number | null
  best: Best
  columns: number
  rows: number
  acts: readonly Act[]
}

type Surface = ClientSurface<Game>

// The keys the board takes once a click has given it the keyboard.
const KEYS: Readonly<Record<string, MoveType>> = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  w: 'up',
  s: 'down',
  a: 'left',
  d: 'right',
  k: 'up',
  j: 'down',
  h: 'left',
  l: 'right',
  return: 'reveal',
  space: 'reveal',
  ' ': 'reveal',
  r: 'reveal',
  f: 'flag',
  n: 'new',
}

const LEVEL_KEYS: Readonly<Record<string, LevelName>> = Object.fromEntries(LEVEL_NAMES.map((name) => [LEVELS[name].hotkey, name]))

const OUTCOME_COLORS: Readonly<Partial<Record<Game['status'], string>>> = { won: 'green', lost: 'red' }

const BLANK = ' '

// The board's one timer: five beats a second. The clock ticks every fifth
// beat counted from the first reveal; the face's clock runs on every beat.
const BEAT_MS = 200
const BEATS_PER_SECOND = 5

// Per instance, outside the game: none of these alone is worth a redraw.
// `latest` is the newest game, so two events in one frame build on each
// other; `beats` counts the timer; `started` is the beat of the first reveal;
// `lastWin` is the newest win, sent with every report until the next one;
// `moods` is the face's clock, `heard` the beat of the last move, and
// `randoms` the face's dice, seeded from the first deal so tests can replay it.
const latest = new WeakMap<Surface, Game>()
const beats = new WeakMap<Surface, number>()
const started = new WeakMap<Surface, number>()
const lastWin = new WeakMap<Surface, Win>()
const moods = new WeakMap<Surface, Mood>()
const heard = new WeakMap<Surface, number>()
const randoms = new WeakMap<Surface, () => number>()

function randomFor(surface: Surface, seed: number): () => number {
  const known = randoms.get(surface)
  if (known !== undefined) return known
  const random = randomOf(seed ^ 0x9e3779b9)
  randoms.set(surface, random)
  return random
}

function moodOf(surface: Surface, n: number, random: () => number): Mood {
  return moods.get(surface) ?? firstMood(n, random)
}

function report(surface: Surface, level: LevelName | null): void {
  surface.post({ won: lastWin.get(surface) ?? null, level })
}

// Keep the game a change led to; start the clock on the first reveal, and
// report a win.
function settle(surface: Surface, before: Game, after: Game): void {
  latest.set(surface, after)
  surface.setState(after)
  if (before.status === 'ready' && after.status === 'playing') started.set(surface, beats.get(surface) ?? 0)
  if (after.status === 'won' && before.status !== 'won') {
    lastWin.set(surface, { level: after.level, seconds: after.seconds })
    report(surface, null)
  }
}

function step(surface: Surface, change: (game: Game) => Game): void {
  const before = latest.get(surface) ?? surface.state
  if (before === undefined) return
  const after = change(before)
  if (after !== before) settle(surface, before, after)
}

// A move by the player: play it, turn the face to the cursor, and let the
// face react to what the move did.
function moved(surface: Surface, change: (game: Game) => Game): void {
  const n = beats.get(surface) ?? 0
  step(surface, (game) => {
    const after = change(game)
    const reaction = reactionTo(game, after)
    const watching = attend(moodOf(surface, n, randomFor(surface, game.seed)), n)
    const mood = reaction === null ? watching : react(watching, n, reaction)
    moods.set(surface, mood)
    heard.set(surface, n)
    return looks(after, mood, n)
  })
}

// Left reveals, and opens around a number; right flags, as does a left click
// with ctrl or alt for a pointer with one button. The face holds its breath
// from a reveal's press to its release.
function pressed(game: Game, e: ClientPointerEvent, fit: Fit): Game {
  if (e.type === 'up') return game.isPressing ? { ...game, isPressing: false } : game
  if (e.type !== 'down') return game
  const i = cellAt(game, e.x, e.y, fit.width, fit.height)
  if (i === -1) return game
  const at = moveTo(game, i)
  if (e.button === 'right' || (e.button === 'left' && (e.ctrl || e.alt))) return toggleFlag(at, i)
  if (e.button !== 'left' && e.button !== 'middle') return at
  const after = reveal(at, i)
  return after.status === 'playing' ? { ...after, isPressing: true } : after
}

function typed(surface: Surface, e: ClientKeyEvent): void {
  if (e.ctrl || e.meta) return
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  const level = LEVEL_KEYS[key]
  if (level !== undefined) {
    report(surface, level)
    return
  }
  const type = KEYS[key]
  if (type !== undefined) moved(surface, (game) => act(game, type))
}

function beat(surface: Surface): void {
  const n = (beats.get(surface) ?? 0) + 1
  beats.set(surface, n)
  step(surface, (game) => {
    const since = n - (started.get(surface) ?? n)
    const ticked = since > 0 && since % BEATS_PER_SECOND === 0 ? tick(game) : game
    const random = randomFor(surface, game.seed)
    const mood = nextMood(moodOf(surface, n, random), n, heard.get(surface) ?? 0, random)
    moods.set(surface, mood)
    return looks(ticked, mood, n)
  })
}

function randomSeed(): number {
  return Math.floor(Math.random() * 4294967296)
}

// The newest move number the props carry, or 0.
function lastActOf(acts: readonly Act[]): number {
  return acts.at(-1)?.n ?? 0
}

const Minefield: ClientModule<BoardProps, Game> = (props, surface) => {
  const { Box, Text } = surface.elements

  // A new deal from the hooks module (another level, another seed) starts
  // over; each move a control button asked for is played once, in order.
  let game = latest.get(surface) ?? surface.state
  if (game === undefined || game.id !== props.id) {
    const isFirst = game === undefined
    game = { ...newGame(props.level, props.seed ?? randomSeed(), props.id), acted: lastActOf(props.acts) }
    latest.set(surface, game)
    started.delete(surface)
    surface.setState(game)
    if (isFirst) surface.every(BEAT_MS, () => beat(surface))
  } else if (lastActOf(props.acts) !== game.acted) {
    moved(surface, (g) => applyActs(g, props.acts))
    game = latest.get(surface) ?? game
  }

  // The board grows into the room it has; the face and the status go under it
  // or, where rows are short, beside it.
  const fit = fitFor(game.cols, game.rows, { columns: props.columns, rows: props.rows })
  // Only a press on a cell is a move: a click on the face or the status
  // leaves the face where it was looking.
  surface.onPointer((e) => {
    const isMove = e.type === 'down' && cellAt(game, e.x, e.y, fit.width, fit.height) !== -1
    ;(isMove ? moved : step)(surface, (g) => pressed(g, e, fit))
  })
  surface.onKey((e) => typed(surface, e))

  const board = boardRows(game, fit).map((runs) =>
    Box({ flexDirection: 'row', flexShrink: 0, children: runs.map((run) => Text({ ...run.style, children: [run.text] })) }),
  )

  const outcomeColor = OUTCOME_COLORS[game.status]
  const outcomeStyle = outcomeColor === undefined ? { dimColor: true } : { color: outcomeColor }

  // The face's column keeps its width, so long text beside it is cut and the
  // face is not.
  const face = faceRows(game).map((row) => Text({ ...row.style, wrap: 'truncate-end', children: [row.text] }))
  const faceColumn = Box({ flexDirection: 'column', width: FACE_WIDTH, flexShrink: 0, children: face })

  if (fit.side) {
    return Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [
        Box({ flexDirection: 'column', flexShrink: 0, children: board }),
        Box({
          flexDirection: 'column',
          flexShrink: 1,
          children: [
            faceColumn,
            Text({ children: [BLANK] }),
            ...statusParts(game, props.best).map((part) => Text({ bold: true, wrap: 'truncate-end', children: [part] })),
            Text({ ...outcomeStyle, wrap: 'wrap', children: [outcomeLine(game, props.best)] }),
          ],
        }),
      ],
    })
  }

  const lines = [
    Text({ children: [BLANK] }),
    Text({ bold: true, wrap: 'truncate-end', children: [statusLine(game, props.best)] }),
    Text({ ...outcomeStyle, wrap: 'truncate-end', children: [outcomeLine(game, props.best)] }),
  ]

  return Box({
    flexDirection: 'column',
    children: [
      ...board,
      Text({ children: [BLANK] }),
      Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [faceColumn, Box({ flexDirection: 'column', flexShrink: 1, children: lines })],
      }),
    ],
  })
}

export default Minefield
