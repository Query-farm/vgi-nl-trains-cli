import { useState, useEffect, useMemo, Fragment } from 'react';
import { render, Box, Text, useApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import stringWidth from 'string-width';
import { connect, resolveStation, fetchBoard, listStations, WORKER_LOCATION } from './vgi.js';

const isTTY = !!process.stdout.isTTY;
const interactive = isTTY;
const FETCH_LIMIT = 40; // fetch generously; the view slices to what fits

// ── Responsive layout ─────────────────────────────────────────────────────────
// Everything is derived from the live terminal size so the dashboard fills the
// screen and reflows on resize. The destination column absorbs spare width; the
// two panes split the available height.
function computeLayout(columns, rows) {
  const MARKER_W = 2;
  // Fixed overhead = sidebar chrome (marker+code+border+pad = 11) + gap (1) +
  // board minus its destination content (49). The rest is split between station
  // names and the destination column, names getting ~half (capped so very wide
  // terminals don't give absurd name widths) and the destination filling the rest.
  // Leave 2 columns of slack so the row never exactly equals the terminal width
  // (at exact width Ink overflows and collapses the flex siblings).
  const budget = Math.max(18, columns - 2 - 63); // = sideName + destW
  const sideName = Math.min(28, Math.max(8, Math.round(budget * 0.5)));
  const destW = Math.max(9, budget - sideName);
  const sideGrid = 2 + 6 + 1 + sideName; // marker + 6-char code field + space + name
  const sideOuter = sideGrid + 4;
  const cols = [
    { key: 'Time', w: 5, justify: 'flex-start' },
    { key: 'In', w: 5, justify: 'flex-end' },
    { key: 'Δ', w: 3, justify: 'center' },
    { key: 'Type', w: 11, justify: 'flex-start' },
    { key: 'To', w: destW, justify: 'flex-start', flex: true }, // pre-fitted (may hold emoji)
    { key: 'Trk', w: 4, justify: 'center' },
  ];
  const grid = cols.reduce((a, c) => a + c.w, 0) + (cols.length - 1) * 3;
  const full = MARKER_W + grid;
  const outer = full + 4;
  // Vertical: drop header(1) + hints(1) + margin(1); each pane has 5 chrome lines.
  const paneRows = Math.max(3, Math.floor((Math.max(8, rows) - 13) / 2));
  const sideRows = 2 * paneRows + 5; // match the stacked right column's height
  return { MARKER_W, sideName, sideGrid, sideOuter, cols, full, outer, paneRows, sideRows, total: sideOuter + 1 + outer };
}

function useTerminalSize() {
  const { stdout } = useStdout();
  const read = () => ({ columns: (stdout && stdout.columns) || 100, rows: (stdout && stdout.rows) || 30 });
  const [size, setSize] = useState(read);
  useEffect(() => {
    if (!stdout || typeof stdout.on !== 'function') return undefined;
    const onResize = () => setSize(read());
    stdout.on('resize', onResize);
    return () => { try { stdout.off('resize', onResize); } catch { /* ignore */ } };
  }, [stdout]);
  return size;
}

// ── Small helpers ─────────────────────────────────────────────────────────────
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&@';
const SEG = new Intl.Segmenter('en', { granularity: 'grapheme' });
// Scramble per grapheme, preserving display width: only swap plain single-width
// characters for glyphs; leave emoji / wide / combined clusters intact so the
// rendered width stays identical every frame (keeps columns aligned mid-flap).
const scramble = (s) => {
  let out = '';
  for (const { segment } of SEG.segment(String(s))) {
    if (segment === ' ') out += ' ';
    else if (segment.length === 1 && stringWidth(segment) === 1) out += GLYPHS[(Math.random() * GLYPHS.length) | 0];
    else out += segment;
  }
  return out;
};
// Truncate then pad a string to an exact display width (grapheme-aware). Used for
// columns that may contain emoji, whose width Ink measures inconsistently — we pad
// them ourselves and render without a width-constrained Box so Ink just concatenates.
const fitWidth = (s, w) => {
  let out = '', width = 0;
  for (const { segment } of SEG.segment(String(s))) {
    const sw = stringWidth(segment);
    if (width + sw > w) break;
    out += segment; width += sw;
  }
  return out + (width < w ? ' '.repeat(w - width) : '');
};
const clip = (s, n) => {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
};
function catColor(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('intercity direct')) return 'blue';
  if (t.includes('intercity')) return 'cyan';
  if (t.includes('sprinter')) return 'green';
  if (/(thalys|ice|eurostar|nightjet)/.test(t)) return 'magenta';
  return 'yellow';
}
function operatorColor(op) {
  const o = (op || '').toLowerCase();
  if (o === 'ns' || o === '') return undefined;
  if (o.includes('arriva')) return 'magenta';
  if (o.includes('blauwnet') || o.includes('keolis')) return 'cyan';
  if (o.includes('r-net')) return 'green';
  if (o.includes('international') || o.includes('eurostar') || o.includes('ice')) return 'blue';
  if (o.includes('qbuzz')) return 'redBright';
  if (o.includes('breng')) return 'yellow';
  return 'yellowBright';
}
function relTime(epoch, now) {
  if (epoch == null) return '';
  const mins = Math.round((epoch * 1000 - now) / 60000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}h${m}` : `${h}h`;
}
const hhmm = (ts) =>
  new Date(ts).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
function windowed(arr, hi, size) {
  if (arr.length <= size) return { items: arr, offset: 0 };
  let offset = Math.max(0, hi - Math.floor(size / 2));
  offset = Math.min(offset, arr.length - size);
  return { items: arr.slice(offset, offset + size), offset };
}
// Window rows by a budget of *lines* (rows may be 1 or 2 lines tall), keeping the
// selected row visible — used so via sub-lines never overflow the pane's height.
function windowByLines(rows, sel, budget, cost) {
  const n = rows.length;
  if (n === 0) return { items: [], offset: 0 };
  sel = Math.max(0, Math.min(sel, n - 1));
  let start = sel, end = sel, lines = cost(sel);
  for (;;) {
    let grew = false;
    if (end + 1 < n && lines + cost(end + 1) <= budget) { end += 1; lines += cost(end); grew = true; }
    if (start - 1 >= 0 && lines + cost(start - 1) <= budget) { start -= 1; lines += cost(start); grew = true; }
    if (!grew) break;
  }
  return { items: rows.slice(start, end + 1), offset: start };
}

// ── Split-flap animated text ──────────────────────────────────────────────────
function FlapText({ children, color, dimColor, bold, wrap, strikethrough, backgroundColor, lockAt = 0 }) {
  const target = String(children ?? '');
  const [disp, setDisp] = useState(isTTY ? scramble(target) : target);
  useEffect(() => {
    if (!isTTY) { setDisp(target); return; }
    let frame = 0;
    setDisp(scramble(target));
    const id = setInterval(() => {
      frame += 1;
      if (frame > lockAt) { setDisp(target); clearInterval(id); }
      else setDisp(scramble(target));
    }, 40);
    return () => clearInterval(id);
  }, [target, lockAt]);
  return (
    <Text color={color} dimColor={dimColor} bold={bold} wrap={wrap}
      strikethrough={strikethrough} backgroundColor={backgroundColor}>{disp}</Text>
  );
}

const Sep = () => <Text dimColor>{' │ '}</Text>;
const Rule = ({ w }) => <Text dimColor>{'─'.repeat(Math.max(0, w))}</Text>;

function GridRow({ cols, cells, marker = ' ', markerColor }) {
  return (
    <Box>
      <Box width={2}><Text color={markerColor} bold>{marker}</Text></Box>
      {cells.map((node, i) => (
        <Box key={i}>
          {i > 0 && <Sep />}
          {cols[i].flex ? node : <Box width={cols[i].w} justifyContent={cols[i].justify}>{node}</Box>}
        </Box>
      ))}
    </Box>
  );
}

function ServiceRow({ cols, r, ri, now, selected, via }) {
  const lock = (col) => ri + col;
  const destW = cols[4].w;
  let inNode, delayNode, trackNode, dirColor;
  if (r.cancelled) {
    inNode = <FlapText dimColor lockAt={lock(1)}>—</FlapText>;
    delayNode = <FlapText color="redBright" lockAt={lock(2)}>✗</FlapText>;
    trackNode = <FlapText color="redBright" lockAt={lock(5)}>—</FlapText>;
    dirColor = 'red';
  } else {
    inNode = <FlapText dimColor lockAt={lock(1)}>{relTime(r.epoch, now)}</FlapText>;
    delayNode = r.delay > 0
      ? <FlapText color="redBright" bold lockAt={lock(2)}>{`+${r.delay}`}</FlapText>
      : <FlapText color="green" lockAt={lock(2)}>•</FlapText>;
    const trackTxt = (r.track ?? '—') + (r.trackChanged ? '▲' : '');
    trackNode = <FlapText color={r.trackChanged ? 'yellow' : 'gray'} bold={r.trackChanged} lockAt={lock(5)}>{trackTxt}</FlapText>;
    dirColor = operatorColor(r.operator);
  }
  const typeNode = (
    <Box>
      <Text color={catColor(r.type)}>●</Text>
      <Text> </Text>
      <FlapText lockAt={lock(3)}>{clip(r.type, cols[3].w - 2)}</FlapText>
    </Box>
  );
  // Destination cell: cancelled → strikethrough on a red background spanning the
  // column; otherwise the destination, plus a dimmed inline via when both fit.
  // The cell is pre-fitted to an exact width (handles emoji).
  let toNode;
  if (r.cancelled) {
    toNode = (
      <FlapText color="whiteBright" backgroundColor="red" strikethrough bold={selected} lockAt={lock(4)}>
        {fitWidth(r.dir, destW)}
      </FlapText>
    );
  } else if (via) {
    toNode = (
      <Box>
        <FlapText color={dirColor} bold={selected} lockAt={lock(4)}>{r.dir}</FlapText>
        <Text dimColor>{fitWidth(`  ${via}`, destW - stringWidth(r.dir))}</Text>
      </Box>
    );
  } else {
    toNode = <FlapText color={dirColor} bold={selected} lockAt={lock(4)}>{fitWidth(r.dir, destW)}</FlapText>;
  }
  return (
    <GridRow
      cols={cols}
      marker={selected ? '▸' : ' '}
      markerColor="cyan"
      cells={[
        <FlapText bold lockAt={lock(0)}>{r.t}</FlapText>,
        inNode, delayNode, typeNode, toNode, trackNode,
      ]}
    />
  );
}

// Continuation line under a departure, used when the via chain doesn't fit inline.
// Indented under the Type column so the via text gets as much room as possible.
function ViaLine({ cols, full, via }) {
  const indent = 2 + cols.slice(0, 3).reduce((a, c) => a + c.w, 0) + 3 * 3; // under "Type"
  return <Text dimColor>{fitWidth(' '.repeat(indent) + `↳ ${via}`, full)}</Text>;
}

// ── A single board pane (departures or arrivals) ─────────────────────────────
function BoardPane({ L, mode, station, rows, clock, selectedIndex = -1, focused }) {
  const { cols, full, outer, paneRows } = L;
  const destW = cols[4].w;
  const dirLabel = mode === 'arrivals' ? 'From' : 'To';
  const title = mode === 'arrivals' ? 'Arrivals' : 'Departures';

  // Per row: the via chain (departures only), whether it fits inline, and the
  // line cost (1, or 2 when it spills to a continuation line).
  const viaOf = (r) => (mode === 'departures' && !r.cancelled && r.via && r.via.length ? `via ${r.via.join(' · ')}` : '');
  const fitsInline = (r) => { const v = viaOf(r); return v && stringWidth(r.dir) + 2 + stringWidth(v) <= destW; };
  const cost = (i) => 1 + (viaOf(rows[i]) && !fitsInline(rows[i]) ? 1 : 0);
  const win = rows ? windowByLines(rows, selectedIndex >= 0 ? selectedIndex : 0, paneRows, cost) : null;

  return (
    <Box borderStyle="round" borderColor={focused ? 'cyan' : 'gray'} flexDirection="column" paddingX={1} width={outer}>
      <Box>
        <Box flexGrow={1} minWidth={0}>
          <Text bold color={focused ? 'cyan' : 'blueBright'} wrap="truncate">
            {`${mode === 'arrivals' ? '🚉' : '🚆'} ${title}`}
            {station ? <Text dimColor>{`  ·  ${station.name}`}</Text> : null}
          </Text>
        </Box>
        <Text dimColor>{rows ? ` ${rows.length}` : ''}</Text>
      </Box>
      <Rule w={full} />
      <GridRow cols={cols} cells={cols.map((c, i) => {
        const label = i === 4 ? dirLabel : c.key;
        return <Text key={i} dimColor bold>{c.flex ? fitWidth(label, c.w) : label}</Text>;
      })} />
      {rows === null
        ? <Box><Text color="cyan">{isTTY ? <Spinner type="dots" /> : '…'}</Text><Text dimColor> loading…</Text></Box>
        : rows.length === 0
          ? <Text color="yellow">no services</Text>
          : win.items.map((r, i) => {
            const idx = win.offset + i;
            const v = viaOf(r);
            const inline = v && fitsInline(r);
            return (
              <Fragment key={idx}>
                <ServiceRow cols={cols} r={r} ri={i} now={clock} selected={focused && idx === selectedIndex} via={inline ? v : null} />
                {v && !inline ? <ViaLine cols={cols} full={full} via={v} /> : null}
              </Fragment>
            );
          })}
    </Box>
  );
}

// ── Station sidebar ───────────────────────────────────────────────────────────
function StationList({ L, stations, query, hi, focused }) {
  const { sideName, sideGrid, sideOuter, sideRows } = L;
  const { items, offset } = windowed(stations, hi, sideRows);
  return (
    <Box borderStyle="round" borderColor={focused ? 'cyan' : 'gray'} flexDirection="column" paddingX={1} width={sideOuter}>
      <Text bold color={focused ? 'cyan' : undefined}>🚉 Stations</Text>
      <Box>
        <Text color="cyan">🔎 </Text>
        <Text>{clip(query, sideGrid - 4)}</Text>
        {focused ? <Text color="cyan">▏</Text> : null}
      </Box>
      <Rule w={sideGrid} />
      {stations.length === 0
        ? <Text color="yellow">no matches</Text>
        : items.map((s, i) => {
          const on = offset + i === hi;
          // marker + fixed 6-wide code (cyan) + one space + name (default).
          return (
            <Box key={s.code}>
              <Box width={2}><Text color="cyan" bold>{on ? '▸' : ' '}</Text></Box>
              <Box width={6}><Text color="cyan" bold>{s.code}</Text></Box>
              <Text> </Text>
              <Text bold={on} color={on ? 'whiteBright' : undefined}>{fitWidth(s.name, sideName)}</Text>
            </Box>
          );
        })}
    </Box>
  );
}

// ── Trip detail panel ─────────────────────────────────────────────────────────
function DetailView({ L, service: r, station, mode, onBack }) {
  useInput((input, key) => {
    if (key.escape || key.return || input === 'q' || input === 'b') onBack();
  }, { isActive: true });
  const width = L.total;
  const route = mode === 'arrivals' ? `${r.dir}  →  ${station.name}` : `${station.name}  →  ${r.dir}`;
  const timeLine = r.cancelled
    ? <Text color="redBright" bold>CANCELLED</Text>
    : r.delay > 0
      ? <Text>{r.planned} <Text dimColor>→</Text> <Text color="redBright" bold>{r.t}</Text> <Text color="redBright">{`(+${r.delay})`}</Text></Text>
      : <Text>{r.t} <Text color="green">(on time)</Text></Text>;
  const trackLine = r.trackChanged
    ? <Text>track <Text dimColor>{r.plannedTrack}</Text> <Text dimColor>→</Text> <Text color="yellow" bold>{r.track}</Text></Text>
    : <Text dimColor>{`track ${r.track ?? '—'}`}</Text>;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} width={width}>
        <Box justifyContent="space-between">
          <Text>
            <Text color={catColor(r.type)}>● </Text>
            <Text bold>{`${r.type} ${r.trainNumber ?? ''}`.trim()}</Text>
            <Text dimColor>{`  ·  ${r.operator ?? ''}`}</Text>
          </Text>
          <Text dimColor>{mode === 'arrivals' ? 'Arrival' : 'Departure'} detail</Text>
        </Box>
        <Rule w={width - 4} />
        <Text bold color={operatorColor(r.operator)}>{route}</Text>
        <Box marginTop={1} justifyContent="space-between">
          {timeLine}
          {trackLine}
        </Box>
        {r.status ? <Text dimColor>{`status: ${r.status}`}</Text> : null}
        <Box marginTop={1}>
          <Text dimColor>via: </Text><Text>{r.via.length ? r.via.join(' · ') : '—'}</Text>
        </Box>
        {r.messages.length ? (
          <Box flexDirection="column" marginTop={1}>
            {r.messages.map((m, i) => <Text key={i} color="yellow">{`⚠ ${m}`}</Text>)}
          </Box>
        ) : null}
      </Box>
      <Box paddingX={1}><Text dimColor>esc / ⏎ back to dashboard</Text></Box>
    </Box>
  );
}

// ── Interactive dashboard ─────────────────────────────────────────────────────
function Dashboard({ con, args, onQuit }) {
  const { watch } = args;
  const { columns, rows: termRows } = useTerminalSize();
  const L = useMemo(() => computeLayout(columns, termRows), [columns, termRows]);

  const [all, setAll] = useState(null);
  const [query, setQuery] = useState(args.stations || '');
  const [hi, setHi] = useState(0);
  const [focus, setFocus] = useState('stations');
  const [dep, setDep] = useState(null);
  const [arr, setArr] = useState(null);
  const [selDep, setSelDep] = useState(0);
  const [selArr, setSelArr] = useState(0);
  const [loadedAt, setLoadedAt] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const list = await listStations(con, '', 5000);
      if (!live) return;
      setAll(list);
      if (args.station) {
        const s = await resolveStation(con, args.station);
        if (live && s) {
          const idx = list.findIndex((x) => x.code === s.code);
          if (idx >= 0) { setHi(idx); setFocus('departures'); }
        }
      }
    })();
    const tick = setInterval(() => live && setClock(Date.now()), 1000);
    return () => { live = false; clearInterval(tick); };
  }, []);

  const matches = useMemo(() => {
    if (!all) return [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((s) => s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q));
  }, [all, query]);
  useEffect(() => { setHi(0); }, [query]);

  const station = matches[Math.min(hi, matches.length - 1)] || null;

  useEffect(() => {
    if (!station) { setDep([]); setArr([]); return undefined; }
    let live = true;
    const load = async () => {
      setDep(null); setArr(null);
      const [d, a] = await Promise.all([
        fetchBoard(con, { code: station.code, arrivals: false, limit: FETCH_LIMIT }),
        fetchBoard(con, { code: station.code, arrivals: true, limit: FETCH_LIMIT }),
      ]);
      if (live) {
        setDep(d); setArr(a); setLoadedAt(Date.now());
        setSelDep((s) => Math.min(s, Math.max(0, d.length - 1)));
        setSelArr((s) => Math.min(s, Math.max(0, a.length - 1)));
      }
    };
    const t = setTimeout(load, 220);
    const refresh = watch ? setInterval(load, watch * 1000) : null;
    return () => { live = false; clearTimeout(t); if (refresh) clearInterval(refresh); };
  }, [station?.code]);

  useInput((input, key) => {
    if (focus === 'stations') {
      if (key.escape) return onQuit();
      if (key.upArrow) return setHi((h) => Math.max(0, h - 1));
      if (key.downArrow) return setHi((h) => Math.min(matches.length - 1, h + 1));
      if (key.return || key.rightArrow || key.tab) return setFocus('departures');
      if (key.backspace || key.delete) return setQuery((q) => q.slice(0, -1));
      if (input && input.length === 1 && !key.ctrl && !key.meta) return setQuery((q) => q + input);
      return undefined;
    }
    const list = focus === 'departures' ? dep : arr;
    const setSel = focus === 'departures' ? setSelDep : setSelArr;
    const sel = focus === 'departures' ? selDep : selArr;
    if (input === 'q') return onQuit();
    if (key.escape || key.leftArrow) return setFocus('stations');
    if (key.tab) return setFocus((f) => (f === 'departures' ? 'arrivals' : 'departures'));
    if (key.upArrow) return setSel((s) => Math.max(0, s - 1));
    if (key.downArrow) return setSel((s) => Math.min((list?.length ?? 1) - 1, s + 1));
    if (key.return && list && list[sel]) return setDetail({ service: list[sel], mode: focus });
    return undefined;
  }, { isActive: !detail });

  if (!all) return <Loading label="loading stations…" />;
  if (detail) {
    return <DetailView L={L} service={detail.service} station={station} mode={detail.mode} onBack={() => setDetail(null)} />;
  }

  const remaining = watch ? Math.max(0, Math.ceil((loadedAt + watch * 1000 - clock) / 1000)) : 0;
  const hints = focus === 'stations'
    ? 'type filter   ↑↓ station   →/⏎ board   esc quit'
    : '↑↓ row   ⏎ detail   tab dep⇄arr   ← stations   q quit';
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box paddingX={1} width={L.total} justifyContent="space-between">
        <Text bold color="cyanBright">🚆 trains</Text>
        <Text dimColor>{`🕐 ${hhmm(clock)}${watch ? `   ⟳ ${remaining}s` : ''}`}</Text>
      </Box>
      <Box flexDirection="row">
        <StationList L={L} stations={matches} query={query} hi={hi} focused={focus === 'stations'} />
        <Box flexDirection="column" marginLeft={1}>
          <BoardPane L={L} mode="departures" station={station} rows={dep} clock={clock} selectedIndex={selDep} focused={focus === 'departures'} />
          <BoardPane L={L} mode="arrivals" station={station} rows={arr} clock={clock} selectedIndex={selArr} focused={focus === 'arrivals'} />
        </Box>
      </Box>
      <Box paddingX={1}><Text dimColor>{hints}</Text></Box>
    </Box>
  );
}

// ── Non-interactive (piped) fallbacks ─────────────────────────────────────────
function StaticDashboard({ con, station, limit, onDone }) {
  const { columns } = useTerminalSize();
  const L = useMemo(() => computeLayout(columns, 60), [columns]);
  const [dep, setDep] = useState(null);
  const [arr, setArr] = useState(null);
  const [clock] = useState(Date.now());
  useEffect(() => {
    let live = true;
    Promise.all([
      fetchBoard(con, { code: station.code, arrivals: false, limit }),
      fetchBoard(con, { code: station.code, arrivals: true, limit }),
    ]).then(([d, a]) => { if (live) { setDep(d); setArr(a); } });
    return () => { live = false; };
  }, []);
  useEffect(() => { if (dep && arr) { const t = setTimeout(onDone, 0); return () => clearTimeout(t); } }, [dep, arr]);
  if (!dep || !arr) return <Loading label="fetching live NS data…" />;
  const SL = { ...L, paneRows: Math.max(dep.length, arr.length) };
  return (
    <Box flexDirection="column" marginTop={1}>
      <BoardPane L={SL} mode="departures" station={station} rows={dep} clock={clock} />
      <BoardPane L={SL} mode="arrivals" station={station} rows={arr} clock={clock} />
    </Box>
  );
}

function StaticStations({ con, query, onDone }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let live = true;
    listStations(con, query).then((r) => { if (live) setRows(r); });
    return () => { live = false; };
  }, []);
  useEffect(() => { if (rows) { const t = setTimeout(onDone, 0); return () => clearTimeout(t); } }, [rows]);
  if (!rows) return <Loading label="loading stations…" />;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1} width={46}>
        <Box justifyContent="space-between">
          <Text bold>{`🚉 Stations${query ? ` · "${query}"` : ''}`}</Text>
          <Text dimColor>{`${rows.length}${rows.length === 60 ? '+' : ''}`}</Text>
        </Box>
        <Rule w={42} />
        {rows.length === 0
          ? <Text color="yellow">{`no stations matched "${query}"`}</Text>
          : rows.map((s) => (
            <Box key={s.code}>
              <Box width={6}><Text color="cyan" bold>{s.code}</Text></Box>
              <Text>{fitWidth(s.name, 30)}</Text>
              <Box width={4} justifyContent="flex-end"><Text dimColor>{s.country || ''}</Text></Box>
            </Box>
          ))}
      </Box>
    </Box>
  );
}

function Loading({ label }) {
  return (
    <Box marginTop={1}>
      <Text color="cyan">{isTTY ? <Spinner type="dots" /> : '…'}</Text>
      <Text>{` ${label}`}</Text>
    </Box>
  );
}

function NotFound({ query, onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 0); return () => clearTimeout(t); }, []);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow">{query ? `No station matched “${query}”.` : 'No station given.'}</Text>
      <Text dimColor>Run in a terminal for the interactive dashboard, or:  trains --stations [query]</Text>
    </Box>
  );
}

// ── App: connection + top-level routing ───────────────────────────────────────
function App({ args }) {
  const { exit } = useApp();
  const [con, setCon] = useState(null);
  const [err, setErr] = useState(null);
  const [view, setView] = useState('loading');
  const [station, setStation] = useState(null);

  useEffect(() => {
    let live = true, handle;
    connect().then((c) => { handle = c; if (live) setCon(c); }).catch((e) => { if (live) setErr(e); });
    return () => { live = false; if (handle) { try { handle.closeSync(); } catch { /* ignore */ } } };
  }, []);

  useEffect(() => {
    if (!con) return;
    if (interactive) { setView('dashboard'); return; }
    if (args.stations !== null) { setView('staticStations'); return; }
    if (args.station) {
      resolveStation(con, args.station).then((s) => {
        if (s) { setStation(s); setView('staticBoard'); } else setView('notfound');
      });
    } else setView('notfound');
  }, [con]);

  useEffect(() => { if (err) { const t = setTimeout(exit, 10); return () => clearTimeout(t); } }, [err]);

  if (err) {
    const msg = err.message || String(err);
    const isAuth = /\b(401|403|unauthor|forbidden|authenticat|credential|access denied|permission denied)\b/i.test(msg);
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="redBright" bold>{isAuth ? '✗ Authentication required' : '✗ Could not reach the trains service'}</Text>
        <Text>{`  ${msg}`}</Text>
        {isAuth
          ? <Text dimColor>{'  The trains worker rejected the connection. Point at an endpoint you can reach\n  with VGI_TRAINS_URL=<url>, or run a local worker with VGI_TRAINS_DIR=<path>.'}</Text>
          : <Text dimColor>{`  Worker: ${WORKER_LOCATION}\n  Override with VGI_TRAINS_URL=<url> or VGI_TRAINS_DIR=<path>.`}</Text>}
      </Box>
    );
  }
  if (!con || view === 'loading') return <Loading label="connecting to vgi worker…" />;
  if (view === 'dashboard') return <Dashboard con={con} args={args} onQuit={exit} />;
  if (view === 'staticStations') return <StaticStations con={con} query={args.stations} onDone={exit} />;
  if (view === 'staticBoard') return <StaticDashboard con={con} station={station} limit={args.limit} onDone={exit} />;
  return <NotFound query={args.station} onDone={exit} />;
}

// ── Arg parsing + entry ───────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { station: null, arrivals: false, limit: 10, stations: null, watch: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-a' || a === '--arrivals') o.arrivals = true;
    else if (a === '-d' || a === '--departures') o.arrivals = false;
    else if (a === '-n' || a === '--limit') o.limit = Math.max(1, parseInt(argv[++i], 10) || 10);
    else if (a === '-w' || a === '--watch') {
      const n = argv[i + 1] && /^\d+$/.test(argv[i + 1]) ? parseInt(argv[++i], 10) : 30;
      o.watch = Math.max(5, n);
    } else if (a === '-s' || a === '--stations') {
      o.stations = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : '';
    } else if (!a.startsWith('-') && o.station === null) o.station = a;
  }
  return o;
}

const HELP = `
🚆 trains — live Dutch railway dashboard, powered by the vgi DuckDB extension

A station list on the left; departures (top) and arrivals (bottom) for the
selected station on the right. Fills the terminal and reflows on resize.

Usage
  trains [station] [options]

Options
  -w, --watch [secs]    auto-refresh the boards (default every 30s)
  -s, --stations [q]    start with the station filter set to q
  -h, --help            this help

Keys
  in the list:   type to filter   ↑↓ pick station   →/⏎ enter boards   esc quit
  in a board:    ↑↓ select   ⏎ trip detail   tab dep⇄arr   ← back to list   q quit

Examples
  trains            # dashboard, pick a station
  trains UT         # dashboard focused on Utrecht Centraal
  trains ASD -w 15  # auto-refresh every 15s
`;

const args = parseArgs(process.argv.slice(2));
export { App, parseArgs, HELP, computeLayout, BoardPane };

import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
// Detect "run as the CLI entry" robustly: npm/npx invoke the bin through a symlink,
// so process.argv[1] (the symlink) must be resolved to its real path before comparing
// to import.meta.url (already a real path). Without realpathSync, npx runs do nothing.
let isEntry = false;
try {
  isEntry = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch { /* not invoked as a file entry */ }
if (isEntry) {
  if (args.help) process.stdout.write(HELP + '\n');
  else render(<App args={args} />, { exitOnCtrlC: true });
}
