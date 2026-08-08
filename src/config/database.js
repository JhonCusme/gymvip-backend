const { Pool } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Error inesperado en el pool de PostgreSQL:', err);
});

// ============================================================
// ZONA HORARIA POR GIMNASIO (multi-box internacional)
// ============================================================
// Cada box puede estar en un país distinto. En vez de reescribir todas las
// consultas, se fija la zona horaria de la sesión de PostgreSQL según el gym
// de la petición: así CURRENT_DATE, CURRENT_TIME y DATE(campo_timestamptz)
// resuelven automáticamente a la fecha/hora local de ESE box.
const tzStore = new AsyncLocalStorage();

// Zona por defecto del servidor (cuando no hay gym en contexto)
const DEFAULT_TZ = 'America/Guayaquil';

// Solo se aceptan zonas IANA válidas: la zona se interpola en el SQL,
// así que hay que descartar cualquier valor arbitrario.
const tzCache = new Map();
const isValidTimezone = (tz) => {
  if (!tz || typeof tz !== 'string') return false;
  if (tzCache.has(tz)) return tzCache.get(tz);
  let ok = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    ok = /^[A-Za-z0-9_+\-\/]+$/.test(tz);
  } catch { ok = false; }
  tzCache.set(tz, ok);
  return ok;
};

// Ejecuta el resto de la petición con la zona horaria de ese gimnasio
const runWithTimezone = (timezone, fn) => {
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TZ;
  return tzStore.run({ timezone: tz }, fn);
};

const currentTimezone = () => tzStore.getStore()?.timezone || DEFAULT_TZ;

const query = async (text, params) => {
  const start = Date.now();
  const tz = currentTimezone();

  let res;
  if (tz === DEFAULT_TZ) {
    // Caso habitual: la zona del servidor ya es la correcta, sin sobrecarga
    res = await pool.query(text, params);
  } else {
    // Gimnasio en otra zona horaria: se fija en la conexión y se restaura
    // antes de devolverla al pool, para no contaminar otras peticiones.
    const client = await pool.connect();
    try {
      await client.query(`SET TIME ZONE '${tz}'`);
      res = await client.query(text, params);
    } finally {
      try { await client.query('RESET TIME ZONE'); } catch { /* se descarta */ }
      client.release();
    }
  }

  const duration = Date.now() - start;
  if (process.env.NODE_ENV === 'development') {
    console.log('Query ejecutada:', { text: text.substring(0, 80), duration, rows: res.rowCount, tz });
  }
  return res;
};

const getClient = () => pool.connect();

module.exports = {
  query, getClient, pool,
  runWithTimezone, currentTimezone, isValidTimezone, DEFAULT_TZ,
};
