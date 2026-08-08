// ============================================================
// RESTRICCIÓN DE HORARIOS POR PLAN (ej. "Promo Matutina")
// ============================================================
// Un plan puede limitar en qué franja y qué días se puede agendar/ingresar.
// Sin franja configurada el plan es libre, que es como se comportan todos
// los planes existentes.

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const hhmm = (t) => (t ? String(t).slice(0, 5) : null);

// Convierte 'HH:MM[:SS]' a minutos desde medianoche
const aMinutos = (t) => {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
};

/**
 * ¿El plan restringe horarios? Recibe las columnas del membership_type.
 */
const tieneRestriccion = (plan) =>
  !!(plan && plan.booking_start_time && plan.booking_end_time);

/**
 * Verifica si una clase (o un ingreso) cae dentro de lo permitido.
 * @param plan  columnas booking_start_time / booking_end_time / booking_days
 * @param hora  'HH:MM' o 'HH:MM:SS' — hora de inicio de la clase o del ingreso
 * @param dow   día de la semana 0-6 (0 = domingo). Opcional.
 * @returns { permitido, motivo }
 */
const permite = (plan, hora, dow = null) => {
  if (!tieneRestriccion(plan)) return { permitido: true };

  const ini = aMinutos(plan.booking_start_time);
  const fin = aMinutos(plan.booking_end_time);
  const actual = aMinutos(hora);

  const dias = Array.isArray(plan.booking_days) ? plan.booking_days.map(Number) : [];
  if (dow != null && dias.length && !dias.includes(Number(dow))) {
    return {
      permitido: false,
      motivo: `Tu plan solo permite los ${dias.map((d) => DIAS[d]).join(', ')}`,
    };
  }

  if (actual == null) return { permitido: true };

  // Franja que cruza la medianoche (ej. 22:00 a 02:00)
  const dentro = ini <= fin
    ? actual >= ini && actual <= fin
    : actual >= ini || actual <= fin;

  if (!dentro) {
    return {
      permitido: false,
      motivo: `Tu plan permite de ${hhmm(plan.booking_start_time)} a ${hhmm(plan.booking_end_time)}`,
    };
  }
  return { permitido: true };
};

/** Texto corto para mostrar en la app y en los paneles */
const describir = (plan) => {
  if (!tieneRestriccion(plan)) return null;
  const dias = Array.isArray(plan.booking_days) ? plan.booking_days.map(Number) : [];
  const franja = `${hhmm(plan.booking_start_time)} a ${hhmm(plan.booking_end_time)}`;
  if (!dias.length || dias.length === 7) return `Horario permitido: ${franja}`;
  return `Horario permitido: ${franja} (${dias.map((d) => DIAS[d].slice(0, 3)).join(', ')})`;
};

module.exports = { tieneRestriccion, permite, describir, hhmm, DIAS };
