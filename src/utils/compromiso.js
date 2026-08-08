const db = require('../config/database');
const { calcularPenalidad, mesesRestantes, redondear, fmtFecha, renderContrato, sumarMeses } = require('./contrato');

// ============================================================
// COMPROMISO DE PERMANENCIA Y PENALIDAD POR RETIRO
// ============================================================
// Toda la lógica vive aquí para que los distintos puntos de baja (app del
// socio, recepción, admin) calculen y registren exactamente lo mismo.

// Compromiso vigente del socio en ese gimnasio, si lo tiene
const compromisoActivo = async (userId, gymId) => {
  const r = await db.query(`
    SELECT c.*, mt.name AS plan_name,
           c.start_date::text AS start_date_txt, c.end_date::text AS end_date_txt
    FROM membership_commitments c
    JOIN membership_types mt ON mt.id = c.membership_type_id
    WHERE c.user_id = $1 AND c.gym_id = $2 AND c.status = 'active'
    ORDER BY c.created_at DESC LIMIT 1
  `, [userId, gymId]);
  return r.rows[0] || null;
};

// Cuánto pagaría hoy por retirarse. Devuelve null si no debe nada.
const calcularBaja = (compromiso, hoy = new Date()) => {
  if (!compromiso) return null;
  const meses = mesesRestantes(compromiso.end_date, hoy);
  if (meses <= 0) return null; // ya cumplió el plazo
  const monto = calcularPenalidad({
    mesesRestantes: meses,
    precioMensual: compromiso.monthly_price,
    penaltyPercent: compromiso.penalty_percent,
  });
  return {
    amount: monto,
    monthsRemaining: meses,
    monthlyPrice: redondear(compromiso.monthly_price),
    penaltyPercent: parseFloat(compromiso.penalty_percent),
    endDate: compromiso.end_date_txt || compromiso.end_date,
    commitmentId: compromiso.id,
  };
};

// Deuda pendiente del socio (una sola, la más reciente)
const deudaPendiente = async (userId, gymId = null) => {
  const params = [userId];
  let filtroGym = '';
  if (gymId) { params.push(gymId); filtroGym = ' AND p.gym_id = $2'; }
  const r = await db.query(`
    SELECT p.*, g.name AS gym_name
    FROM penalties p
    JOIN gyms g ON g.id = p.gym_id
    WHERE p.user_id = $1 AND p.status = 'pending'${filtroGym}
    ORDER BY p.created_at DESC LIMIT 1
  `, params);
  return r.rows[0] || null;
};

/**
 * Registra el retiro anticipado: marca el compromiso como incumplido y genera
 * la deuda. Devuelve la deuda creada, o null si no correspondía penalidad.
 * Es idempotente: si ya existe una deuda pendiente, no crea otra.
 */
const registrarRetiro = async (userId, gymId, { motivo = null } = {}) => {
  const compromiso = await compromisoActivo(userId, gymId);
  if (!compromiso) return null;

  const calculo = calcularBaja(compromiso);

  // Cumplió el plazo: se cierra el compromiso sin penalidad
  if (!calculo) {
    await db.query(
      "UPDATE membership_commitments SET status='completed', ended_at=NOW() WHERE id=$1",
      [compromiso.id]
    );
    return null;
  }

  const yaExiste = await db.query(
    "SELECT id FROM penalties WHERE user_id=$1 AND gym_id=$2 AND status='pending'",
    [userId, gymId]
  );
  if (yaExiste.rows.length) return null;

  await db.query(
    "UPDATE membership_commitments SET status='broken', ended_at=NOW() WHERE id=$1",
    [compromiso.id]
  );

  const r = await db.query(`
    INSERT INTO penalties (gym_id, user_id, commitment_id, amount, months_remaining, monthly_price, penalty_percent)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
  `, [gymId, userId, compromiso.id, calculo.amount, calculo.monthsRemaining,
      calculo.monthlyPrice, calculo.penaltyPercent]);

  await db.query(`
    INSERT INTO notifications (user_id, gym_id, title, message, type)
    VALUES ($1, $2, 'Penalidad por retiro anticipado', $3, 'payment')
  `, [userId, gymId,
      `Cancelaste tu compromiso antes del ${fmtFecha(compromiso.end_date)}. Se generó una penalidad de $${calculo.amount.toFixed(2)} ` +
      `(${calculo.monthsRemaining} meses × $${calculo.monthlyPrice.toFixed(2)} × ${calculo.penaltyPercent}%). ` +
      `Puedes pagarla desde la app o en recepción.`]);

  return r.rows[0];
};

// ============================================================
// RENOVACIÓN AL CUMPLIRSE EL PLAZO
// ============================================================
// Solo se le pregunta al socio cuando el plan tiene penalty_renews = TRUE:
// aceptar implica un compromiso nuevo con penalidad, y eso requiere su
// consentimiento expreso. Si el plan NO renueva la penalidad, no se le
// molesta con nada: sigue cobrándose normal y puede cancelar cuando quiera.
const DIAS_AVISO = 15;

const renovacionPendiente = async (userId, gymId) => {
  const r = await db.query(`
    SELECT c.*, mt.name AS plan_name,
           mt.commitment_months AS meses_nuevos,
           mt.penalty_percent   AS penalidad_nueva,
           mt.recurring_discount, mt.price AS precio_lista,
           c.end_date::text AS end_date_txt
    FROM membership_commitments c
    JOIN membership_types mt ON mt.id = c.membership_type_id
    WHERE c.user_id = $1 AND c.gym_id = $2
      AND c.penalty_renews = TRUE
      AND c.renewal_answer IS NULL
      AND c.status IN ('active', 'completed')
      AND c.end_date <= CURRENT_DATE + ($3 || ' days')::interval
      AND EXISTS (
        SELECT 1 FROM memberships m
        WHERE m.user_id = c.user_id AND m.gym_id = c.gym_id AND m.auto_renew = TRUE
      )
    ORDER BY c.end_date DESC LIMIT 1
  `, [userId, gymId, DIAS_AVISO]);
  return r.rows[0] || null;
};

/**
 * Guarda la respuesta del socio.
 *  - 'no': se detiene el débito automático, sin penalidad (cumplió el plazo).
 *  - 'si': se crea un compromiso NUEVO con los términos vigentes hoy y su
 *          firma. El anterior queda marcado como respondido.
 */
const responderRenovacion = async (userId, gymId, respuesta, { signature = null, ip = null, gymName = null, timezone = null } = {}) => {
  const pendiente = await renovacionPendiente(userId, gymId);
  if (!pendiente) return { error: 'No tienes ninguna renovación pendiente' };

  // El anterior se cierra como cumplido: no puede haber dos vigentes a la vez
  await db.query(`
    UPDATE membership_commitments
    SET renewal_answer=$1, renewal_answered_at=NOW(),
        status='completed', ended_at=COALESCE(ended_at, NOW())
    WHERE id=$2
  `, [respuesta, pendiente.id]);

  if (respuesta === 'no') {
    await db.query(
      "UPDATE memberships SET auto_renew=FALSE WHERE user_id=$1 AND gym_id=$2 AND status='active'",
      [userId, gymId]
    );
    await db.query(`
      INSERT INTO notifications (user_id, gym_id, title, message, type)
      VALUES ($1, $2, 'Débito automático finalizado', $3, 'membership')
    `, [userId, gymId,
        'Cumpliste tu compromiso y decidiste no continuar. No se te volverá a cobrar automáticamente y no hay ninguna penalidad.']);
    return { renewed: false };
  }

  // Aceptó: nuevo compromiso con los términos de HOY
  const meses = parseInt(pendiente.meses_nuevos || 0);
  if (meses <= 0) return { renewed: false, note: 'El plan ya no exige permanencia' };

  const desc = parseFloat(pendiente.recurring_discount || 0);
  const precioMensual = redondear(
    desc > 0 ? pendiente.precio_lista * (1 - desc / 100) : pendiente.precio_lista
  );
  const penaltyPercent = parseFloat(pendiente.penalidad_nueva || 0);

  // El nuevo período empieza cuando termina el anterior (si renovó antes de
  // tiempo no debe perder los días que le quedaban), o hoy si ya venció.
  const fechasQ = await db.query(
    'SELECT CURRENT_DATE::text AS hoy, GREATEST(CURRENT_DATE, $1::date)::text AS inicio',
    [pendiente.end_date_txt]
  );
  const inicio = fechasQ.rows[0].inicio;
  const fin = sumarMeses(inicio, meses);

  const { version, texto } = renderContrato({
    gymName, planName: pendiente.plan_name,
    precioMensual, precioLista: pendiente.precio_lista,
    meses, penaltyPercent, penaltyRenews: true,
    fechaInicio: inicio, fechaFin: fin, timezone,
  });

  const nuevo = await db.query(`
    INSERT INTO membership_commitments (
      user_id, gym_id, membership_type_id, commitment_months, monthly_price, list_price,
      penalty_percent, penalty_renews, contract_version, contract_text,
      signature_url, signed_ip, start_date, end_date, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$8,$9,$10,$11,$12,$13,'active')
    RETURNING id, end_date::text AS end_date
  `, [userId, gymId, pendiente.membership_type_id, meses, precioMensual, pendiente.precio_lista,
      penaltyPercent, version, texto, signature, ip, inicio, fin]);

  await db.query(`
    INSERT INTO notifications (user_id, gym_id, title, message, type)
    VALUES ($1, $2, 'Compromiso renovado', $3, 'membership')
  `, [userId, gymId,
      `Renovaste tu compromiso por ${meses} meses a $${precioMensual.toFixed(2)} mensuales, hasta el ${fmtFecha(fin)}.`]);

  return { renewed: true, commitment: nuevo.rows[0] };
};

module.exports = {
  compromisoActivo, calcularBaja, deudaPendiente, registrarRetiro,
  renovacionPendiente, responderRenovacion, DIAS_AVISO,
};
