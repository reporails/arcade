// minefield: the game itself. Pure functions over plain data, so the hooks
// module, the board and the tests share them. A game is JSON all the way down.

export type LevelName = 'beginner' | 'intermediate' | 'expert'

export type Level = {
  label: string
  hotkey: string
  cols: number
  rows: number
  mines: number
}

export const LEVELS: Readonly<Record<LevelName, Level>> = {
  beginner: { label: 'Beginner', hotkey: 'b', cols: 9, rows: 9, mines: 10 },
  intermediate: { label: 'Intermediate', hotkey: 'i', cols: 16, rows: 16, mines: 40 },
  expert: { label: 'Expert', hotkey: 'e', cols: 30, rows: 16, mines: 99 },
}

export const LEVEL_NAMES = Object.keys(LEVELS) as readonly LevelName[]

export const HIDDEN = 0
export const OPEN = 1
export const FLAG = 2
export const MINE = -1

export type Mark = typeof HIDDEN | typeof OPEN | typeof FLAG
export type Status = 'ready' | 'playing' | 'won' | 'lost'

export type Game = {
  id: number
  level: LevelName
  cols: number
  rows: number
  mines: number
  seed: number
  // Per cell, the mines around it, or MINE; null until the first reveal.
  // Laid once and never changed, so every later game shares the same array.
  adj: readonly number[] | null
  marks: Mark[]
  status: Status
  seconds: number
  opened: number
  flags: number
  boom: number
  cursor: { x: number; y: number }
  // The numbered move from the hooks module this game last played.
  acted: number
  isPressing: boolean
  isBlinking: boolean
  // What the face shows between moves: where it looks, where its eyes sit (in
  // half cells), where its mouth sits, and what it is reacting to.
  gaze: Gaze
  eyesAt: number
  mouthAt: number
  reaction: Reaction | null
}

// Following the cursor, straight out at the player, glancing left at the
// transcript beside the pane, or reading it line by line.
export type Gaze = 'cursor' | 'player' | 'left' | 'reading'

// A moment's expression: a gasp at a reveal, delight at a big opening or a
// win, a wink at a flag.
export type Reaction = 'gasp' | 'delight' | 'wink'

// The face's own clock, kept beside the game: the gaze from one beat until
// another, the eyes' position on each beat of a read, the beats its eyes are
// shut on next, and a reaction until a beat.
export type Mood = {
  gaze: Gaze
  since: number
  until: number
  path: readonly number[]
  blinks: readonly number[]
  reaction: Reaction | null
  reactUntil: number
}

// Seconds per level name. A plain string-keyed record, so it travels as JSON.
export type Best = Readonly<Record<string, number>>

export type MoveType = 'up' | 'down' | 'left' | 'right' | 'reveal' | 'flag' | 'new'

// A move a control button asked for, numbered so each is played once.
export type Act = { n: number; type: MoveType }

export type Style = {
  color?: string
  backgroundColor?: string
  bold?: boolean
  dimColor?: boolean
}

export type Run = { text: string; style: Style }

export type Win = { level: LevelName; seconds: number }

// What the board reports to the hooks module. A later post in the same frame
// replaces an earlier one, so every post carries the latest win as well:
// recording a win twice is harmless, losing one is not.
export type Message = { won: Win | null; level: LevelName | null }

const MAX_SECONDS = 5999
// Seven and eight in the theme's own text and inactive shades, so they show
// on a light theme as on a dark one.
const NUMBER_COLORS = [undefined, 'blue', 'green', 'red', 'magenta', 'yellow', 'cyan', 'text', 'inactive']
// Claude Code's own theme key for its orange, so the face follows the theme.
const FACE_COLOR = 'claude'
const FACE_INK = 'black'
export const FACE_WIDTH = 9

// A small seeded generator (mulberry32): the same seed deals the same board.
export function randomOf(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function isLevelName(value: unknown): value is LevelName {
  return typeof value === 'string' && Object.hasOwn(LEVELS, value)
}

export function levelOf(name: unknown): LevelName {
  return isLevelName(name) ? name : 'beginner'
}

// A board with no mines yet: they are laid at the first reveal, around it.
export function newGame(levelName: unknown, seed: number, id = 0): Game {
  const level = levelOf(levelName)
  const { cols, rows, mines } = LEVELS[level]
  return {
    id,
    level,
    cols,
    rows,
    mines,
    seed: seed >>> 0,
    adj: null,
    marks: new Array<Mark>(cols * rows).fill(HIDDEN),
    status: 'ready',
    seconds: 0,
    opened: 0,
    flags: 0,
    boom: -1,
    cursor: { x: cols >> 1, y: rows >> 1 },
    acted: 0,
    isPressing: false,
    isBlinking: false,
    gaze: 'player',
    eyesAt: EYES.centre,
    mouthAt: MOUTH,
    reaction: null,
  }
}

// The same level again on the next seed.
export function again(game: Game): Game {
  return { ...newGame(game.level, game.seed + 1, game.id), acted: game.acted }
}

export function neighbours(cols: number, rows: number, i: number): number[] {
  const x = i % cols
  const y = (i - x) / cols
  const out: number[] = []
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx
      const ny = y + dy
      if ((dx !== 0 || dy !== 0) && nx >= 0 && nx < cols && ny >= 0 && ny < rows) out.push(ny * cols + nx)
    }
  }
  return out
}

function swap(items: number[], i: number, j: number): void {
  const a = items[i]
  const b = items[j]
  if (a === undefined || b === undefined) return
  items[i] = b
  items[j] = a
}

// Per cell, the mines around it, or MINE. The first cell and the cells
// around it stay clear, so the first reveal always opens an area.
export function layout(cols: number, rows: number, mines: number, seed: number, first: number): number[] {
  const clear = new Set([first, ...neighbours(cols, rows, first)])
  const free: number[] = []
  for (let i = 0; i < cols * rows; i++) if (!clear.has(i)) free.push(i)
  const random = randomOf(seed)
  const count = Math.min(mines, free.length)
  for (let i = 0; i < count; i++) swap(free, i, i + Math.floor(random() * (free.length - i)))
  const placed = free.slice(0, count)
  const adj = new Array<number>(cols * rows).fill(0)
  for (const mine of placed) adj[mine] = MINE
  for (const mine of placed) {
    for (const n of neighbours(cols, rows, mine)) {
      const around = adj[n]
      if (around !== undefined && around !== MINE) adj[n] = around + 1
    }
  }
  return adj
}

function isOver(game: Game): boolean {
  return game.status === 'won' || game.status === 'lost'
}

function isInside(game: Game, i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < game.cols * game.rows
}

// Open the cells and everything an empty one leads to; a mine ends the game.
// `adj` is the game's laid mines, passed apart so a caller can lay them here.
function openCells(game: Game, adj: readonly number[], starts: readonly number[]): Game {
  const marks = game.marks.slice()
  const queue = [...starts]
  let opened = game.opened
  let boom = -1
  for (let i = queue.pop(); i !== undefined; i = queue.pop()) {
    if (marks[i] !== HIDDEN) continue
    marks[i] = OPEN
    if (adj[i] === MINE) {
      if (boom === -1) boom = i
      continue
    }
    opened += 1
    if (adj[i] === 0) queue.push(...neighbours(game.cols, game.rows, i))
  }
  const dealt = { ...game, adj, marks, opened, status: 'playing' as const }
  if (boom !== -1) return { ...dealt, boom, status: 'lost' }
  if (opened < game.cols * game.rows - game.mines) return dealt
  for (let i = 0; i < marks.length; i++) if (adj[i] === MINE) marks[i] = FLAG
  return { ...dealt, flags: game.mines, status: 'won' }
}

// On an open number with as many flags around it as it says: open the rest.
// The same game back when there is nothing to open.
function chord(game: Game, adj: readonly number[], i: number): Game {
  const count = adj[i] ?? 0
  const around = neighbours(game.cols, game.rows, i)
  const flagged = around.filter((n) => game.marks[n] === FLAG).length
  if (count <= 0 || flagged !== count) return game
  const hidden = around.filter((n) => game.marks[n] === HIDDEN)
  return hidden.length === 0 ? game : openCells(game, adj, hidden)
}

export function reveal(game: Game, i: number): Game {
  if (isOver(game) || !isInside(game, i) || game.marks[i] === FLAG) return game
  if (game.marks[i] === OPEN) return game.adj === null ? game : chord(game, game.adj, i)
  return openCells(game, game.adj ?? layout(game.cols, game.rows, game.mines, game.seed, i), [i])
}

export function toggleFlag(game: Game, i: number): Game {
  if (isOver(game) || !isInside(game, i) || game.marks[i] === OPEN) return game
  const marks = game.marks.slice()
  const isSet = marks[i] !== FLAG
  marks[i] = isSet ? FLAG : HIDDEN
  return { ...game, marks, flags: game.flags + (isSet ? 1 : -1) }
}

export function cursorIndex(game: Game): number {
  return game.cursor.y * game.cols + game.cursor.x
}

export function moveTo(game: Game, i: number): Game {
  const x = i % game.cols
  const y = (i - x) / game.cols
  return game.cursor.x === x && game.cursor.y === y ? game : { ...game, cursor: { x, y } }
}

export function move(game: Game, dx: number, dy: number): Game {
  const x = Math.max(0, Math.min(game.cols - 1, game.cursor.x + dx))
  const y = Math.max(0, Math.min(game.rows - 1, game.cursor.y + dy))
  return moveTo(game, y * game.cols + x)
}

const STEPS: Readonly<Record<'up' | 'down' | 'left' | 'right', readonly [number, number]>> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
}

// One move by name, at the cursor: what a key or a control button asks for.
export function act(game: Game, type: MoveType): Game {
  switch (type) {
    case 'up':
    case 'down':
    case 'left':
    case 'right':
      return move(game, STEPS[type][0], STEPS[type][1])
    case 'reveal':
      return reveal(game, cursorIndex(game))
    case 'flag':
      return toggleFlag(game, cursorIndex(game))
    case 'new':
      return again(game)
  }
}

// Every move newer than the last one played, in order. Presses can outrun
// the board's redraws, so one redraw may bring several. Numbers lower than
// the last one played mean the hooks module started counting again, as it
// does when the plugin reloads, so every move it lists is new. The same game
// back when there is nothing new.
export function applyActs(game: Game, acts: readonly Act[]): Game {
  const last = acts.at(-1)?.n ?? 0
  let next = last < game.acted ? { ...game, acted: 0 } : game
  for (const move of acts) {
    if (move.n > next.acted) next = { ...act(next, move.type), acted: move.n }
  }
  return next
}

// One second of play. The clock runs from the first reveal to the last.
export function tick(game: Game): Game {
  if (game.status !== 'playing' || game.seconds >= MAX_SECONDS) return game
  return { ...game, seconds: game.seconds + 1 }
}

// Two columns per cell where the pane has the room, so cells look square.
export function cellWidthFor(cols: number, columns: number): 1 | 2 {
  return columns >= cols * 2 ? 2 : 1
}

// The cell under a pointer position given in the board's own cells, or -1.
export function cellAt(game: Game, x: number, y: number, cellWidth: number, cellHeight = 1): number {
  const cx = Math.floor(x / cellWidth)
  const cy = Math.floor(y / cellHeight)
  if (x < 0 || cy < 0 || cx >= game.cols || cy >= game.rows) return -1
  return cy * game.cols + cx
}

// What a cell shows, decided once for both the classic board and the tiles.
// A lost board shows every mine: the one stepped on in red, the ones left
// unflagged, and each flag that found one as a red flag on an open cell. A
// flag that was wrong stays, faint, on an open cell, so it never reads as a
// mine.
type Shown =
  | { kind: 'boom' | 'mine' | 'found' | 'wrong' | 'hidden' | 'empty' }
  | { kind: 'flag'; isWon: boolean }
  | { kind: 'number'; count: number }

function shownAt(game: Game, i: number): Shown {
  const mark = game.marks[i]
  const count = game.adj === null ? 0 : (game.adj[i] ?? 0)
  const isMine = count === MINE
  if (game.status === 'lost') {
    if (i === game.boom) return { kind: 'boom' }
    if (isMine) return { kind: mark === FLAG ? 'found' : 'mine' }
    if (mark === FLAG) return { kind: 'wrong' }
  }
  if (mark === FLAG) return { kind: 'flag', isWon: game.status === 'won' }
  if (mark === HIDDEN) return { kind: 'hidden' }
  return count === 0 ? { kind: 'empty' } : { kind: 'number', count }
}

function numberInk(count: number): Style {
  const color = NUMBER_COLORS[count]
  return color === undefined ? { bold: true } : { color, bold: true }
}

function lookOf(game: Game, i: number): Style & { glyph: string } {
  const shown = shownAt(game, i)
  switch (shown.kind) {
    case 'boom':
      return { glyph: '*', color: 'white', backgroundColor: 'red', bold: true }
    case 'mine':
      return { glyph: '*', color: 'red' }
    case 'found':
      return { glyph: '⚑', color: 'red', bold: true }
    case 'wrong':
      return { glyph: '⚑', dimColor: true }
    case 'flag':
      return { glyph: '⚑', color: shown.isWon ? 'green' : 'red', bold: true }
    case 'hidden':
      return { glyph: '■' }
    case 'empty':
      return { glyph: '·', dimColor: true }
    case 'number':
      return { glyph: String(shown.count), ...numberInk(shown.count) }
  }
}

const STYLE_KEYS = ['color', 'backgroundColor', 'bold', 'dimColor'] as const

// The cursor lights its glyph alone, in the face's colours, so it stays one
// cell wide: lighting the cell's trailing space too drew a white block beside it.
const CURSOR_STYLE: Style = { color: FACE_INK, backgroundColor: FACE_COLOR, bold: true }

// The cursor shows only while the game can take a move, so the mine that
// ended a game is drawn as that mine.
function isCursorAt(game: Game, x: number, y: number): boolean {
  return !isOver(game) && game.cursor.x === x && game.cursor.y === y
}

function pushRun(runs: Run[], text: string, style: Style): void {
  const last = runs.at(-1)
  if (last && STYLE_KEYS.every((key) => last.style[key] === style[key])) last.text += text
  else runs.push({ text, style })
}

// One board row as runs of text that share a style.
export function rowRuns(game: Game, y: number, cellWidth: number): Run[] {
  const runs: Run[] = []
  for (let x = 0; x < game.cols; x++) {
    const { glyph, ...style } = lookOf(game, y * game.cols + x)
    const isCursor = isCursorAt(game, x, y)
    pushRun(runs, glyph, isCursor ? CURSOR_STYLE : style)
    if (cellWidth === 2) pushRun(runs, ' ', isCursor ? {} : style)
  }
  return runs
}

// How the board fits the room the pane gives it: each cell `width` columns
// by `height` rows, and the face and the status `side` by side with the board
// or under it. Two columns by one row is the classic board; from two rows a
// cell is a tile, square on screen, so a small board grows into a big pane.
export type Fit = { width: number; height: number; side: boolean }

const SCALES = [3, 2] as const
const SIDE_COLUMNS = 26
const SIDE_ROWS = 10
// The columns an inline pane's frame takes from the terminal's width.
const INLINE_FRAME = 4
const UNDER_ROWS = 5
// Claude Code's own theme keys, so the tiles follow the theme: a hidden tile
// in the shade of its inactive text, an open one in the shade it puts behind
// the person's own messages.
const TILE = 'inactive'
const OPEN_TILE = 'userMessageBackground'

// The rows a fit takes in the board's own region: the board and, under it,
// a blank row and the face's four; or, beside it, the face's column.
function rowsFor(fit: Fit, rows: number): number {
  return fit.side ? Math.max(rows * fit.height, SIDE_ROWS) : rows * fit.height + UNDER_ROWS
}

function columnsFor(fit: Fit, cols: number): number {
  return cols * fit.width + (fit.side ? SIDE_COLUMNS : 0)
}

// Every fit, biggest cells first; under the board before beside it.
const FITS: readonly Fit[] = [
  ...SCALES.flatMap((k) => [
    { width: 2 * k, height: k, side: false },
    { width: 2 * k, height: k, side: true },
  ]),
  { width: 2, height: 1, side: false },
  { width: 2, height: 1, side: true },
  { width: 1, height: 1, side: false },
  { width: 1, height: 1, side: true },
]

// The biggest fit the room holds; with the room unknown, or too small for
// any, the classic board with the face under it.
export function fitFor(cols: number, rows: number, room: { columns: number; rows: number }): Fit {
  const fit = FITS.find((f) => columnsFor(f, cols) <= room.columns && rowsFor(f, rows) <= room.rows)
  return fit ?? { width: cellWidthFor(cols, room.columns), height: 1, side: false }
}

// The fit with the fewest rows a width holds: the one a pane above the
// prompt asks for, so it takes as little of the transcript as it can.
function compactFit(cols: number, columns: number): Fit {
  const fits = FITS.filter((f) => f.height === 1 && columnsFor(f, cols) <= columns)
  return fits.find((f) => f.side) ?? fits[0] ?? { width: 1, height: 1, side: false }
}

type Tile = { glyph: string; ink: Style; fill: string }

function tileOf(game: Game, x: number, y: number): Tile {
  const shown = shownAt(game, y * game.cols + x)
  if (isCursorAt(game, x, y)) {
    const glyph = shown.kind === 'flag' ? '⚑' : shown.kind === 'number' ? String(shown.count) : ' '
    return { glyph, ink: { color: FACE_INK, bold: true }, fill: FACE_COLOR }
  }
  switch (shown.kind) {
    case 'boom':
      return { glyph: '*', ink: { color: 'white', bold: true }, fill: 'red' }
    case 'mine':
      return { glyph: '*', ink: { color: 'black', bold: true }, fill: TILE }
    case 'found':
      return { glyph: '⚑', ink: { color: 'red', bold: true }, fill: OPEN_TILE }
    case 'wrong':
      return { glyph: '⚑', ink: { dimColor: true }, fill: OPEN_TILE }
    case 'flag':
      return { glyph: '⚑', ink: { color: 'white', bold: true }, fill: shown.isWon ? 'green' : 'red' }
    case 'hidden':
      return { glyph: ' ', ink: {}, fill: TILE }
    case 'empty':
      return { glyph: ' ', ink: {}, fill: OPEN_TILE }
    case 'number':
      return { glyph: String(shown.count), ink: numberInk(shown.count), fill: OPEN_TILE }
  }
}

// The board's screen rows as runs of text that share a style. A tile is
// `width - 1` columns of colour with a gap after it, its last row a half
// block so the gap between rows is half a row, as the gap between columns is.
export function boardRows(game: Game, fit: Fit): Run[][] {
  const out: Run[][] = []
  if (fit.height === 1) {
    for (let y = 0; y < game.rows; y++) out.push(rowRuns(game, y, fit.width))
    return out
  }
  const across = fit.width - 1
  const glyphRow = Math.floor((fit.height - 1) / 2)
  const glyphAt = Math.floor(across / 2)
  for (let y = 0; y < game.rows; y++) {
    const tiles: Tile[] = []
    for (let x = 0; x < game.cols; x++) tiles.push(tileOf(game, x, y))
    for (let r = 0; r < fit.height; r++) {
      const runs: Run[] = []
      for (const { glyph, ink, fill } of tiles) {
        if (r === fit.height - 1) pushRun(runs, '▀'.repeat(across), { color: fill })
        else if (r === glyphRow) pushRun(runs, ' '.repeat(glyphAt) + glyph + ' '.repeat(across - glyphAt - 1), { ...ink, backgroundColor: fill })
        else pushRun(runs, ' '.repeat(across), { backgroundColor: fill })
        pushRun(runs, ' ', {})
      }
      out.push(runs)
    }
  }
  return out
}

// The face's clock runs on the board's beats, five a second. A move turns the
// face to the cursor, and it follows the cursor while the player is busy. Two
// seconds after the last move it looks around: straight out, at the cursor's
// side, or left at the transcript beside the pane. After six it reads that
// transcript, as far as a face can: a few lines, each followed along in three
// short steps and a jump back. It only looks; the mod sees nothing of the
// transcript. It blinks every few seconds, less often while it reads,
// sometimes twice, often as its gaze jumps.
const TRACK_BEATS = 10
const READ_AFTER = 30
const WANDER_BEATS: readonly [number, number] = [8, 20]
const STEP_BEATS: readonly [number, number] = [1, 2]
const LINES: readonly [number, number] = [2, 4]
const BLINK_GAPS: Readonly<Record<'track' | 'wander' | 'read', readonly [number, number]>> = {
  track: [20, 40],
  wander: [12, 30],
  read: [30, 50],
}
const DOUBLE_BLINK = 0.2
const BLINK_ON_JUMP = 0.3
const BLINK_ON_RETURN = 0.3
const REACT_BEATS: Readonly<Record<Reaction, number>> = { gasp: 2, delight: 3, wink: 2 }
const BIG_OPENING = 10

// Where the eyes sit, in half cells from the face's left edge: the left eye
// there, the right one four cells on. The mouth's column, and how far it
// leans after the eyes.
const EYES = { left: 2, centre: 4, right: 6 } as const
const MOUTH = 4

function between(random: () => number, [lo, hi]: readonly [number, number]): number {
  return lo + Math.floor(random() * (hi - lo + 1))
}

function blinksFrom(at: number, random: () => number): readonly number[] {
  return random() < DOUBLE_BLINK ? [at, at + 2] : [at]
}

// The face as the board appears: looking at the player.
export function firstMood(n: number, random: () => number): Mood {
  return {
    gaze: 'player',
    since: n,
    until: n + TRACK_BEATS,
    path: [],
    blinks: [n + between(random, BLINK_GAPS.wander)],
    reaction: null,
    reactUntil: n,
  }
}

function wander(mood: Mood, n: number, random: () => number): Mood {
  const r = random()
  const gaze: Gaze = r < 0.5 ? 'player' : r < 0.7 ? 'cursor' : 'left'
  return { ...mood, gaze, since: n, until: n + between(random, WANDER_BEATS), path: [] }
}

// A few lines, each looked along in three steps of a beat or two, then a
// jump back to the next line's start, now and then with a blink.
function read(mood: Mood, n: number, random: () => number): Mood {
  const path: number[] = []
  const blinks: number[] = []
  const lines = between(random, LINES)
  for (let line = 0; line < lines; line++) {
    for (const at of [EYES.left, EYES.left + 1, EYES.left + 2]) {
      for (let beat = between(random, STEP_BEATS); beat > 0; beat--) path.push(at)
    }
    if (random() < BLINK_ON_RETURN) blinks.push(n + path.length)
    path.push(EYES.left)
  }
  return { ...mood, gaze: 'reading', since: n, until: n + path.length, path, blinks: [...mood.blinks.filter((b) => b >= n), ...blinks].sort((a, b) => a - b) }
}

function blinkGap(mood: Mood, idle: number): readonly [number, number] {
  if (mood.gaze === 'reading') return BLINK_GAPS.read
  return idle < TRACK_BEATS ? BLINK_GAPS.track : BLINK_GAPS.wander
}

// One beat of the face's clock; `heard` is the beat of the last move. The
// same mood back when nothing is due.
export function nextMood(mood: Mood, n: number, heard: number, random: () => number): Mood {
  let next = mood
  if (next.reaction !== null && n >= next.reactUntil) next = { ...next, reaction: null }
  const idle = n - heard
  if (n >= next.until) {
    const before = next.gaze
    if (idle < TRACK_BEATS) next = { ...next, gaze: 'cursor', since: before === 'cursor' ? next.since : n, until: heard + TRACK_BEATS, path: [] }
    else if (idle >= READ_AFTER && before !== 'reading') next = read(next, n, random)
    else next = wander(next, n, random)
    if (next.gaze !== before && random() < BLINK_ON_JUMP) next = { ...next, blinks: [n, ...next.blinks.filter((b) => b > n)] }
  }
  const last = next.blinks.at(-1)
  if (last === undefined || n > last) next = { ...next, blinks: blinksFrom(n + between(random, blinkGap(next, idle)), random) }
  return next
}

// A move: the face turns to the cursor and follows it.
export function attend(mood: Mood, n: number): Mood {
  if (mood.gaze === 'cursor' && mood.until >= n + TRACK_BEATS) return mood
  return { ...mood, gaze: 'cursor', since: mood.gaze === 'cursor' ? mood.since : n, until: n + TRACK_BEATS, path: [] }
}

export function react(mood: Mood, n: number, reaction: Reaction): Mood {
  return { ...mood, reaction, reactUntil: n + REACT_BEATS[reaction] }
}

// What a move deserves: delight at a win or a big opening, a gasp at any
// other reveal, a wink at a new flag.
export function reactionTo(before: Game, after: Game): Reaction | null {
  if (after.status === 'won' && before.status !== 'won') return 'delight'
  if (after.id !== before.id || after.seed !== before.seed) return null
  if (after.opened - before.opened >= BIG_OPENING) return 'delight'
  if (after.opened > before.opened) return 'gasp'
  if (after.flags > before.flags) return 'wink'
  return null
}

function eyesFor(game: Game, mood: Mood, n: number): number {
  switch (mood.gaze) {
    case 'player':
      return EYES.centre
    case 'left':
      return EYES.left
    case 'reading':
      return mood.path[n - mood.since] ?? EYES.left
    case 'cursor': {
      const third = game.cols / 3
      if (game.cursor.x < third) return EYES.left
      return game.cursor.x >= game.cols - third ? EYES.right : EYES.centre
    }
  }
}

// What the game shows of the mood on beat n: the same game when nothing shows.
// The mouth leans after the eyes a beat later, as a head follows a glance.
export function looks(game: Game, mood: Mood, n: number): Game {
  const isBlinking = mood.blinks.includes(n)
  const eyesAt = eyesFor(game, mood, n)
  const leaning = mood.gaze === 'reading' || eyesAt < EYES.centre ? MOUTH - 1 : eyesAt > EYES.centre ? MOUTH + 1 : MOUTH
  const mouthAt = eyesAt === game.eyesAt ? leaning : game.mouthAt
  const reaction = mood.reaction !== null && n < mood.reactUntil ? mood.reaction : null
  if (game.gaze === mood.gaze && game.eyesAt === eyesAt && game.mouthAt === mouthAt && game.isBlinking === isBlinking && game.reaction === reaction) return game
  return { ...game, gaze: mood.gaze, eyesAt, mouthAt, isBlinking, reaction }
}

function placed(glyph: string, at: number): string {
  return (' '.repeat(at) + glyph).padEnd(FACE_WIDTH)
}

// Two eyes four cells apart, the left one on the cell `at` half cells in.
function eyePair(at: number, left: string, right: string): string {
  return placed(left + '   ' + right, Math.floor(at / 2))
}

// Half-shut eyes looking down along a line: a lower half block on a whole
// cell, or two quarter blocks halfway between two cells.
function lidded(at: number): string {
  const cells = new Array<string>(FACE_WIDTH).fill(' ')
  for (const eye of [at, at + 8]) {
    const cell = Math.floor(eye / 2)
    if (eye % 2 === 0) cells[cell] = '▄'
    else {
      cells[cell] = '▗'
      cells[cell + 1] = '▖'
    }
  }
  return cells.join('')
}

// The face's two inner rows, each FACE_WIDTH wide: crosses and a flat
// mouth for a lost game, delight and then sunglasses for a won one, wide eyes
// at a reveal. Otherwise dot eyes where the gaze puts them, half shut while
// reading, shut on a blink.
export function faceOf(game: Game): { eyes: string; mouth: string } {
  if (game.status === 'lost') return { eyes: '  x   x  ', mouth: '    —    ' }
  if (game.status === 'won') {
    return game.reaction === 'delight' ? { eyes: '  ^   ^  ', mouth: placed('ω', MOUTH) } : { eyes: ' ▀██▀██▀ ', mouth: '  ╰───╯  ' }
  }
  if (game.isPressing || game.reaction === 'gasp') return { eyes: '  O   O  ', mouth: '    o    ' }
  if (game.reaction === 'delight') return { eyes: '  ^   ^  ', mouth: placed('ω', MOUTH) }
  const mouth = placed('ω', game.mouthAt)
  if (game.reaction === 'wink') return { eyes: eyePair(game.eyesAt, '─', '●'), mouth }
  if (game.isBlinking) return { eyes: eyePair(game.eyesAt, '─', '─'), mouth }
  if (game.gaze === 'reading') return { eyes: lidded(game.eyesAt), mouth }
  return { eyes: eyePair(game.eyesAt, '●', '●'), mouth }
}

// The face as four rows of styled text, like a board row's runs.
export function faceRows(game: Game): Run[] {
  const { eyes, mouth } = faceOf(game)
  const edge: Style = { color: FACE_COLOR }
  const inner: Style = { color: FACE_INK, backgroundColor: FACE_COLOR, bold: true }
  return [
    { text: ' ▄▄▄▄▄▄▄ ', style: edge },
    { text: eyes, style: inner },
    { text: mouth, style: inner },
    { text: ' ▀▀▀▀▀▀▀ ', style: edge },
  ]
}

export function clock(seconds: number): string {
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
}

export function statusParts(game: Game, best: Best): string[] {
  const parts = [`Mines ${game.mines - game.flags}`, `Time ${clock(game.seconds)}`]
  const record = best[game.level]
  if (record !== undefined) parts.push(`Best ${clock(record)}`)
  return parts
}

export function statusLine(game: Game, best: Best): string {
  return statusParts(game, best).join('  ·  ')
}

export function outcomeLine(game: Game, best: Best): string {
  switch (game.status) {
    case 'ready':
      return 'Reveal a cell to start; the first is safe.'
    case 'lost':
      return 'Boom! Press n to try again.'
    case 'playing':
      return `${game.cols * game.rows - game.mines - game.opened} safe cells left.`
    case 'won': {
      const record = best[game.level]
      const isBest = record === undefined || game.seconds <= record
      return `Cleared in ${clock(game.seconds)}.${isBest ? ' Best time!' : ''}`
    }
  }
}

function isSeconds(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value >= 0 && value <= MAX_SECONDS
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Best times as the store may hand them back: only known levels, whole seconds.
export function bestOf(value: unknown): Best {
  const best: Record<string, number> = {}
  if (!isRecord(value)) return best
  for (const level of LEVEL_NAMES) {
    const seconds = value[level]
    if (isSeconds(seconds)) best[level] = seconds
  }
  return best
}

// The same object when the time is no better, so a caller can tell.
export function betterBest(best: Best, level: LevelName, seconds: number): Best {
  const record = best[level]
  return record !== undefined && record <= seconds ? best : { ...best, [level]: seconds }
}

// The better time per level of two records, so a write never loses one.
export function mergeBest(a: Best, b: Best): Best {
  let merged = a
  for (const level of LEVEL_NAMES) {
    const seconds = b[level]
    if (seconds !== undefined) merged = betterBest(merged, level, seconds)
  }
  return merged
}

function winOf(value: unknown): Win | null {
  if (!isRecord(value) || !isLevelName(value.level) || !isSeconds(value.seconds)) return null
  return { level: value.level, seconds: value.seconds }
}

// What the board may post to the hooks module. It comes from code, so it is
// checked here: a post with neither a valid win nor a valid level is null.
export function messageOf(data: unknown): Message | null {
  if (!isRecord(data)) return null
  const message = { won: winOf(data.won), level: isLevelName(data.level) ? data.level : null }
  return message.won === null && message.level === null ? null : message
}

export type Asked = { level: LevelName | null; seed: number | null } | { error: string }

// `/mines [level] [seed]`, either or both, a level by any prefix of its name.
export function parseArgs(args: string | undefined): Asked {
  const asked: { level: LevelName | null; seed: number | null } = { level: null, seed: null }
  for (const word of (args ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    const level = LEVEL_NAMES.find((name) => name.startsWith(word))
    if (level) asked.level = level
    else if (/^\d{1,9}$/.test(word)) asked.seed = Number(word)
    else return { error: `Minefield does not know "${word}". Use /mines [beginner|intermediate|expert] [seed].` }
  }
  return asked
}

// The pane's own rows: the level buttons and a blank row above the board,
// the control buttons and a line of hints below it.
export const CHROME_ROWS = 4

// A docked pane opens to the columns it asks for, floor to ceiling, and a
// pane above the prompt to the rows it asks for, across the terminal; each
// ignores the other. Docked, it asks for room to grow a small board into
// tiles. Above the prompt it asks for the rows of the most compact fit the
// terminal's width holds, the face beside the board where it can be.
export function paneSize(levelName: unknown, terminalColumns: number): { rows: number; columns: number } {
  const { cols, rows } = LEVELS[levelOf(levelName)]
  const columns = Math.max(60, cols * (cols <= 16 ? 4 : 2) + 4)
  const fit = compactFit(cols, terminalColumns - INLINE_FRAME)
  return { rows: rowsFor(fit, rows) + CHROME_ROWS, columns }
}
