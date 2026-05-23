# 🚆 haybarn-vgi-nl-trains-cli

A live Dutch railway (NS) **dashboard** in your terminal — a station list on the left,
with departures (top) and arrivals (bottom) for the selected station on the right.
Built with [Ink](https://github.com/vadimdemedes/ink) (React for the terminal).

It runs [Haybarn](https://query.farm) — a derived distribution of
[DuckDB](https://duckdb.org) — via `@haybarn/node-api`, loads the **`vgi`** extension,
attaches a VGI worker exposing real-time NS (Nederlandse Spoorwegen) data as SQL table
functions, and renders it as an animated split-flap board.

```
 🚆 trains                                                    🕐 12:24
╭───────────────────╮ ╭──────────────────────────────────────────────╮
│ 🚉 Stations       │ │ 🚆 Departures  ·  Utrecht Centraal         8 │
│ 🔎 utr            │ │ ──────────────────────────────────────────── │
│ ───────────────── │ │   Time  │  In │ Δ │ Type       │ To    │ Trk │
│ ▸ UT   Utrecht C… │ │ ▸ 12:24 │ now │ • │ ● Sprinter │ Amst… │  1  │
│   UTLR Utrecht L… │ │   12:24 │  1m │+13│ ● Intercity│ Nijm… │ 19  │
│   ...             │ ╰──────────────────────────────────────────────╯
│                   │ ╭──────────────────────────────────────────────╮
│                   │ │ 🚉 Arrivals  ·  Utrecht Centraal           8 │
╰───────────────────╯ ╰──────────────────────────────────────────────╯
```

## Run it

No install needed — it talks to a hosted worker by default:

```bash
npx haybarn-vgi-nl-trains-cli            # dashboard, pick a station
npx haybarn-vgi-nl-trains-cli UT         # focused on Utrecht Centraal
npx haybarn-vgi-nl-trains-cli ASD -w 15  # auto-refresh both boards every 15s
```

## Data source

By default the CLI connects to the hosted VGI worker at `https://vgi-trains.fly.dev`,
so there's nothing to set up. Override the source with environment variables:

| Env var | Effect |
|---------|--------|
| `VGI_TRAINS_URL` | point at a different HTTP(S) worker, e.g. your own deployment |
| `VGI_TRAINS_DIR` | run a **local** worker via stdio (path to a `vgi-trains-python-fly` checkout) |
| `VGI_TRAINS_LOCATION` | a raw DuckDB `ATTACH` location string (advanced) |

If the worker requires authentication and none is provided, the `ATTACH` fails and the
CLI shows an "Authentication required" message instead of crashing.

## Develop

```bash
npm install
npm run dev -- UT --watch   # tsx runs source/cli.jsx with no build step
npm run build               # bundle source/cli.jsx → dist/cli.js (esbuild)
```

## Keys

| Context | Keys |
|---------|------|
| **Station list** | type to filter · `↑↓` pick station (updates both boards) · `→`/`⏎` enter boards · `esc` quit |
| **A board** | `↑↓` select service · `⏎` trip detail · `Tab` switch dep ⇄ arr · `←` back to list · `q` quit |
| **Trip detail** | `esc` / `⏎` back |

The selected station drives both panes at once; the focused pane has a cyan border
and shows the `▸` row marker.

## Options

| Flag | Meaning |
|------|---------|
| `-w, --watch [secs]` | auto-refresh the boards (default 30s, min 5) |
| `-s, --stations [q]` | start with the station filter set to `q` |
| `-h, --help` | help |

## Layout & terminal width

The destination column flexes to `stdout.columns`, so the dashboard fits an 80-column
terminal (destinations truncate) and widens up to ~92 columns. When stdout isn't a TTY
(piped, CI), it skips the interactive layer and prints the two boards stacked as one
static frame — `node dist/cli.js UT | cat` stays clean.

## Features

- **Live dashboard** — station list (left) drives departures + arrivals (right) at once;
  the layout fills the terminal and reflows on resize.
- **Split-flap animation** — cells scramble through glyphs and settle; re-flaps when you
  change station and on every `--watch` refresh. Display-width-aware, so emoji in NS data
  (e.g. `Alkmaar 🏳️‍🌈`, `Schiphol ✈️`) stay column-aligned.
- **Operator coloring** — non-NS operators (Arriva, Blauwnet, ICE, …) are tinted so they
  stand out; NS uses the default fg.
- **Via stops on the board** — each departure shows its via chain inline when it fits, or
  on a dim `↳ via …` continuation line when it doesn't.
- **Cancelled services** — shown struck through on a red background.
- **Trip detail** — `⏎` on a service shows route, planned-vs-actual time, platform change,
  status, via stops, and disruption messages.

## How it works

- **`source/vgi.js`** — the data layer. Opens an in-memory Haybarn database, `LOAD`s the
  `vgi` extension, then `ATTACH`es the worker — by default the hosted service over HTTPS,
  or a local worker over **stdio** when `VGI_TRAINS_DIR` is set (Haybarn spawns it as a
  subprocess). Returns plain JS objects. (Note: `station_arrivals` has no `via` column —
  only departures do.)
- **The `vgi` extension** ships as a real npm dependency, `@haybarn/ext-vgi-h1-5-3` (a
  meta-package that pulls the right platform binary via `optionalDependencies`, like
  esbuild). Haybarn discovers it automatically, so we just `LOAD vgi` — no
  `INSTALL ... FROM community`, no network fetch, no path wiring. The `-h1-5-3` suffix is
  tied to the DuckDB engine version (`@haybarn/node-api` 1.5.3); bumping the engine means
  switching to the matching `@haybarn/ext-vgi-h1-5-x` package.
- **`source/cli.jsx`** — the Ink UI. `<Dashboard>` owns the navigation state (station
  filter/selection, pane focus, row selection, detail overlay) and fetches both boards
  when the selected station settles (debounced ~220ms so holding `↓` doesn't spam the API).
  Animation and the interactive layer auto-disable when stdout isn't a TTY. `App` is
  exported and only auto-runs as the CLI entry, so tests can drive it.

## Testing

`ink-testing-library` drives the UI headlessly — set `process.stdout.isTTY = true` and
`process.stdout.columns`, `render(<App args=… />)`, then `stdin.write('\\t')` / `'\\r'` /
arrow escapes (`'\\x1b[B'`) and assert on `lastFrame()`.

## License

MIT © 2026 [Query.Farm LLC](https://query.farm)

Powered by [Haybarn](https://query.farm), a derived distribution of
[DuckDB](https://duckdb.org).
