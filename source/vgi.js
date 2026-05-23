// Data layer: talks to the VGI worker through the `vgi` DuckDB community
// extension. No UI concerns here — returns plain JS values.
import duckdb from '@haybarn/node-api';

const { DuckDBInstance } = duckdb;

// Where the VGI worker lives. Default: the hosted Fly.io service over HTTPS, so
// `npx` users get data with nothing to install. Override with VGI_TRAINS_DIR to spawn
// a local worker via stdio (development), or VGI_TRAINS_LOCATION for a raw ATTACH value.
const HOSTED = process.env.VGI_TRAINS_URL || 'https://vgi-trains.fly.dev';
export const WORKER_LOCATION = process.env.VGI_TRAINS_LOCATION
  || (process.env.VGI_TRAINS_DIR
    ? `sh -c 'cd ${process.env.VGI_TRAINS_DIR} && exec .venv/bin/python train_departures_worker.py'`
    : HOSTED);

const sql = (s) => "'" + String(s).replace(/'/g, "''") + "'";

async function rows(con, query) {
  return (await con.runAndReadAll(query)).getRowObjects();
}

// Open an in-memory DuckDB, load the vgi extension, attach the trains worker.
// The extension ships as the `@haybarn/ext-vgi-h1-5-3` npm dependency; Haybarn
// discovers it automatically, so we just LOAD it — no network INSTALL, no path.
export async function connect() {
  const instance = await DuckDBInstance.create(':memory:');
  const con = await instance.connect();
  await con.run('LOAD vgi;');
  try {
    // If the worker requires authentication and none is supplied, this ATTACH fails.
    await con.run(`ATTACH 'trains' AS trains (TYPE vgi, LOCATION ${sql(WORKER_LOCATION)});`);
  } catch (e) {
    try { con.closeSync(); } catch { /* ignore */ }
    throw e;
  }
  return con;
}

// Resolve "UT" or "utrecht" to { code, name }, or null if nothing matches.
export async function resolveStation(con, input) {
  const up = String(input).toUpperCase();
  const exact = await rows(con,
    `SELECT station_code, name FROM trains.main.train_stations
     WHERE upper(station_code) = ${sql(up)} LIMIT 1`);
  if (exact.length) return { code: exact[0].station_code, name: exact[0].name };
  const byName = await rows(con,
    `SELECT station_code, name FROM trains.main.train_stations
     WHERE name ILIKE ${sql('%' + input + '%')} ORDER BY length(name) LIMIT 1`);
  return byName.length ? { code: byName[0].station_code, name: byName[0].name } : null;
}

// DuckDB list values come back as { items: [...] }; normalize to a plain array.
const toArr = (v) =>
  v && Array.isArray(v.items) ? v.items.map(String) : Array.isArray(v) ? v.map(String) : [];

// Fetch a board's worth of services for one station.
export async function fetchBoard(con, { code, arrivals, limit }) {
  const table = arrivals ? 'station_arrivals' : 'station_departures';
  const dirCol = arrivals ? 'origin' : 'destination';
  // Only departures carry a `via` column; arrivals don't.
  const viaCol = arrivals ? '' : 'via,';
  const data = await rows(con, `
    SELECT strftime(actual_time, '%H:%M')  AS t,
           strftime(planned_time, '%H:%M') AS planned,
           epoch(actual_time)::BIGINT       AS epoch,
           delay_minutes AS delay,
           category AS type,
           train_number, operator, status,
           ${dirCol} AS dir,
           ${viaCol} messages,
           actual_track, planned_track, track_changed, cancelled
    FROM trains.main.${table}
    WHERE station_code = ${sql(String(code).toUpperCase())}
    ORDER BY actual_time
    LIMIT ${limit}`);

  return data.map((r) => ({
    t: r.t,
    planned: r.planned,
    epoch: r.epoch == null ? null : Number(r.epoch),
    delay: Number(r.delay ?? 0),
    type: r.type,
    trainNumber: r.train_number,
    operator: r.operator,
    status: r.status,
    dir: r.dir,
    via: toArr(r.via),
    messages: toArr(r.messages),
    track: r.actual_track,
    plannedTrack: r.planned_track,
    trackChanged: !!r.track_changed,
    cancelled: !!r.cancelled,
  }));
}

// List stations (optionally filtered by a name/code substring).
export async function listStations(con, query, limit = 60) {
  const where = query
    ? `WHERE name ILIKE ${sql('%' + query + '%')} OR station_code ILIKE ${sql('%' + query + '%')}`
    : '';
  return rows(con,
    `SELECT station_code AS code, name, country FROM trains.main.train_stations
     ${where} ORDER BY name LIMIT ${limit}`);
}
