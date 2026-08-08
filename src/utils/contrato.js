const fs = require('fs');
const path = require('path');

// El texto del contrato vive en un .txt para que pueda editarlo alguien de
// legal sin tocar código. Se relee automáticamente cuando el archivo cambia.
const ARCHIVO = path.join(__dirname, '..', 'config', 'contrato-permanencia.txt');

let cache = { mtime: 0, version: '1.0', plantilla: '' };

const cargar = () => {
  const stat = fs.statSync(ARCHIVO);
  if (stat.mtimeMs === cache.mtime) return cache;

  const bruto = fs.readFileSync(ARCHIVO, 'utf8');
  const m = bruto.match(/^\s*VERSION:\s*([^\n]+)\n/i);
  cache = {
    mtime: stat.mtimeMs,
    version: m ? m[1].trim() : '1.0',
    plantilla: (m ? bruto.slice(m[0].length) : bruto).trim(),
  };
  return cache;
};

const fmtFecha = (fecha, tz = 'America/Guayaquil') =>
  new Intl.DateTimeFormat('es-EC', {
    timeZone: tz, day: 'numeric', month: 'long', year: 'numeric',
  }).format(fecha instanceof Date ? fecha : new Date(`${fecha}T12:00:00Z`));

const fmtDinero = (n) => `$${Number(n).toFixed(2)}`;

// Redondeo único para toda la app: el monto que se le muestra al socio y el
// que se le cobra tienen que coincidir al centavo.
const redondear = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Penalidad por retiro anticipado
const calcularPenalidad = ({ mesesRestantes, precioMensual, penaltyPercent }) =>
  redondear(Math.max(0, mesesRestantes) * Number(precioMensual) * (Number(penaltyPercent) / 100));

// Meses de calendario que faltan hasta el fin del compromiso.
// Se cuentan meses completos y una fracción de mes cuenta como mes entero
// (es lo que el contrato llama "meses restantes"). No se usa 30 días fijos
// porque acumulaba error: 8 meses exactos daban 9.
const mesesRestantes = (fechaFin, hoy = new Date()) => {
  const fin = fechaFin instanceof Date ? fechaFin : new Date(`${fechaFin}T12:00:00Z`);
  let meses = (fin.getUTCFullYear() - hoy.getUTCFullYear()) * 12
            + (fin.getUTCMonth() - hoy.getUTCMonth());
  if (fin.getUTCDate() > hoy.getUTCDate()) meses += 1;
  return Math.max(0, meses);
};

/**
 * Devuelve el contrato listo para mostrar y para guardar congelado.
 * datos: { gymName, planName, precioMensual, precioLista, meses,
 *          penaltyPercent, penaltyRenews, fechaInicio, fechaFin, timezone }
 */
const renderContrato = (datos) => {
  const { version, plantilla } = cargar();
  const tz = datos.timezone || 'America/Guayaquil';

  const textoRenovacion = datos.penaltyRenews
    ? `Al finalizar el plazo, el establecimiento me consultará si deseo continuar. Si acepto, se iniciará un nuevo período de compromiso bajo los términos vigentes en ese momento, que deberé aceptar y firmar nuevamente. Si no respondo, mi membresía continuará cobrándose mes a mes con mi precio preferencial, sin nuevo compromiso ni penalidad.`
    : `Al finalizar el plazo, mi membresía continuará cobrándose mes a mes con mi precio preferencial, sin nuevo compromiso, y podré cancelarla en cualquier momento sin penalidad alguna.`;

  const valores = {
    FECHA: fmtFecha(new Date(), tz),
    GYM: datos.gymName || 'el establecimiento',
    PLAN: datos.planName || '',
    PRECIO_MENSUAL: fmtDinero(datos.precioMensual),
    PRECIO_LISTA: fmtDinero(datos.precioLista),
    MESES: String(datos.meses),
    PENALIDAD_PCT: String(Number(datos.penaltyPercent)),
    FECHA_INICIO: fmtFecha(datos.fechaInicio, tz),
    FECHA_FIN: fmtFecha(datos.fechaFin, tz),
    TEXTO_RENOVACION: textoRenovacion,
  };

  const texto = plantilla.replace(/\{\{(\w+)\}\}/g, (m, clave) =>
    valores[clave] !== undefined ? valores[clave] : m);

  return { version, texto };
};

// Suma meses a una fecha YYYY-MM-DD y devuelve YYYY-MM-DD
const sumarMeses = (fechaStr, meses) => {
  const [y, m, d] = fechaStr.split('-').map(Number);
  const f = new Date(Date.UTC(y, m - 1, d));
  f.setUTCMonth(f.getUTCMonth() + Number(meses));
  return f.toISOString().split('T')[0];
};

module.exports = {
  renderContrato, calcularPenalidad, mesesRestantes,
  redondear, sumarMeses, fmtFecha, fmtDinero,
};
