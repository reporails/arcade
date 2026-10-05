// doom-claude: doomgeneric's platform layer for a Claude Code pane.
//
// No window and no terminal of its own. The engine renders into
// DG_ScreenBuffer and serves it over HTTP as the cells a Claude Code Raster
// takes (quadrant blocks, two by two pixels a cell), and takes keys the same
// way. It listens on a Unix socket (--socket PATH, Linux and macOS) or on
// 127.0.0.1 (--port N, 0 for any free port; Windows), where every request
// must carry the X-Doom-Token header with the DOOM_CLAUDE_TOKEN the engine was
// started with. Once it listens it prints one line to stdout,
// `doom-claude listening` or `doom-claude listening port=N`. The mod
// (hooks/register.js) talks to it with $.http.fetch.
//
//   GET /frame?c=COLS&r=ROWS&since=N  200, base64 cells and an X-Frame header;
//                                     204 when frame N is still the newest
//   GET /image?since=N                 200 once the newest frame is written to
//                                     the --image file (320x200 raw RGB) with
//                                     an X-Frame header; 204 as /frame
//   GET /key?k=CODE[,CODE...]         presses; each release follows on its own
//   GET /stick?t=TURN&f=FORWARD&b=BUTTONS
//                                     the pointer's stick: turn and forward
//                                     each tic as Doom's mouse moves them, and
//                                     its buttons (1 fire, 2 strafe) held until
//                                     the next /stick says otherwise
//   GET /stats[?reset=1]              frames drawn and served, keys taken, the
//                                     longest wait between frames served, and
//                                     holds that ended while a key was down,
//                                     the keys down now, the
//                                     stick (turn, forward, buttons), the
//                                     player's facing in degrees and the
//                                     terminal's key repeat delay learnt,
//                                     and whether a menu is open
//   GET /quit                         exits
//
// A terminal sends no key-up, only a press and then its auto-repeat. So, as
// doom-cli does, a key counts as held until its next repeat is due: a press
// holds it until the first repeat could come (the terminal's repeat delay,
// learnt from the repeats it sends), each repeat for a moment more. And it
// repeats only the newest key and never says one was let go: once a
// is pressed while w is held, w goes quiet, held or not. So movement keys
// take turns: pressing one lets go of every other one at once, and a turn key
// only turns. Walking and turning together is the mouse stick's job. Fire,
// use and the rest are held on their own and let go of nothing.
//
// The mod runs the engine with $.process.spawn, which ends it when the mod
// unloads. It also exits after --idle-ms without a request, so a host that
// dies without ending it leaves nothing running for long.

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <direct.h>
#include <mmsystem.h>
typedef SOCKET sock_t;
#define BAD_SOCKET INVALID_SOCKET
#define closeSocket closesocket
#else
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>
typedef int sock_t;
#define BAD_SOCKET (-1)
#define closeSocket close
#endif

#include "d_event.h"
#include "doomkeys.h"
#include "doomgeneric.h"
#include "doomstat.h"
#include "m_controls.h"

#include <ctype.h>
#include <errno.h>
#include <math.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define MAX_COLUMNS 512
#define MAX_ROWS 256
#define REQUEST_MAX 4096
#define KEYQUEUE_SIZE 256

// Hold times. A terminal sends a press, then, after its repeat delay (500 ms
// on GNOME), a repeat every 30 ms or so, and never a release. A fresh press
// of a movement key holds until the first repeat could come (the delay learnt,
// plus DELAY_MARGIN_MS); a repeat, one inside REPEAT_GAP_MS of the last press,
// holds for REPEAT_HOLD_MS more. So a held key never stops, and a key let go
// stops a sixth of a second after its last repeat. A press while the key is
// held, about when its first repeat is due, is that repeat; any other is a new
// press (a menu moves again). Fire, use and the rest hold OTHER_HOLD_MS from a
// press, so a tap is one shot.
#define REPEAT_GAP_MS 80
#define REPEAT_HOLD_MS 160
#define OTHER_HOLD_MS 120

// The repeat delay: the median of the last DELAY_SAMPLES measured from a
// press to its first repeat, DELAY_DEFAULT_MS until one is, and never past
// DELAY_MAX_MS, so a terminal with a long delay stays playable. A first
// repeat may come up to DELAY_EARLY_MS before the delay learnt.
#define DELAY_DEFAULT_MS 500
#define DELAY_MIN_MS 150
#define DELAY_MAX_MS 600
#define DELAY_MARGIN_MS 60
#define DELAY_EARLY_MS 100
#define DELAY_SAMPLES 5
static uint32_t s_RepeatDelay = DELAY_DEFAULT_MS;
static uint32_t s_DelaySamples[DELAY_SAMPLES];
static int s_DelayCount = 0;
static int s_DelayNext = 0;

// A turn key cannot tell a tap from a hold until its repeats come, so in play
// it turns through Doom's mouse: slowly (TAP_TURN) until the terminal repeats
// it, then as fast as Doom's own arrow keys (KEY_TURN), half speed for the
// first SLOW_TURN_TICS tics as Doom ramps a held key. A tap then turns about
// as far as a quick tap does in Doom with a real keyboard (about 10 degrees),
// and a held key never stops. doom-cli names this in its own source: "just
// turn more slowly outside of state repeat ... so it's still possible to do
// some precision aiming". In a menu, the title demo or a pause the turn keys
// stay Doom's keys (a menu's sliders take left and right).
#define TAP_TURN 12
#define KEY_TURN 80
#define SLOW_TURN_TICS 6
static int s_KeyTurnTics = 0;

static int isTurnKey(int key)
{
    return key == KEY_LEFTARROW || key == KEY_RIGHTARROW;
}

static int isInPlay(void)
{
    return gamestate == GS_LEVEL && !menuactive && !demoplayback && !paused;
}

static sock_t s_ListenFd = BAD_SOCKET;
static char s_SocketPath[512];
static char s_Token[128];
static const char *s_ImagePath = NULL;
static uint32_t s_IdleMs = 30000;
static uint32_t s_LastRequest = 0;
static uint32_t s_Frame = 0;
static uint32_t s_Served = 0;
static uint32_t s_KeysTaken = 0;

// What /stats reports on pacing: the longest wait between two frames served,
// how many waits ran past 100 ms and 250 ms, and how many holds ended while
// the key was still down (a release, then the same key again within 250 ms).
static uint32_t s_LastServed = 0;
static uint32_t s_GapMax = 0;
static uint32_t s_Gaps100 = 0;
static uint32_t s_Gaps250 = 0;
static uint32_t s_Stutters = 0;

static unsigned short s_KeyQueue[KEYQUEUE_SIZE];
static unsigned int s_KeyWrite = 0;
static unsigned int s_KeyRead = 0;

typedef struct
{
    int down;
    int isRepeating;
    int isMouseTurn;    // a turn key in play, turned through Doom's mouse
    uint32_t start;     // the press that began this hold
    uint32_t prevStart; // the one before it
    uint32_t last;
    uint32_t releaseAt;
    uint32_t releasedAt;
} keystate_t;

static keystate_t s_Keys[256];

// The pointer's stick: Doom's mouse, moved by the same amount every tic while
// it is held. A pointer reports its button going up, so it is let go exactly;
// a stick no /stick has refreshed for STICK_EXPIRY_MS is let go anyway.
#define STICK_EXPIRY_MS 1500
static int s_StickTurn = 0, s_StickForward = 0, s_StickButtons = 0;
static int s_StickPosted = 0;
static uint32_t s_StickAt = 0;
static int s_IsPollStart = 1;

uint32_t DG_GetTicksMs()
{
#ifdef _WIN32
    static LARGE_INTEGER frequency;
    LARGE_INTEGER now;
    if (frequency.QuadPart == 0)
    {
        QueryPerformanceFrequency(&frequency);
    }
    QueryPerformanceCounter(&now);
    return (uint32_t)(now.QuadPart * 1000 / frequency.QuadPart);
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint32_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
#endif
}

static void queueKey(int pressed, unsigned char key)
{
    unsigned int next = (s_KeyWrite + 1) % KEYQUEUE_SIZE;
    if (next == s_KeyRead)
    {
        return; // full: drop the key rather than overwrite unread ones
    }
    s_KeyQueue[s_KeyWrite] = (unsigned short)((pressed << 8) | key);
    s_KeyWrite = next;
}

// Whether the key moves or turns the player: these take turns.
static int isMovement(int key)
{
    switch (key)
    {
    case KEY_UPARROW:
    case KEY_DOWNARROW:
    case KEY_LEFTARROW:
    case KEY_RIGHTARROW:
    case KEY_STRAFE_L:
    case KEY_STRAFE_R:
        return 1;
    default:
        return 0;
    }
}

static void releaseKey(int key, uint32_t now)
{
    keystate_t *k = &s_Keys[key];
    k->down = 0;
    k->isRepeating = 0;
    k->releasedAt = now;
    if (!k->isMouseTurn)
    {
        queueKey(0, (unsigned char)key);
    }
    k->isMouseTurn = 0;
}

static void learnDelay(uint32_t sample)
{
    if (sample < DELAY_MIN_MS || sample > 1000)
    {
        return;
    }
    s_DelaySamples[s_DelayNext] = sample;
    s_DelayNext = (s_DelayNext + 1) % DELAY_SAMPLES;
    if (s_DelayCount < DELAY_SAMPLES)
    {
        s_DelayCount++;
    }
    uint32_t sorted[DELAY_SAMPLES];
    for (int i = 0; i < s_DelayCount; i++)
    {
        int j = i;
        for (; j > 0 && sorted[j - 1] > s_DelaySamples[i]; j--)
        {
            sorted[j] = sorted[j - 1];
        }
        sorted[j] = s_DelaySamples[i];
    }
    uint32_t median = sorted[s_DelayCount / 2];
    s_RepeatDelay = median > DELAY_MAX_MS ? DELAY_MAX_MS : median;
}

static uint32_t freshHold(int key)
{
    return isMovement(key) ? s_RepeatDelay + DELAY_MARGIN_MS : OTHER_HOLD_MS;
}

static void pressKey(unsigned char key, uint32_t now)
{
    keystate_t *k = &s_Keys[key];
    if (k->down && now - k->last < REPEAT_GAP_MS)
    {
        // A repeat. The first of a run confirms that the press before it was
        // the first repeat, so the delay is from the hold's start to that.
        if (!k->isRepeating)
        {
            k->isRepeating = 1;
            learnDelay(k->last - (k->start == k->last ? k->prevStart : k->start));
        }
        k->releaseAt = now + REPEAT_HOLD_MS;
    }
    else if (k->down && !k->isRepeating && now - k->start + DELAY_EARLY_MS >= s_RepeatDelay)
    {
        // About when the first repeat is due: that repeat.
        k->releaseAt = now + REPEAT_HOLD_MS;
    }
    else
    {
        if (!k->down && k->releasedAt != 0 && now - k->releasedAt < 250)
        {
            s_Stutters++;
        }
        if (isMovement(key))
        {
            for (int other = 0; other < 256; other++)
            {
                if (other != key && s_Keys[other].down && isMovement(other))
                {
                    releaseKey(other, now);
                }
            }
        }
        if (k->down && !k->isMouseTurn)
        {
            queueKey(0, key);
        }
        k->isMouseTurn = isTurnKey(key) && isInPlay();
        if (!k->isMouseTurn)
        {
            queueKey(1, key);
        }
        k->down = 1;
        k->isRepeating = 0;
        k->prevStart = k->start;
        k->start = now;
        k->releaseAt = now + freshHold(key);
    }
    k->last = now;
}

static void releaseDueKeys(uint32_t now)
{
    for (int key = 0; key < 256; key++)
    {
        keystate_t *k = &s_Keys[key];
        if (k->down && (int32_t)(now - k->releaseAt) >= 0)
        {
            releaseKey(key, now);
        }
    }
}

// ---------------------------------------------------------------- the cells

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static size_t base64(const unsigned char *in, size_t n, char *out)
{
    size_t o = 0;
    size_t i = 0;
    for (; i + 2 < n; i += 3)
    {
        uint32_t v = (in[i] << 16) | (in[i + 1] << 8) | in[i + 2];
        out[o++] = B64[(v >> 18) & 63];
        out[o++] = B64[(v >> 12) & 63];
        out[o++] = B64[(v >> 6) & 63];
        out[o++] = B64[v & 63];
    }
    if (i < n)
    {
        uint32_t v = in[i] << 16;
        if (i + 1 < n)
        {
            v |= in[i + 1] << 8;
        }
        out[o++] = B64[(v >> 18) & 63];
        out[o++] = B64[(v >> 12) & 63];
        out[o++] = i + 1 < n ? B64[(v >> 6) & 63] : '=';
        out[o++] = '=';
    }
    return o;
}

static void putWord(unsigned char *p, uint32_t v)
{
    p[0] = v & 0xff;
    p[1] = (v >> 8) & 0xff;
    p[2] = (v >> 16) & 0xff;
    p[3] = (v >> 24) & 0xff;
}

// The screen is drawn in quadrant blocks: each cell is two by two pixels in
// two colours, and its glyph says which of the four take the foreground.
// Bit 1 is the top left, 2 the top right, 4 the bottom left, 8 the bottom
// right; 0 is all background and 15 all foreground.
static const uint32_t QUADRANTS[16] = {
    0x0020, 0x2598, 0x259D, 0x2580, 0x2596, 0x258C, 0x259E, 0x259B,
    0x2597, 0x259A, 0x2590, 0x259C, 0x2584, 0x2599, 0x259F, 0x2588,
};

// A Raster paints 1024 distinct colour pairs at once and snaps the rest to
// the nearest it has, which speckles the picture; and Claude Code's paint
// costs more the more often the colour changes from one cell to the next.
// So the screen is drawn from a palette of PALETTE_SIZE colours (32 by 32 is
// 1024 pairs, so no pair is ever snapped), made by median cut from the frame
// in view and kept for PALETTE_FRAMES frames so still parts stay the same;
// and a cell takes its left neighbour's colours when they fit it nearly as
// well (REUSE_SLACK), so a row needs fewer colour changes.
#define PALETTE_SIZE 32
#define PALETTE_FRAMES 18
#define REUSE_SLACK 1.2
#define BINS 32768

typedef struct
{
    int r, g, b;
} rgb_t;

// Doom is dark, and darker drawn in blocks: lift the shadows.
static unsigned char s_Lift[256];

// This frame's pixels (two per cell each way), their histogram over 15-bit
// colour, the palette, and which palette entry each 15-bit colour is nearest.
static rgb_t *s_Pixels = NULL;
static size_t s_PixelsSize = 0;
static uint32_t s_BinCount[BINS];
static uint32_t s_BinSum[BINS][3];
static int s_Bins[BINS];
static int s_BinTotal = 0;
static rgb_t s_Palette[PALETTE_SIZE];
static int s_PaletteAge = PALETTE_FRAMES;
static int s_PaletteColumns = 0, s_PaletteRows = 0;
static int s_PaletteSize = 0;
static int16_t s_Nearest[BINS];
static int s_SortChannel = 0;

static void initLift(void)
{
    for (int i = 0; i < 256; i++)
    {
        s_Lift[i] = (unsigned char)(pow(i / 255.0, 0.7) * 255.0 + 0.5);
    }
}

static int binOf(rgb_t c)
{
    return ((c.r >> 3) << 10) | ((c.g >> 3) << 5) | (c.b >> 3);
}

static int channelOfBin(int bin, int channel)
{
    return channel == 0 ? (bin >> 10) & 31 : channel == 1 ? (bin >> 5) & 31 : bin & 31;
}

static int compareBins(const void *a, const void *b)
{
    return channelOfBin(*(const int *)a, s_SortChannel) - channelOfBin(*(const int *)b, s_SortChannel);
}

static int distance(rgb_t a, rgb_t b)
{
    int dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
    return dr * dr * 3 + dg * dg * 4 + db * db * 2;
}

// The mean colour of the screen's pixels under one output pixel, lifted.
static rgb_t boxColor(int x0, int x1, int y0, int y1)
{
    uint32_t r = 0, g = 0, b = 0, n = 0;
    if (x1 <= x0)
    {
        x1 = x0 + 1;
    }
    if (y1 <= y0)
    {
        y1 = y0 + 1;
    }
    for (int y = y0; y < y1; y++)
    {
        const uint32_t *row = (const uint32_t *)DG_ScreenBuffer + y * DOOMGENERIC_RESX;
        for (int x = x0; x < x1; x++)
        {
            uint32_t p = row[x];
            r += (p >> 16) & 0xff;
            g += (p >> 8) & 0xff;
            b += p & 0xff;
            n++;
        }
    }
    rgb_t c = {s_Lift[r / n], s_Lift[g / n], s_Lift[b / n]};
    return c;
}

// Median cut over the histogram's occupied bins into at most `size` colours.
static void buildPalette(int size)
{
    int starts[PALETTE_SIZE], ends[PALETTE_SIZE];
    int boxes = 1;
    starts[0] = 0;
    ends[0] = s_BinTotal;
    while (boxes < size)
    {
        // Split the box whose widest channel is widest, weighted by its pixels.
        int best = -1, bestChannel = 0;
        double bestScore = 0;
        for (int i = 0; i < boxes; i++)
        {
            if (ends[i] - starts[i] < 2)
            {
                continue;
            }
            int lo[3] = {31, 31, 31}, hi[3] = {0, 0, 0};
            uint64_t weight = 0;
            for (int j = starts[i]; j < ends[i]; j++)
            {
                for (int ch = 0; ch < 3; ch++)
                {
                    int v = channelOfBin(s_Bins[j], ch);
                    lo[ch] = v < lo[ch] ? v : lo[ch];
                    hi[ch] = v > hi[ch] ? v : hi[ch];
                }
                weight += s_BinCount[s_Bins[j]];
            }
            int channel = 0;
            for (int ch = 1; ch < 3; ch++)
            {
                if (hi[ch] - lo[ch] > hi[channel] - lo[channel])
                {
                    channel = ch;
                }
            }
            double score = (double)(hi[channel] - lo[channel]) * (double)weight;
            if (score > bestScore)
            {
                bestScore = score;
                best = i;
                bestChannel = channel;
            }
        }
        if (best < 0)
        {
            break;
        }
        s_SortChannel = bestChannel;
        qsort(s_Bins + starts[best], (size_t)(ends[best] - starts[best]), sizeof(int), compareBins);
        uint64_t total = 0, half = 0;
        for (int j = starts[best]; j < ends[best]; j++)
        {
            total += s_BinCount[s_Bins[j]];
        }
        // Cut at the weighted median, leaving at least one bin on each side.
        int cut = ends[best] - 1;
        for (int j = starts[best]; j < ends[best] - 1; j++)
        {
            half += s_BinCount[s_Bins[j]];
            if (half * 2 >= total)
            {
                cut = j + 1;
                break;
            }
        }
        starts[boxes] = cut;
        ends[boxes] = ends[best];
        ends[best] = cut;
        boxes++;
    }
    for (int i = 0; i < boxes; i++)
    {
        uint64_t r = 0, g = 0, b = 0, n = 0;
        for (int j = starts[i]; j < ends[i]; j++)
        {
            int bin = s_Bins[j];
            r += s_BinSum[bin][0];
            g += s_BinSum[bin][1];
            b += s_BinSum[bin][2];
            n += s_BinCount[bin];
        }
        rgb_t c = {(int)(r / n), (int)(g / n), (int)(b / n)};
        s_Palette[i] = c;
    }
    s_PaletteSize = boxes;
    memset(s_Nearest, 0xff, sizeof s_Nearest);
}

static int nearestIndex(rgb_t c)
{
    int bin = binOf(c);
    if (s_Nearest[bin] >= 0)
    {
        return s_Nearest[bin];
    }
    int best = 0, bestDistance = distance(c, s_Palette[0]);
    for (int i = 1; i < s_PaletteSize; i++)
    {
        int d = distance(c, s_Palette[i]);
        if (d < bestDistance)
        {
            bestDistance = d;
            best = i;
        }
    }
    s_Nearest[bin] = (int16_t)best;
    return best;
}

// How far one cell's four pixels are from a pair of palette entries, each
// pixel taking the nearer; its glyph mask (pixels taking `fg`) in `mask`.
static int pairError(const rgb_t px[4], int fg, int bg, int *mask)
{
    int error = 0;
    *mask = 0;
    for (int i = 0; i < 4; i++)
    {
        int toFg = distance(px[i], s_Palette[fg]);
        int toBg = distance(px[i], s_Palette[bg]);
        if (toFg <= toBg)
        {
            *mask |= 1 << i;
            error += toFg;
        }
        else
        {
            error += toBg;
        }
    }
    return error;
}

// The best two-colour split of one cell's four pixels: its glyph mask and
// its two palette entries (the same entry twice for a one-colour cell).
static void fitCell(const rgb_t px[4], int *maskOut, int *fgOut, int *bgOut, int *errorOut)
{
    int bestMask = 15, bestFg = 0, bestBg = 0, bestError = -1;
    for (int mask = 15; mask >= 8; mask--)
    {
        rgb_t sum[2] = {{0, 0, 0}, {0, 0, 0}};
        int n[2] = {0, 0};
        for (int i = 0; i < 4; i++)
        {
            int side = (mask >> i) & 1;
            sum[side].r += px[i].r;
            sum[side].g += px[i].g;
            sum[side].b += px[i].b;
            n[side]++;
        }
        int index[2];
        for (int side = 0; side < 2; side++)
        {
            int k = n[side] > 0 ? side : 1 - side;
            rgb_t mean = {sum[k].r / n[k], sum[k].g / n[k], sum[k].b / n[k]};
            index[side] = nearestIndex(mean);
        }
        int error = 0;
        for (int i = 0; i < 4; i++)
        {
            error += distance(px[i], s_Palette[index[(mask >> i) & 1]]);
        }
        if (bestError < 0 || error < bestError)
        {
            bestError = error;
            bestMask = mask;
            bestFg = index[1];
            bestBg = index[0];
        }
    }
    if (bestFg == bestBg)
    {
        bestMask = 15;
    }
    *maskOut = bestMask;
    *fgOut = bestFg;
    *bgOut = bestBg;
    *errorOut = bestError;
}

static uint32_t colorOf(int index)
{
    return ((uint32_t)s_Palette[index].r << 16) | ((uint32_t)s_Palette[index].g << 8) | (uint32_t)s_Palette[index].b;
}

// Write every cell from this frame's pixels and the palette, row by row,
// changing the foreground or background from the cell before only where the
// picture needs it. No cell is a blank.
static void writeCells(unsigned char *raw, int columns, int rows)
{
    int width = columns * 2;
    for (int cy = 0; cy < rows; cy++)
    {
        int prevFg = -1, prevBg = -1;
        for (int cx = 0; cx < columns; cx++)
        {
            const rgb_t *top = s_Pixels + (size_t)(cy * 2) * width + cx * 2;
            const rgb_t *bottom = top + width;
            rgb_t px[4] = {top[0], top[1], bottom[0], bottom[1]};
            int mask, a, b, error;
            fitCell(px, &mask, &a, &b, &error);
            int fg, bg;
            int reuseMask;
            if (prevFg >= 0 && (a != b || (a != prevFg && a != prevBg)) &&
                pairError(px, prevFg, prevBg, &reuseMask) <= error * REUSE_SLACK + 64)
            {
                // The neighbour's colours fit nearly as well: no change at all.
                mask = reuseMask;
                fg = prevFg;
                bg = prevBg;
            }
            else if (a == b)
            {
                // One colour, as a full block: keep the background as it was.
                mask = 15;
                fg = a;
                bg = prevBg >= 0 ? prevBg : a;
            }
            else
            {
                // Two colours: the orientation that changes less.
                int keep = (a == prevFg) + (b == prevBg);
                int flip = (b == prevFg) + (a == prevBg);
                if (flip > keep)
                {
                    fg = b;
                    bg = a;
                    mask = 15 - mask;
                }
                else
                {
                    fg = a;
                    bg = b;
                }
            }
            if (mask == 0)
            {
                // Never a blank: Claude Code leaves blanks at the end of a row
                // undrawn. All background is a full block in that colour.
                mask = 15;
                fg = bg;
            }
            unsigned char *cell = raw + ((size_t)cy * columns + cx) * 12;
            putWord(cell, QUADRANTS[mask]);
            putWord(cell + 4, colorOf(fg));
            putWord(cell + 8, colorOf(bg));
            prevFg = fg;
            prevBg = bg;
        }
    }
}

// The screen as `columns * rows` Raster cells, base64.
static char *encodeCells(int columns, int rows, size_t *length)
{
    size_t cells = (size_t)columns * rows;
    size_t pixels = cells * 4;
    if (pixels > s_PixelsSize)
    {
        free(s_Pixels);
        s_Pixels = malloc(pixels * sizeof *s_Pixels);
        s_PixelsSize = s_Pixels != NULL ? pixels : 0;
    }
    unsigned char *raw = malloc(cells * 12);
    char *text = malloc(((cells * 12 + 2) / 3) * 4 + 1);
    if (s_Pixels == NULL || raw == NULL || text == NULL)
    {
        free(raw);
        free(text);
        return NULL;
    }

    int isNewPalette = s_PaletteAge >= PALETTE_FRAMES || columns != s_PaletteColumns || rows != s_PaletteRows;
    int width = columns * 2, height = rows * 2;
    if (isNewPalette)
    {
        memset(s_BinCount, 0, sizeof s_BinCount);
        memset(s_BinSum, 0, sizeof s_BinSum);
        s_BinTotal = 0;
    }
    for (int y = 0; y < height; y++)
    {
        int y0 = y * DOOMGENERIC_RESY / height, y1 = (y + 1) * DOOMGENERIC_RESY / height;
        for (int x = 0; x < width; x++)
        {
            int x0 = x * DOOMGENERIC_RESX / width, x1 = (x + 1) * DOOMGENERIC_RESX / width;
            rgb_t c = boxColor(x0, x1, y0, y1);
            s_Pixels[(size_t)y * width + x] = c;
            if (isNewPalette)
            {
                int bin = binOf(c);
                if (s_BinCount[bin]++ == 0)
                {
                    s_Bins[s_BinTotal++] = bin;
                }
                s_BinSum[bin][0] += (uint32_t)c.r;
                s_BinSum[bin][1] += (uint32_t)c.g;
                s_BinSum[bin][2] += (uint32_t)c.b;
            }
        }
    }
    if (isNewPalette)
    {
        buildPalette(PALETTE_SIZE);
        s_PaletteAge = 0;
        s_PaletteColumns = columns;
        s_PaletteRows = rows;
    }
    s_PaletteAge++;
    writeCells(raw, columns, rows);
    *length = base64(raw, cells * 12, text);
    text[*length] = '\0';
    free(raw);
    return text;
}

// ---------------------------------------------------------------- the image

#define IMAGE_WIDTH 320
#define IMAGE_HEIGHT 200

// Write the screen at Doom's own 320x200 (doomgeneric draws it doubled) as
// raw RGB to the --image file: written beside it, then renamed over it, so a
// reader never sees half a frame. 0 when written.
static int writeImage(void)
{
    static unsigned char rgb[IMAGE_WIDTH * IMAGE_HEIGHT * 3];
    for (int y = 0; y < IMAGE_HEIGHT; y++)
    {
        const uint32_t *row = (const uint32_t *)DG_ScreenBuffer + (y * DOOMGENERIC_RESY / IMAGE_HEIGHT) * DOOMGENERIC_RESX;
        unsigned char *out = rgb + (size_t)y * IMAGE_WIDTH * 3;
        for (int x = 0; x < IMAGE_WIDTH; x++)
        {
            uint32_t p = row[x * DOOMGENERIC_RESX / IMAGE_WIDTH];
            out[x * 3] = (p >> 16) & 0xff;
            out[x * 3 + 1] = (p >> 8) & 0xff;
            out[x * 3 + 2] = p & 0xff;
        }
    }
    char temp[4200];
    snprintf(temp, sizeof temp, "%s.tmp", s_ImagePath);
#ifdef _WIN32
    FILE *f = fopen(temp, "wb");
#else
    int fd = open(temp, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    FILE *f = fd >= 0 ? fdopen(fd, "wb") : NULL;
#endif
    if (f == NULL)
    {
        return -1;
    }
    size_t written = fwrite(rgb, 1, sizeof rgb, f);
    if (fclose(f) != 0 || written != sizeof rgb)
    {
        return -1;
    }
#ifdef _WIN32
    // rename() will not replace a file on Windows.
    return MoveFileExA(temp, s_ImagePath, MOVEFILE_REPLACE_EXISTING) ? 0 : -1;
#else
    return rename(temp, s_ImagePath);
#endif
}

// ---------------------------------------------------------------- the socket

static void writeAll(sock_t fd, const char *data, size_t n)
{
    while (n > 0)
    {
        int w = (int)send(fd, data, (int)n, 0);
        if (w < 0 && errno == EINTR)
        {
            continue;
        }
        if (w <= 0)
        {
            return;
        }
        data += w;
        n -= (size_t)w;
    }
}

static void respond(sock_t fd, int status, const char *headers, const char *body, size_t length)
{
    char head[256];
    const char *reason = status == 200   ? "OK"
                         : status == 204 ? "No Content"
                         : status == 400 ? "Bad Request"
                         : status == 403 ? "Forbidden"
                                         : "Not Found";
    int n = snprintf(head, sizeof head,
                     "HTTP/1.1 %d %s\r\nContent-Type: text/plain\r\nContent-Length: %lu\r\nConnection: close\r\n%s\r\n",
                     status, reason, (unsigned long)length, headers);
    writeAll(fd, head, (size_t)n);
    if (length > 0)
    {
        writeAll(fd, body, length);
    }
}

// The value of `name` in a query string, or -1.
static long queryNumber(const char *query, const char *name)
{
    size_t n = strlen(name);
    for (const char *p = query; p != NULL && *p != '\0';)
    {
        if (strncmp(p, name, n) == 0 && p[n] == '=')
        {
            return strtol(p + n + 1, NULL, 10);
        }
        p = strchr(p, '&');
        if (p != NULL)
        {
            p++;
        }
    }
    return -1;
}

// Count one frame served, and the wait since the one before.
static void countServed(void)
{
    s_Served++;
    uint32_t now = DG_GetTicksMs();
    if (s_LastServed != 0)
    {
        uint32_t gap = now - s_LastServed;
        s_GapMax = gap > s_GapMax ? gap : s_GapMax;
        s_Gaps100 += gap > 100;
        s_Gaps250 += gap > 250;
    }
    s_LastServed = now;
}

static void serveFrame(sock_t fd, const char *query)
{
    long columns = queryNumber(query, "c");
    long rows = queryNumber(query, "r");
    long since = queryNumber(query, "since");

    if (columns < 1 || columns > MAX_COLUMNS || rows < 1 || rows > MAX_ROWS)
    {
        respond(fd, 400, "", "bad size\n", 9);
        return;
    }
    if (s_Frame == 0 || (since >= 0 && (uint32_t)since == s_Frame))
    {
        respond(fd, 204, "", NULL, 0);
        return;
    }
    size_t length = 0;
    char *text = encodeCells((int)columns, (int)rows, &length);
    if (text == NULL)
    {
        respond(fd, 400, "", "no memory\n", 10);
        return;
    }
    char headers[64];
    snprintf(headers, sizeof headers, "X-Frame: %u\r\n", s_Frame);
    respond(fd, 200, headers, text, length);
    countServed();
    free(text);
}

static void serveImage(sock_t fd, const char *query)
{
    long since = queryNumber(query, "since");
    if (s_ImagePath == NULL)
    {
        respond(fd, 404, "", "no --image\n", 11);
        return;
    }
    if (s_Frame == 0 || (since >= 0 && (uint32_t)since == s_Frame))
    {
        respond(fd, 204, "", NULL, 0);
        return;
    }
    if (writeImage() != 0)
    {
        respond(fd, 400, "", "cannot write the image\n", 23);
        return;
    }
    char headers[64];
    snprintf(headers, sizeof headers, "X-Frame: %u\r\n", s_Frame);
    respond(fd, 200, headers, NULL, 0);
    countServed();
}

// An integer in the query, or `fallback` when it is not there.
static long queryInt(const char *query, const char *name, long fallback)
{
    size_t n = strlen(name);
    for (const char *p = query; p != NULL && *p != '\0';)
    {
        if (strncmp(p, name, n) == 0 && p[n] == '=')
        {
            return strtol(p + n + 1, NULL, 10);
        }
        p = strchr(p, '&');
        if (p != NULL)
        {
            p++;
        }
    }
    return fallback;
}

static long clampLong(long v, long lo, long hi)
{
    return v < lo ? lo : v > hi ? hi : v;
}

static void serveStick(sock_t fd, const char *query)
{
    s_StickTurn = (int)clampLong(queryInt(query, "t", 0), -400, 400);
    s_StickForward = (int)clampLong(queryInt(query, "f", 0), -60, 60);
    s_StickButtons = (int)clampLong(queryInt(query, "b", 0), 0, 7);
    s_StickAt = DG_GetTicksMs();
    respond(fd, 204, "", NULL, 0);
}

static void serveKeys(sock_t fd, const char *query)
{
    const char *list = strstr(query, "k=");
    uint32_t now = DG_GetTicksMs();
    for (const char *p = list ? list + 2 : NULL; p != NULL && *p != '\0' && *p != '&';)
    {
        char *end;
        long key = strtol(p, &end, 10);
        if (end == p)
        {
            break;
        }
        if (key > 0 && key < 256)
        {
            s_KeysTaken++;
            pressKey((unsigned char)key, now);
        }
        p = *end == ',' ? end + 1 : NULL;
    }
    respond(fd, 204, "", NULL, 0);
}

// Whether the request's headers carry `X-Doom-Token: <s_Token>`; always true
// when the engine has no token (a Unix socket, private to its directory).
static int hasToken(const char *request)
{
    if (s_Token[0] == '\0')
    {
        return 1;
    }
    static const char NAME[] = "\r\nx-doom-token:";
    size_t nameLength = sizeof NAME - 1;
    for (const char *p = request; *p != '\0'; p++)
    {
        size_t i = 0;
        while (i < nameLength && p[i] != '\0' && tolower((unsigned char)p[i]) == NAME[i])
        {
            i++;
        }
        if (i < nameLength)
        {
            continue;
        }
        const char *value = p + nameLength;
        while (*value == ' ' || *value == '\t')
        {
            value++;
        }
        size_t tokenLength = strlen(s_Token);
        return strncmp(value, s_Token, tokenLength) == 0 && (value[tokenLength] == '\r' || value[tokenLength] == ' ');
    }
    return 0;
}

// Blocking reads with a short timeout: an accepted socket inherits the
// listener's non-blocking mode on macOS and Windows (not on Linux).
static void prepareConnection(sock_t fd)
{
#ifdef _WIN32
    u_long isNonBlocking = 0;
    ioctlsocket(fd, FIONBIO, &isNonBlocking);
    DWORD timeout = 200;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout, sizeof timeout);
#else
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK);
    struct timeval timeout = {0, 200000};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
#endif
    // Each answer is written as its head then its body: send both at once.
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, (const char *)&one, sizeof one);
}

static void handle(sock_t fd)
{
    prepareConnection(fd);
    char request[REQUEST_MAX + 1];
    size_t n = 0;
    while (n < REQUEST_MAX)
    {
        int r = (int)recv(fd, request + n, (int)(REQUEST_MAX - n), 0);
        if (r < 0 && errno == EINTR)
        {
            continue;
        }
        if (r <= 0)
        {
            break;
        }
        n += (size_t)r;
        request[n] = '\0';
        if (strstr(request, "\r\n\r\n") != NULL)
        {
            break;
        }
    }
    request[n] = '\0';
    if (!hasToken(request))
    {
        respond(fd, 403, "", NULL, 0);
        return;
    }
    s_LastRequest = DG_GetTicksMs();

    char method[8], target[1024];
    if (sscanf(request, "%7s %1023s", method, target) != 2)
    {
        respond(fd, 400, "", NULL, 0);
        return;
    }
    char *query = strchr(target, '?');
    if (query != NULL)
    {
        *query++ = '\0';
    }
    else
    {
        query = "";
    }
    if (strcmp(target, "/frame") == 0)
    {
        serveFrame(fd, query);
    }
    else if (strcmp(target, "/image") == 0)
    {
        serveImage(fd, query);
    }
    else if (strcmp(target, "/stick") == 0)
    {
        serveStick(fd, query);
    }
    else if (strcmp(target, "/key") == 0)
    {
        serveKeys(fd, query);
    }
    else if (strcmp(target, "/stats") == 0)
    {
        releaseDueKeys(DG_GetTicksMs());
        char down[128] = "";
        size_t used = 0;
        for (int key = 0; key < 256 && used < sizeof down - 8; key++)
        {
            if (s_Keys[key].down)
            {
                used += (size_t)snprintf(down + used, sizeof down - used, "%s%d", used ? "," : "", key);
            }
        }
        // The player's facing in degrees (-1 outside a level), and the
        // repeat delay learnt.
        double angle = -1;
        if (gamestate == GS_LEVEL && players[consoleplayer].mo != NULL)
        {
            angle = players[consoleplayer].mo->angle * (360.0 / 4294967296.0);
        }
        char body[384];
        int n = snprintf(body, sizeof body, "frames=%u served=%u keys=%u gapmax=%u gaps100=%u gaps250=%u stutters=%u down=%s stick=%d,%d,%d paused=%d angle=%.1f delay=%u menu=%d\n",
                         s_Frame, s_Served, s_KeysTaken, s_GapMax, s_Gaps100, s_Gaps250, s_Stutters, down, s_StickTurn, s_StickForward, s_StickButtons, paused ? 1 : 0, angle, s_RepeatDelay, menuactive ? 1 : 0);
        respond(fd, 200, "", body, (size_t)n);
        if (queryNumber(query, "reset") == 1)
        {
            s_GapMax = s_Gaps100 = s_Gaps250 = s_Stutters = 0;
        }
    }
    else if (strcmp(target, "/quit") == 0)
    {
        respond(fd, 204, "", NULL, 0);
        closeSocket(fd);
        exit(0);
    }
    else
    {
        respond(fd, 404, "", NULL, 0);
    }
}

// Answer requests for up to `ms` milliseconds (none waited for when 0).
static void serve(uint32_t ms)
{
    uint32_t start = DG_GetTicksMs();
    for (;;)
    {
        uint32_t spent = DG_GetTicksMs() - start;
        int wait = spent >= ms ? 0 : (int)(ms - spent);
        fd_set readable;
        FD_ZERO(&readable);
        FD_SET(s_ListenFd, &readable);
        struct timeval timeout = {wait / 1000, (wait % 1000) * 1000};
        int ready = select((int)s_ListenFd + 1, &readable, NULL, NULL, &timeout);
        if (ready > 0)
        {
            sock_t fd = accept(s_ListenFd, NULL, NULL);
            if (fd != BAD_SOCKET)
            {
                handle(fd);
                closeSocket(fd);
                continue;
            }
        }
        if (DG_GetTicksMs() - s_LastRequest > s_IdleMs)
        {
            exit(0);
        }
        if (DG_GetTicksMs() - start >= ms)
        {
            return;
        }
    }
}

// ---------------------------------------------------------------- doomgeneric

// The last frame drawn, so a frame the same as it is not a new one.
static uint32_t *s_LastScreen = NULL;

void DG_Init()
{
    s_LastRequest = DG_GetTicksMs();
    s_LastScreen = calloc(DOOMGENERIC_RESX * DOOMGENERIC_RESY, sizeof *s_LastScreen);
    initLift();
}

void DG_DrawFrame()
{
    // Enter answers Doom's yes/no questions (quit, new game, nightmare), as
    // Return picks everywhere else in the menus; the mod sends Enter for y too.
    // Set at the first frame: DG_Init runs before D_DoomMain reads the config
    // file, and a saved 'y' there would otherwise win.
    static int s_IsConfirmSet = 0;
    if (!s_IsConfirmSet)
    {
        key_menu_confirm = KEY_ENTER;
        s_IsConfirmSet = 1;
    }
    size_t bytes = (size_t)DOOMGENERIC_RESX * DOOMGENERIC_RESY * sizeof *s_LastScreen;
    if (s_LastScreen == NULL || memcmp(s_LastScreen, DG_ScreenBuffer, bytes) != 0)
    {
        if (s_LastScreen != NULL)
        {
            memcpy(s_LastScreen, DG_ScreenBuffer, bytes);
        }
        s_Frame++;
    }
    serve(0);
}

void DG_SleepMs(uint32_t ms)
{
    serve(ms);
}

// Post the stick as one mouse event at the start of each poll (Doom polls
// once a tic): the turn and forward it moves this tic, and the buttons down.
// Nothing while it rests, after one event that lets its buttons go. A turn
// runs at half speed for its first SLOW_TURN_TICS tics, as Doom turns a held
// arrow key (g_game.c, SLOWTURNTICS), so the mouse turns as the keys do.
#define STICK_STRAFE 2
static int s_StickTurnTics = 0;

// The turn a held turn key adds this tic, through Doom's mouse.
static int keyTurn(void)
{
    int sign = 0;
    keystate_t *k = NULL;
    if (s_Keys[KEY_RIGHTARROW].down && s_Keys[KEY_RIGHTARROW].isMouseTurn)
    {
        sign = 1;
        k = &s_Keys[KEY_RIGHTARROW];
    }
    else if (s_Keys[KEY_LEFTARROW].down && s_Keys[KEY_LEFTARROW].isMouseTurn)
    {
        sign = -1;
        k = &s_Keys[KEY_LEFTARROW];
    }
    if (k == NULL || !isInPlay())
    {
        s_KeyTurnTics = 0;
        return 0;
    }
    if (!k->isRepeating)
    {
        s_KeyTurnTics = 0;
        return sign * TAP_TURN;
    }
    return sign * (s_KeyTurnTics++ < SLOW_TURN_TICS ? KEY_TURN / 2 : KEY_TURN);
}

static void postStick(uint32_t now)
{
    if ((s_StickTurn || s_StickForward || s_StickButtons) && now - s_StickAt > STICK_EXPIRY_MS)
    {
        s_StickTurn = s_StickForward = s_StickButtons = 0;
    }
    int fromKeys = keyTurn();
    int isMoving = s_StickTurn || s_StickForward || s_StickButtons || fromKeys;
    if (!isMoving && !s_StickPosted)
    {
        return;
    }
    int turn = s_StickTurn;
    if (turn != 0 && !(s_StickButtons & STICK_STRAFE))
    {
        turn = s_StickTurnTics < SLOW_TURN_TICS ? turn / 2 : turn;
        s_StickTurnTics++;
    }
    else
    {
        s_StickTurnTics = 0;
    }
    event_t event;
    event.type = ev_mouse;
    event.data1 = s_StickButtons;
    event.data2 = turn + fromKeys;
    event.data3 = s_StickForward;
    D_PostEvent(&event);
    s_StickPosted = isMoving;
}

int DG_GetKey(int *pressed, unsigned char *doomKey)
{
    uint32_t now = DG_GetTicksMs();
    if (s_IsPollStart)
    {
        s_IsPollStart = 0;
        postStick(now);
    }
    releaseDueKeys(now);
    if (s_KeyRead == s_KeyWrite)
    {
        s_IsPollStart = 1;
        return 0;
    }
    unsigned short data = s_KeyQueue[s_KeyRead];
    s_KeyRead = (s_KeyRead + 1) % KEYQUEUE_SIZE;
    *pressed = data >> 8;
    *doomKey = data & 0xff;
    return 1;
}

void DG_SetWindowTitle(const char *title)
{
    (void)title;
}

// ---------------------------------------------------------------- main

static void removeFiles(void)
{
    if (s_SocketPath[0] != '\0')
    {
        remove(s_SocketPath);
    }
    if (s_ImagePath != NULL)
    {
        char temp[4200];
        snprintf(temp, sizeof temp, "%s.tmp", s_ImagePath);
        remove(s_ImagePath);
        remove(temp);
    }
}

static void onSignal(int sig)
{
    (void)sig;
    exit(0);
}

static void setNonBlocking(sock_t fd)
{
#ifdef _WIN32
    u_long isNonBlocking = 1;
    ioctlsocket(fd, FIONBIO, &isNonBlocking);
#else
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
#endif
}

#ifndef _WIN32
static sock_t listenUnix(const char *path)
{
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof addr);
    addr.sun_family = AF_UNIX;
    if (strlen(path) >= sizeof addr.sun_path || strlen(path) >= sizeof s_SocketPath)
    {
        fprintf(stderr, "doom-claude: socket path too long: %s\n", path);
        return BAD_SOCKET;
    }
    strcpy(addr.sun_path, path);
    unlink(path);
    sock_t fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0 || bind(fd, (struct sockaddr *)&addr, sizeof addr) < 0 || listen(fd, 16) < 0)
    {
        fprintf(stderr, "doom-claude: cannot listen on %s: %s\n", path, strerror(errno));
        return BAD_SOCKET;
    }
    chmod(path, 0600);
    strcpy(s_SocketPath, path);
    return fd;
}
#endif

// Listen on 127.0.0.1:`port` (any free port for 0); the port taken in `bound`.
static sock_t listenTcp(int port, int *bound)
{
    sock_t fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (fd == BAD_SOCKET)
    {
        fprintf(stderr, "doom-claude: cannot open a socket\n");
        return BAD_SOCKET;
    }
#ifdef _WIN32
    // No other program may bind the same port over this one.
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&one, sizeof one);
#endif
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons((unsigned short)port);
    socklen_t length = sizeof addr;
    if (bind(fd, (struct sockaddr *)&addr, sizeof addr) != 0 || listen(fd, 16) != 0 ||
        getsockname(fd, (struct sockaddr *)&addr, &length) != 0)
    {
        fprintf(stderr, "doom-claude: cannot listen on 127.0.0.1:%d\n", port);
        closeSocket(fd);
        return BAD_SOCKET;
    }
    *bound = ntohs(addr.sin_port);
    return fd;
}

static int useDirectory(const char *dir)
{
#ifdef _WIN32
    if (_mkdir(dir) != 0 && errno != EEXIST)
    {
        return -1;
    }
    return _chdir(dir);
#else
    if (mkdir(dir, 0700) != 0 && errno != EEXIST)
    {
        return -1;
    }
    return chdir(dir);
#endif
}

static void usage(void)
{
    fprintf(stderr, "usage: doom-claude (--socket PATH | --port N) [--image FILE] [--dir DIR] [--idle-ms N] -iwad WAD [doom options]\n"
                    "       --port needs DOOM_CLAUDE_TOKEN in the environment\n");
}

int main(int argc, char **argv)
{
    const char *socketPath = NULL;
    const char *dir = NULL;
    int port = -1;
    char **doomArgv = calloc((size_t)argc + 2, sizeof *doomArgv);
    int doomArgc = 0;
    doomArgv[doomArgc++] = argv[0];
    // A fatal error prints and exits: no dialog box (zenity, a Windows
    // MessageBox) that would wait, unseen, for a click.
    doomArgv[doomArgc++] = "-nogui";
    for (int i = 1; i < argc; i++)
    {
        if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc)
        {
            socketPath = argv[++i];
        }
        else if (strcmp(argv[i], "--port") == 0 && i + 1 < argc)
        {
            port = atoi(argv[++i]);
        }
        else if (strcmp(argv[i], "--dir") == 0 && i + 1 < argc)
        {
            dir = argv[++i];
        }
        else if (strcmp(argv[i], "--image") == 0 && i + 1 < argc)
        {
            s_ImagePath = argv[++i];
        }
        else if (strcmp(argv[i], "--idle-ms") == 0 && i + 1 < argc)
        {
            s_IdleMs = (uint32_t)strtoul(argv[++i], NULL, 10);
        }
        else
        {
            doomArgv[doomArgc++] = argv[i];
        }
    }
    if ((socketPath == NULL) == (port < 0) || port > 65535)
    {
        usage();
        return 2;
    }
    if (port >= 0)
    {
        const char *token = getenv("DOOM_CLAUDE_TOKEN");
        if (token == NULL || strlen(token) < 16 || strlen(token) >= sizeof s_Token)
        {
            fprintf(stderr, "doom-claude: --port needs DOOM_CLAUDE_TOKEN (16 to 127 characters)\n");
            return 2;
        }
        strcpy(s_Token, token);
    }
    if (dir != NULL && useDirectory(dir) != 0)
    {
        fprintf(stderr, "doom-claude: cannot use %s: %s\n", dir, strerror(errno));
        return 1;
    }
#ifdef _WIN32
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0)
    {
        fprintf(stderr, "doom-claude: WSAStartup failed\n");
        return 1;
    }
    // Sleep in milliseconds, not in 15.6 ms steps: Doom's tic is 28.6 ms.
    timeBeginPeriod(1);
#endif
    int bound = 0;
    if (port >= 0)
    {
        s_ListenFd = listenTcp(port, &bound);
    }
    else
    {
#ifdef _WIN32
        fprintf(stderr, "doom-claude: --socket is not available on Windows; use --port\n");
        return 2;
#else
        s_ListenFd = listenUnix(socketPath);
#endif
    }
    if (s_ListenFd == BAD_SOCKET)
    {
        return 1;
    }
    setNonBlocking(s_ListenFd);
    atexit(removeFiles);
    signal(SIGTERM, onSignal);
    // Ctrl-C belongs to Claude Code; the mod ends the engine itself.
    signal(SIGINT, SIG_IGN);
#ifndef _WIN32
    signal(SIGHUP, onSignal);
    signal(SIGPIPE, SIG_IGN);
#endif

    if (port >= 0)
    {
        printf("doom-claude listening port=%d\n", bound);
    }
    else
    {
        printf("doom-claude listening\n");
    }
    fflush(stdout);

    doomgeneric_Create(doomArgc, doomArgv);
    for (;;)
    {
        doomgeneric_Tick();
    }
    return 0;
}
