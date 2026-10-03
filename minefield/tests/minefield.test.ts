import type { CommandRunInput, On, RenderSurface, SessionStartInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import {
  FLAG,
  HIDDEN,
  MINE,
  OPEN,
  again,
  applyActs,
  attend,
  bestOf,
  betterBest,
  boardRows,
  cellAt,
  cellWidthFor,
  clock,
  faceOf,
  firstMood,
  fitFor,
  layout,
  looks,
  mergeBest,
  messageOf,
  moveTo,
  neighbours,
  newGame,
  nextMood,
  paneSize,
  react,
  reactionTo,
  reveal,
  rowRuns,
  tick,
  toggleFlag,
} from '../hooks/lib'
import type { Game, Mood } from '../hooks/lib'

const SEED = 42
// The middle of the board, where a new game's cursor starts.
const FIRST = 4 * 9 + 4
const NO_BOARD = 'Minefield draws its board in the terminal and the desktop app only. In VS Code, run claude in the integrated terminal.'

const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }

const PANE = {
  plugin: 'minefield',
  component: 'Pane',
  requestId: 'minefield',
  viewport: { columns: 140, rows: 50 },
  props: { title: 'Minefield', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 18 }, view: {} },
} as const

// `/mines` typed at the prompt.
function mines(): CommandRunInput {
  return { command: 'mines', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }
}

type Opened = { rows: number | undefined; columns: number | undefined; closeOnEscape: true | undefined }

// Answer everything the mod asks Claude Code for. `store` is the mod's own
// store (its first read fails when `failedReads` says so), `opened` collects
// each pane the mod opens, and `pane` is what $.ui.panes() reports.
function world(
  on: On,
  {
    surfaces = ['terminal'],
    store = {},
    opened = [],
    failedReads = 0,
    pane = { isOpen: true, isFocused: false },
  }: {
    surfaces?: RenderSurface[]
    store?: Record<string, unknown>
    opened?: Opened[]
    failedReads?: number
    pane?: { isOpen: boolean; isFocused: boolean }
  } = {},
) {
  let reads = 0
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('store.get', (_$, e) => (++reads <= failedReads ? { deny: 'the store is busy' } : { value: store[e.key] }))
  on('store.set', (_$, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    opened.push({ rows: e.rows, columns: e.columns, closeOnEscape: e.closeOnEscape })
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: pane.isOpen ? [{ id: 'minefield', title: 'Minefield', isShown: true, isFocused: pane.isFocused, isPlaced: true }] : [],
  }))
  // The clock starts at SEED, so the first deal lays the board `started()` plays.
  return mock.clock(on, { now: SEED })
}

// A game on a known seed, its first cell revealed.
function started(): Game {
  return reveal(newGame(SEED), FIRST)
}

// The counts of a dealt game: the mines around each cell, or MINE.
function adjOf(game: Game): readonly number[] {
  if (game.adj === null) throw new Error('this game has no mines laid yet')
  return game.adj
}

// Every cell of a dealt game whose count passes the test.
function cellsWhere(game: Game, isWanted: (count: number, i: number) => boolean): number[] {
  return adjOf(game).flatMap((count, i) => (isWanted(count, i) ? [i] : []))
}

function firstOf(cells: readonly number[], isWanted: (i: number) => boolean = () => true): number {
  const found = cells.find(isWanted)
  if (found === undefined) throw new Error('no such cell on this board')
  return found
}

const isMine = (count: number) => count === MINE
const isSafe = (count: number) => count !== MINE

// Press on the cell at index i of a board drawn three columns a cell.
function click(board: Pick<Mounted<'terminal', 'Pane'>, 'pointer'>, i: number, button: 'left' | 'middle' | 'right' = 'left') {
  return board.pointer({ type: 'down', x: (i % 9) * 3 + 1, y: Math.floor(i / 9), button, in: 'board' })
}

test('the first reveal is safe, opens an area, and the same deal lays the same board', async () => {
  const game = started()
  const adj = adjOf(game)
  expect(game.status).toBe('playing')
  expect(adj.filter(isMine).length).toBe(10)
  for (const i of [FIRST, ...neighbours(9, 9, FIRST)]) {
    expect(adj[i] === MINE).toBe(false)
    expect(game.marks[i]).toBe(OPEN)
  }
  expect(game.opened >= 9).toBe(true)
  expect(layout(9, 9, 10, SEED, FIRST)).toEqual(adj)
  expect(layout(9, 9, 10, SEED + 1, FIRST)).not.toEqual(adj)
})

test('every number counts the mines around its cell', async () => {
  const adj = layout(9, 9, 10, 7, 0)
  expect(adj.filter(isMine).length).toBe(10)
  adj.forEach((count, i) => {
    if (count !== MINE) expect(count).toBe(neighbours(9, 9, i).filter((n) => adj[n] === MINE).length)
  })
})

test('a flag holds a cell closed and counts against the mines', async () => {
  const game = started()
  const mine = firstOf(cellsWhere(game, isMine))
  const flagged = toggleFlag(game, mine)
  expect(flagged.flags).toBe(1)
  expect(flagged.marks[mine]).toBe(FLAG)
  expect(reveal(flagged, mine)).toBe(flagged)
  expect(toggleFlag(flagged, mine).marks[mine]).toBe(HIDDEN)
  // An open cell takes no flag
  expect(toggleFlag(game, FIRST)).toBe(game)
})

test('revealing a mine loses, and a lost game takes no more moves', async () => {
  const game = started()
  const mine = firstOf(cellsWhere(game, isMine))
  const lost = reveal(game, mine)
  expect(lost.status).toBe('lost')
  expect(lost.boom).toBe(mine)
  expect(reveal(lost, 0)).toBe(lost)
  expect(toggleFlag(lost, 0)).toBe(lost)
  expect(tick(lost)).toBe(lost)
})

test('revealing every safe cell wins and flags the mines', async () => {
  let game = started()
  for (const i of cellsWhere(game, isSafe)) game = reveal(game, i)
  const won = game
  expect(won.status).toBe('won')
  expect(won.opened).toBe(71)
  expect(won.flags).toBe(10)
  expect(cellsWhere(won, isMine).every((i) => won.marks[i] === FLAG)).toBe(true)
})

test('a number with its flags set opens the cells around it', async () => {
  const game = started()
  const adj = adjOf(game)
  // An open number next to a hidden safe cell
  const number = firstOf(
    cellsWhere(game, (count, i) => count > 0 && game.marks[i] === OPEN),
    (i) => neighbours(9, 9, i).some((n) => game.marks[n] === HIDDEN && adj[n] !== MINE),
  )
  const around = neighbours(9, 9, number)

  // Without its flags a number opens nothing
  expect(reveal(game, number)).toBe(game)

  let flagged = game
  for (const i of around) if (adj[i] === MINE) flagged = toggleFlag(flagged, i)
  const opened = reveal(flagged, number)
  expect(opened.status === 'lost').toBe(false)
  expect(around.every((i) => opened.marks[i] !== HIDDEN)).toBe(true)

  // The count right but a flag on the wrong cell: the mine left open ends it
  const mine = firstOf(around, (i) => adj[i] === MINE)
  const safe = firstOf(around, (i) => game.marks[i] === HIDDEN && adj[i] !== MINE)
  let wrong = toggleFlag(game, safe)
  for (const i of around) if (adj[i] === MINE && i !== mine) wrong = toggleFlag(wrong, i)
  expect(reveal(wrong, number).status).toBe('lost')
})

test('the cursor lights its own glyph and nothing beside it', async () => {
  const ready = newGame(SEED)
  const runs = rowRuns(ready, 4)
  const lit = runs.filter((run) => run.style.backgroundColor !== undefined)
  expect(lit).toEqual([{ text: '■', style: { color: 'black', backgroundColor: 'claude', bold: true } }])
  // The row keeps its width: a glyph a cell
  expect(runs.map((run) => run.text).join('').length).toBe(9)
  // Rows without the cursor light nothing
  expect(rowRuns(ready, 0).every((run) => run.style.backgroundColor === undefined)).toBe(true)

  // Once the game is over there is no cursor, so the mine that ended it shows as that mine
  const game = started()
  const mine = firstOf(cellsWhere(game, isMine))
  const lost = reveal(moveTo(game, mine), mine)
  const row = rowRuns(lost, Math.floor(mine / 9))
  expect(row.filter((run) => run.style.backgroundColor !== undefined)).toEqual([{ text: '*', style: { color: 'white', backgroundColor: 'red', bold: true } }])
})

test('a lost board shows every mine, a right flag in red and a wrong one faint, both on open cells', async () => {
  const game = started()
  const mines = cellsWhere(game, isMine)
  const safe = firstOf(cellsWhere(game, isSafe), (i) => game.marks[i] === HIDDEN)
  const right = firstOf(mines)
  const boom = firstOf(mines, (i) => i !== right)
  const lost = reveal(toggleFlag(toggleFlag(game, safe), right), boom)
  expect(lost.status).toBe('lost')

  const tiles = boardRows(lost, { width: 4, height: 2, side: false })
  const tileAt = (i: number) => {
    const row = tiles[2 * Math.floor(i / 9)] ?? []
    let x = 0
    for (const run of row) {
      if (4 * (i % 9) < x + run.text.length) return { glyph: run.text[4 * (i % 9) - x + 1], style: run.style }
      x += run.text.length
    }
    return undefined
  }
  // A flag that found a mine: a red flag on an open cell; a wrong one: a faint flag there
  expect(tileAt(right)).toEqual({ glyph: '⚑', style: { color: 'red', bold: true, backgroundColor: 'userMessageBackground' } })
  expect(tileAt(safe)).toEqual({ glyph: '⚑', style: { dimColor: true, backgroundColor: 'userMessageBackground' } })
  expect(tileAt(boom)?.style.backgroundColor).toBe('red')
  for (const i of mines.filter((m) => m !== right && m !== boom)) expect(tileAt(i)?.glyph).toBe('*')

  // A row a cell: the same glyphs on the bare board, only the mine that went off lit
  for (const width of [3, 2]) {
    const short = boardRows(lost, { width, height: 1, side: false })
    const cellOf = (i: number) => {
      let x = 0
      for (const run of short[Math.floor(i / 9)] ?? []) {
        if (width * (i % 9) < x + run.text.length) return { glyph: run.text[width * (i % 9) - x], style: run.style }
        x += run.text.length
      }
      return undefined
    }
    expect(cellOf(right)).toEqual({ glyph: '⚑', style: { color: 'red', bold: true } })
    expect(cellOf(safe)).toEqual({ glyph: '⚑', style: { dimColor: true } })
    expect(cellOf(boom)).toEqual({ glyph: '*', style: { color: 'white', backgroundColor: 'red', bold: true } })
    for (const i of mines.filter((m) => m !== right && m !== boom)) expect(cellOf(i)).toEqual({ glyph: '*', style: { color: 'red' } })
  }

  // The classic board draws the wrong flag faint
  const classic = rowRuns(lost, Math.floor(safe / 9))
  expect(classic.some((run) => run.text.includes('⚑') && run.style.dimColor === true)).toBe(true)
})

test('the clock runs only while a game is being played', async () => {
  const ready = newGame(SEED)
  expect(tick(ready)).toBe(ready)
  expect(tick(tick(started())).seconds).toBe(2)
  expect(clock(0)).toBe('0:00')
  expect(clock(75)).toBe('1:15')
})

test('a pointer position maps to its cell at either cell width', async () => {
  const game = newGame(SEED)
  expect(cellWidthFor(9, 100)).toBe(2)
  expect(cellWidthFor(9, 12)).toBe(1)
  expect(cellAt(game, 0, 0, 2)).toBe(0)
  expect(cellAt(game, 5, 2, 2)).toBe(20)
  expect(cellAt(game, 5, 2, 1)).toBe(23)
  expect(cellAt(game, 18, 0, 2)).toBe(-1)
  expect(cellAt(game, 0, 9, 2)).toBe(-1)
  expect(cellAt(game, -1, 0, 2)).toBe(-1)
})

test('the best time and posts are checked', async () => {
  expect(betterBest(30, 31)).toBe(30)
  expect(betterBest(30, 12)).toBe(12)
  expect(betterBest(null, 40)).toBe(40)
  expect(bestOf(30)).toBe(30)
  for (const stored of [null, -1, 1.5, 'fast', { seconds: 30 }]) expect(bestOf(stored)).toBe(null)

  const win = { seconds: 12 }
  expect(messageOf({ won: win })).toEqual({ won: win })
  expect(messageOf({ won: { seconds: -1 } })).toBe(null)
  expect(messageOf({ won: null })).toBe(null)
  expect(messageOf('won')).toBe(null)

  expect(mergeBest(5, 12)).toBe(5)
  expect(mergeBest(12, 5)).toBe(5)
  expect(mergeBest(null, 12)).toBe(12)
  expect(mergeBest(12, null)).toBe(12)
})

test('the face shows how the game is going', async () => {
  const ready = newGame(SEED)
  // A new board looks at the player: dot eyes, a small mouth
  expect(faceOf(ready)).toEqual({ eyes: '  ●   ●  ', mouth: '    ω    ' })
  // The eyes sit where the gaze puts them, and the mouth leans after them
  expect(faceOf({ ...ready, gaze: 'left', eyesAt: 2, mouthAt: 3 })).toEqual({ eyes: ' ●   ●   ', mouth: '   ω     ' })
  expect(faceOf({ ...ready, gaze: 'cursor', eyesAt: 6, mouthAt: 5 })).toEqual({ eyes: '   ●   ● ', mouth: '     ω   ' })
  // Reading, the eyes are half shut and step along half a cell at a time
  expect(faceOf({ ...ready, gaze: 'reading', eyesAt: 2 }).eyes).toBe(' ▄   ▄   ')
  expect(faceOf({ ...ready, gaze: 'reading', eyesAt: 3 }).eyes).toBe(' ▗▖  ▗▖  ')
  expect(faceOf({ ...ready, gaze: 'reading', eyesAt: 4 }).eyes).toBe('  ▄   ▄  ')
  expect(faceOf({ ...ready, isBlinking: true }).eyes).toBe('  ─   ─  ')
  // A gasp while a cell is pressed or just revealed, delight, a wink
  expect(faceOf({ ...ready, isPressing: true })).toEqual({ eyes: '  O   O  ', mouth: '    o    ' })
  expect(faceOf({ ...ready, reaction: 'gasp' }).eyes).toBe('  O   O  ')
  expect(faceOf({ ...ready, reaction: 'delight' }).eyes).toBe('  ^   ^  ')
  expect(faceOf({ ...ready, reaction: 'wink' }).eyes).toBe('  ─   ●  ')

  const game = started()
  const lost = reveal(game, firstOf(cellsWhere(game, isMine)))
  expect(faceOf(lost)).toEqual({ eyes: '  x   x  ', mouth: '    —    ' })
  // A lost face neither blinks, gasps nor reads
  expect(faceOf({ ...lost, isBlinking: true, isPressing: true, gaze: 'reading' }).eyes).toBe('  x   x  ')
  // A won face is delighted, then puts on sunglasses
  const won: Game = { ...ready, status: 'won' }
  expect(faceOf({ ...won, reaction: 'delight' }).eyes).toBe('  ^   ^  ')
  expect(faceOf(won)).toEqual({ eyes: ' ▀██▀██▀ ', mouth: '  ╰───╯  ' })
  for (const face of [faceOf(ready), faceOf(lost), faceOf(won), faceOf({ ...ready, gaze: 'reading', eyesAt: 3 })]) {
    expect([face.eyes.length, face.mouth.length]).toEqual([9, 9])
  }
})

// A die that rolls the given numbers in turn, then keeps rolling the last.
function dice(...rolls: number[]): () => number {
  let i = 0
  return () => rolls[Math.min(i++, rolls.length - 1)] ?? 0
}

test('the face follows the cursor, looks around after two seconds, reads after six, and blinks', async () => {
  const mood = firstMood(0, dice(0))
  expect(mood).toMatchObject({ gaze: 'player', since: 0, until: 10, blinks: [12] })
  // Nothing due: the same mood back
  expect(nextMood(mood, 3, 0, dice(0))).toBe(mood)

  // Within two seconds of a move it keeps following the cursor
  expect(nextMood(mood, 10, 5, dice(0.9))).toMatchObject({ gaze: 'cursor', until: 15 })
  // From two seconds it looks around: at the player, the cursor's side, or left
  expect(nextMood(mood, 10, 0, dice(0.1, 0, 0.9)).gaze).toBe('player')
  expect(nextMood(mood, 10, 0, dice(0.6, 0, 0.9)).gaze).toBe('cursor')
  expect(nextMood(mood, 10, 0, dice(0.8, 0, 0.9)).gaze).toBe('left')

  // From six seconds it reads: each line in three steps, then back to its start
  const reading = nextMood(mood, 30, 0, dice(0))
  expect(reading).toMatchObject({ gaze: 'reading', since: 30, until: 38, path: [2, 3, 4, 2, 2, 3, 4, 2] })
  // A jump of the gaze and a jump back to a line's start may each come with a blink
  expect(reading.blinks).toEqual([30, 33, 37])
  // After a read it looks around before it reads again
  expect(nextMood(reading, 38, 0, dice(0.1, 0, 0.9)).gaze).toBe('player')

  // After the last blink the next is due in a few seconds, sooner while idle, now and then twice
  expect(nextMood({ ...mood, until: 99 }, 13, 0, dice(0, 0.9)).blinks).toEqual([25])
  expect(nextMood({ ...mood, until: 99 }, 13, 0, dice(0, 0.1)).blinks).toEqual([25, 27])
  expect(nextMood({ ...mood, until: 99 }, 13, 10, dice(0, 0.9)).blinks).toEqual([33])
})

test('a move turns the face to the cursor, a move it likes gets a reaction, and the game shows the mood', async () => {
  const mood: Mood = { gaze: 'reading', since: 10, until: 18, path: [2, 3, 4, 2, 2, 3, 4, 2], blinks: [30], reaction: null, reactUntil: 0 }
  const watching = attend(mood, 20)
  expect(watching).toMatchObject({ gaze: 'cursor', since: 20, until: 30, path: [] })
  // Still following long enough: the same mood back
  expect(attend(watching, 20)).toBe(watching)
  // A reaction lasts a beat or a few
  const winking = react(watching, 20, 'wink')
  expect(winking).toMatchObject({ reaction: 'wink', reactUntil: 22 })
  expect(nextMood(winking, 22, 20, dice(0)).reaction).toBe(null)

  const game = started()
  // A new flag gets a wink, a reveal a gasp, a big opening or a win delight, a new deal nothing
  const flagged = toggleFlag(game, firstOf(cellsWhere(game, isMine)))
  expect(reactionTo(game, flagged)).toBe('wink')
  const number = firstOf(cellsWhere(game, (count, i) => count > 0 && game.marks[i] === HIDDEN))
  expect(reactionTo(game, reveal(game, number))).toBe('gasp')
  expect(reactionTo(game, { ...game, opened: game.opened + 10 })).toBe('delight')
  expect(reactionTo(game, { ...game, status: 'won' })).toBe('delight')
  expect(reactionTo(game, again(game))).toBe(null)

  const ready = newGame(SEED)
  // Reading follows its path, a position a beat
  expect(looks(ready, mood, 10)).toMatchObject({ gaze: 'reading', eyesAt: 2 })
  expect(looks(ready, mood, 11)).toMatchObject({ eyesAt: 3 })
  // The mouth leans the beat after the eyes move
  const glancing: Mood = { ...mood, gaze: 'left', path: [] }
  const glanced = looks(ready, glancing, 12)
  expect(glanced).toMatchObject({ eyesAt: 2, mouthAt: 4 })
  expect(looks(glanced, glancing, 13)).toMatchObject({ eyesAt: 2, mouthAt: 3 })
  expect(looks(ready, mood, 30)).toMatchObject({ isBlinking: true })
  // Nothing new to show: the same game back
  const settled = looks(glanced, glancing, 13)
  expect(looks(settled, glancing, 14)).toBe(settled)
})

test('the face gasps at a reveal, reads when left alone, blinks, and crosses its eyes on a mine', async ($, on) => {
  world(on)
  await $.session.start(SESSION)
  await $.command.run(mines())
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const eyes = (text: string | RegExp) => ui.find({ type: 'Text', text, in: 'board' })
  expect(await eyes('  ●   ●  ')).toBeDefined()

  await click(ui, FIRST)
  expect(await eyes('  O   O  ')).toBeDefined()
  await ui.pointer({ type: 'up', x: 8, y: 4, button: 'left', in: 'board' })
  // The opening's reaction passes, and the face follows the cursor in the middle
  await ui.advance(1000)
  expect(await eyes(/^ {2}[●─] {3}[●─] {2}$/)).toBeDefined()

  // Left alone, within a minute it reads with half-shut eyes, and blinks
  let hasRead = false
  let hasBlinked = false
  for (let beat = 0; beat < 300 && !(hasRead && hasBlinked); beat++) {
    await ui.advance(200)
    hasRead ||= (await eyes(/^ +[▄▗▖]+ +[▄▗▖]+ +$/)) !== undefined
    hasBlinked ||= (await eyes(/─ {3}─/)) !== undefined
  }
  expect([hasRead, hasBlinked]).toEqual([true, true])

  await click(ui, firstOf(cellsWhere(started(), isMine)))
  expect(await eyes('  x   x  ')).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '    —    ', in: 'board' })).toBeDefined()
})

test('the board grows into the room the pane has, with the face under it or beside it', async () => {
  // A docked pane: square tiles three rows tall, or two, where they fit
  expect(fitFor(9, 9, { columns: 60, rows: 36 })).toEqual({ width: 6, height: 3, side: false })
  expect(fitFor(9, 9, { columns: 60, rows: 25 })).toEqual({ width: 4, height: 2, side: false })
  // Short on rows: a row a cell, the face and the status beside the board where they do not fit under it
  expect(fitFor(9, 9, { columns: 100, rows: 14 })).toEqual({ width: 3, height: 1, side: false })
  expect(fitFor(9, 9, { columns: 100, rows: 12 })).toEqual({ width: 3, height: 1, side: true })
  expect(fitFor(9, 9, { columns: 50, rows: 12 })).toEqual({ width: 2, height: 1, side: true })
  // Narrow: fewer columns a cell, down to one; unknown room: a row a cell, two columns wide
  expect(fitFor(9, 9, { columns: 20, rows: 30 })).toEqual({ width: 2, height: 1, side: false })
  expect(fitFor(9, 9, { columns: 12, rows: 30 })).toEqual({ width: 1, height: 1, side: false })
  expect(fitFor(9, 9, { columns: 40, rows: 12 })).toEqual({ width: 1, height: 1, side: true })
  expect(fitFor(9, 9, { columns: 100, rows: 0 })).toEqual({ width: 2, height: 1, side: false })

  // Every cell is a tile: three columns of colour over a half-block row, a gap column after it
  const game = started()
  const rows = boardRows(game, { width: 4, height: 2, side: false })
  const texts = rows.map((runs) => runs.map((run) => run.text).join(''))
  expect(texts.length).toBe(18)
  expect(texts.filter((_, row) => row % 2 === 1).every((text) => text === '▀▀▀ '.repeat(9))).toBe(true)
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const i = y * 9 + x
      const count = adjOf(game)[i] ?? 0
      const glyph = game.marks[i] === OPEN && count > 0 ? String(count) : ' '
      expect(texts[2 * y]?.slice(4 * x, 4 * x + 4)).toBe(` ${glyph}  `)
    }
  }
  // Hidden and open tiles differ in colour, and the cursor's is the face's
  const fills = new Set(rows[0]?.map((run) => run.style.backgroundColor).filter((fill) => fill !== undefined))
  expect(fills.has('inactive') && fills.has('userMessageBackground')).toBe(true)
  expect(rows[8]?.some((run) => run.style.backgroundColor === 'claude')).toBe(true)
  // A row a cell: a hidden tile is a box short of its row, with a gap after
  // it; a number stands on the bare board, and an empty cell is bare
  const number = firstOf(cellsWhere(game, (count, i) => count > 0 && game.marks[i] === OPEN))
  for (const [width, tile] of [[3, '▆▆ '], [2, '▗▖']] as const) {
    const short = boardRows(game, { width, height: 1, side: false })
    const shortTexts = short.map((runs) => runs.map((run) => run.text).join(''))
    expect(shortTexts.length).toBe(9)
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        const i = y * 9 + x
        const count = adjOf(game)[i] ?? 0
        const shown = game.marks[i] === HIDDEN ? tile : i === FIRST ? '·' : count > 0 ? String(count) : ''
        expect(shortTexts[y]?.slice(width * x, width * x + width)).toBe(shown.padEnd(width))
      }
    }
    // The boxes in the hidden tile's colour; the cursor, on an open empty cell, lights its dot as wide as a box
    const boxes = short.flat().filter((run) => run.text.includes(tile.trim()))
    expect(new Set(boxes.map((run) => run.style.color))).toEqual(new Set(['inactive']))
    const cursor = { color: 'black', backgroundColor: 'claude', bold: true }
    expect(short.flat().filter((run) => run.style.backgroundColor !== undefined)).toEqual([{ text: '·'.padEnd(width - 1), style: cursor }])
    // On a hidden cell the cursor is the box itself, in the face's colour, so the two never look alike
    const hidden = firstOf(cellsWhere(game, (_, i) => game.marks[i] === HIDDEN))
    const onHidden = boardRows(moveTo(game, hidden), { width, height: 1, side: false })[Math.floor(hidden / 9)] ?? []
    expect(onHidden.some((run) => run.text.startsWith(tile.trim()) && run.style.color === 'claude' && run.style.backgroundColor === undefined)).toBe(true)
    // The cursor on a number lights it as wide as a box, and the gap after it stays bare
    const lit = boardRows(moveTo(game, number), { width, height: 1, side: false })[Math.floor(number / 9)]?.filter((run) => run.style.backgroundColor !== undefined)
    expect(lit).toEqual([{ text: String(adjOf(game)[number]).padEnd(width - 1), style: cursor }])
  }
  // A pointer anywhere on a tile, its gap included, is that tile's cell
  expect(cellAt(game, 13, 3, 4, 2)).toBe(12)
  expect(cellAt(game, 15, 2, 4, 2)).toBe(12)
})

test('a pane above the prompt asks for the rows of the most compact fit, a docked one for the columns to grow', async () => {
  // An 80-column terminal: three columns a cell, the face beside the board
  expect(paneSize(80)).toEqual({ rows: 14, columns: 60 })
  // Narrower: two columns a cell, the face still beside it
  expect(paneSize(50)).toEqual({ rows: 14, columns: 60 })
  // Too narrow for the face beside it: the face goes under
  expect(paneSize(30)).toEqual({ rows: 17, columns: 60 })
})

test('a big pane plays on big tiles, and the pane says how to play on the screen it is on', async ($, on) => {
  world(on)
  await $.session.start(SESSION)
  await $.command.run(mines())
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 60, scroll: { offset: 0, bodyRows: 40 } } })
  // Six columns by three rows a cell: a click on the middle of a tile reveals it
  await ui.pointer({ type: 'down', x: 4 * 6 + 2, y: 4 * 3 + 1, button: 'left', in: 'board' })
  await ui.pointer({ type: 'up', x: 4 * 6 + 2, y: 4 * 3 + 1, button: 'left', in: 'board' })
  expect(await ui.find({ type: 'Text', text: `${71 - started().opened} safe cells left.`, in: 'board' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Click reveals, right-click flags/ })).toBeDefined()
  // After the status, the maker's credit links to the reporails CLI
  expect((await ui.find({ type: 'Link', in: 'board' }))?.props).toEqual({ href: 'https://github.com/reporails/cli', label: 'By Reporails' })
  await ui.unmount()

  const unfocused = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, isFocused: false } })
  expect(await unfocused.find({ type: 'Text', text: 'ctrl+x tab gives the pane the keys again.' })).toBeDefined()
})

test('on the main screen the pane asks for few rows, says keys only, and puts the face beside the board', async ($, on) => {
  const opened: Opened[] = []
  world(on, { opened })
  await $.session.start(SESSION)
  await $.command.run({ ...mines(), presentation: { isFullscreen: false, columns: 100 } })
  expect(opened.at(-1)).toEqual({ rows: 14, columns: 60, closeOnEscape: undefined })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, scroll: { offset: 0, bodyRows: 14 } } })
  expect(await ui.find({ type: 'Text', text: 'Keys only on this screen: /tui fullscreen adds the mouse.' })).toBeDefined()
  // Beside the board, the status is a line a part
  expect(await ui.find({ type: 'Text', text: 'Mines 10', in: 'board' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Time 0:00', in: 'board' })).toBeDefined()
  // and the credit a line of its own under it
  expect((await ui.find({ type: 'Link', in: 'board' }))?.props.label).toBe('By Reporails')
  // The board fills every row its fit takes, so a pane sized to its drawing keeps the room for it
  expect(await ui.drawn({ in: 'board' })).toMatchObject({ props: { minHeight: 11 } })
})

test('/mines opens the board, and the pointer reveals and flags', async ($, on) => {
  world(on)
  await $.session.start(SESSION)
  expect(await $.command.run(mines())).toEqual({})

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Mines 10 · Time 0:00 · /, in: 'board' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Reveal a cell to start/, in: 'board' })).toBeDefined()

  await click(ui, FIRST)
  const game = started()
  expect(await ui.find({ type: 'Text', text: `${71 - game.opened} safe cells left.`, in: 'board' })).toBeDefined()

  await click(ui, firstOf(cellsWhere(game, isMine)), 'right')
  expect(await ui.find({ type: 'Text', text: /Mines 9 /, in: 'board' })).toBeDefined()

  await ui.advance(3000)
  expect(await ui.find({ type: 'Text', text: /Time 0:03/, in: 'board' })).toBeDefined()
})

test('the keys move the cursor, reveal and flag, and n deals again', async ($, on) => {
  world(on)
  await $.session.start(SESSION)
  await $.command.run(mines())
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // The cursor starts in the middle: space reveals there, as the first click would
  await ui.key({ key: ' ', in: 'board' })
  const game = started()
  expect(await ui.find({ type: 'Text', text: `${71 - game.opened} safe cells left.`, in: 'board' })).toBeDefined()

  // Walk to the top-left corner, then to a mine, and flag it
  const mine = firstOf(cellsWhere(game, isMine))
  for (let n = 0; n < 9; n++) await ui.key({ key: 'up', in: 'board' })
  for (let n = 0; n < 9; n++) await ui.key({ key: 'left', in: 'board' })
  for (let n = 0; n < Math.floor(mine / 9); n++) await ui.key({ key: 'down', in: 'board' })
  for (let n = 0; n < mine % 9; n++) await ui.key({ key: 'l', in: 'board' })
  await ui.key({ key: 'f', in: 'board' })
  expect(await ui.find({ type: 'Text', text: /Mines 9 /, in: 'board' })).toBeDefined()

  // The Flag button acts on the same cell; then return on the mine loses
  await ui.press({ key: 'flag' })
  expect(await ui.find({ type: 'Text', text: /Mines 10 /, in: 'board' })).toBeDefined()
  await ui.key({ key: 'return', in: 'board' })
  expect(await ui.find({ type: 'Text', text: /^Boom!/, in: 'board' })).toBeDefined()

  await ui.key({ key: 'n', in: 'board' })
  expect(await ui.find({ type: 'Text', text: /^Reveal a cell to start/, in: 'board' })).toBeDefined()
})

test('a win is posted, kept as the best time and stored', async ($, on) => {
  const store: Record<string, unknown> = { best: 30 }
  world(on, { store })
  await $.session.start(SESSION)
  await $.command.run(mines())
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Best 0:30/, in: 'board' })).toBeDefined()

  await click(ui, FIRST)
  await ui.advance(12000)
  for (const i of cellsWhere(started(), isSafe)) await click(ui, i)

  expect(await ui.find({ type: 'Text', text: 'Cleared in 0:12. Best time!', in: 'board' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Mines 0 .* Best 0:12/, in: 'board' })).toBeDefined()
  // Delight, then sunglasses on
  expect(await ui.find({ type: 'Text', text: '  ^   ^  ', in: 'board' })).toBeDefined()
  await ui.advance(600)
  expect(await ui.find({ type: 'Text', text: ' ▀██▀██▀ ', in: 'board' })).toBeDefined()
  expect(store.best).toBe(12)

  // The clock stopped with the game
  await ui.advance(5000)
  expect(await ui.find({ type: 'Text', text: /Time 0:12/, in: 'board' })).toBeDefined()
})

test('/mines brings the pane back and leaves the game in play as it is', async ($, on) => {
  const opened: Opened[] = []
  world(on, { opened })
  await $.session.start(SESSION)
  await $.command.run(mines())
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // The first reveal, then /mines again: the pane opens once more, the game unchanged
  await ui.key({ key: ' ', in: 'board' })
  const before = opened.length
  await $.command.run(mines())
  expect(opened.length).toBe(before + 1)
  expect(await ui.find({ type: 'Text', text: `${71 - started().opened} safe cells left.`, in: 'board' })).toBeDefined()
})

test('/mines asks for the keyboard again while the pane is open without it, and Escape never closes it', async ($, on) => {
  const opened: Opened[] = []
  const pane = { isOpen: true, isFocused: false }
  const clock = world(on, { opened, pane })
  await $.session.start(SESSION)
  await $.command.run(mines())
  expect(opened.length).toBe(1)
  await clock.advance(250)
  expect(opened.length).toBe(2)
  // Once the pane has the keyboard, no more asking
  pane.isFocused = true
  await clock.advance(5000)
  expect(opened.length).toBe(2)
  // Closing the pane ends the game, so Escape is left to hand the keys back
  expect(opened.every((o) => o.closeOnEscape === undefined && o.rows === 14 && o.columns === 60)).toBe(true)
})

test('a pane the person closed is not reopened by the focus retries', async ($, on) => {
  const opened: Opened[] = []
  const clock = world(on, { opened, pane: { isOpen: false, isFocused: false } })
  await $.session.start(SESSION)
  await $.command.run(mines())
  await clock.advance(5000)
  expect(opened.length).toBe(1)
})

test('every move newer than the last one played is played, in order, once', async () => {
  const ready = newGame(SEED)
  // Three presses that arrive in one redraw, the first one already played
  const acts = [
    { n: 1, type: 'right' },
    { n: 2, type: 'right' },
    { n: 3, type: 'down' },
    { n: 4, type: 'reveal' },
  ] as const
  const played = applyActs({ ...ready, acted: 1 }, acts)
  expect(played.cursor).toEqual({ x: 5, y: 5 })
  expect(played.acted).toBe(4)
  expect(played.marks[5 * 9 + 5]).toBe(OPEN)
  // Nothing newer: the same game back
  expect(applyActs(played, acts)).toBe(played)
  // After a reload the hooks module counts its moves from 1 again: every move it lists is new
  const reloaded = applyActs({ ...played, acted: 15 }, [{ n: 1, type: 'left' }])
  expect([reloaded.cursor, reloaded.acted]).toEqual([{ x: 4, y: 5 }, 1])
})

test('the control buttons move the cursor and reveal there', async ($, on) => {
  world(on)
  await $.session.start(SESSION)
  await $.command.run(mines())
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.find({ type: 'Text', in: 'board' })

  await ui.press({ key: 'right' })
  await ui.press({ key: 'right' })
  await ui.press({ key: 'down' })
  await ui.press({ key: 'reveal' })
  const opened = reveal(newGame(SEED), 5 * 9 + 6)
  expect(await ui.find({ type: 'Text', text: `${71 - opened.opened} safe cells left.`, in: 'board' })).toBeDefined()
})

test('the clock starts on the first reveal, not when the board appears', async ($, on) => {
  world(on)
  await $.session.start(SESSION)
  await $.command.run(mines())
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.advance(600)
  await click(ui, FIRST)
  await ui.advance(800)
  expect(await ui.find({ type: 'Text', text: /Time 0:00/, in: 'board' })).toBeDefined()
  await ui.advance(200)
  expect(await ui.find({ type: 'Text', text: /Time 0:01/, in: 'board' })).toBeDefined()
})

test('a store that could not be read at start never loses a stored record', async ($, on) => {
  const store: Record<string, unknown> = { best: 5 }
  world(on, { store, failedReads: 1 })
  await $.session.start(SESSION)
  await $.command.run(mines())
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await click(ui, FIRST)
  await ui.advance(12000)
  for (const i of cellsWhere(started(), isSafe)) await click(ui, i)

  expect(await ui.find({ type: 'Text', text: 'Cleared in 0:12.', in: 'board' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Best 0:05/, in: 'board' })).toBeDefined()
  expect(store.best).toBe(5)
})

test('where no board can draw, /mines says so', async ($, on) => {
  world(on, { surfaces: [] })
  await $.session.start(SESSION)
  expect((await $.command.run(mines())).text).toBe(NO_BOARD)
})

test('the board draws in the desktop app, and a surface without it gets a line of text', async ($, on) => {
  world(on, { surfaces: ['desktop'] })
  await $.session.start(SESSION)
  await $.command.run(mines())

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await click(desktop, FIRST)
  expect(await desktop.find({ type: 'Text', text: /safe cells left\.$/, in: 'board' })).toBeDefined()
  await desktop.unmount()

  const vscode = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await vscode.find({ type: 'Text', text: NO_BOARD })).toBeDefined()
})
