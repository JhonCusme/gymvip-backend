const db = require('../config/database');

// ============================================================
// BLOQUEO POR PENALIDAD PENDIENTE
// ============================================================
// Regla acordada con el gimnasio:
//  - Con deuda pendiente NUNCA puede comprar una membresía nueva.
//  - El resto de la app (QR, reservas, horarios) le sigue funcionando
//    mientras siga vigente la membresía que YA PAGÓ; cobrarle la penalidad
//    y además quitarle días pagados sería indefendible.
//  - Cuando esa membresía vence, la app queda limitada a la pantalla de
//    inicio, donde puede pagar la penalidad.
// El bloqueo va en el servidor (no solo en la pantalla) para que no baste
// con reinstalar la app para saltárselo.

const buscarDeuda = async (userId, gymId) => {
  const r = await db.query(
    "SELECT id, amount FROM penalties WHERE user_id=$1 AND gym_id=$2 AND status='pending' LIMIT 1",
    [userId, gymId]
  );
  return r.rows[0] || null;
};

const tieneMembresiaVigente = async (userId, gymId) => {
  const r = await db.query(
    "SELECT 1 FROM memberships WHERE user_id=$1 AND gym_id=$2 AND status='active' AND end_date >= CURRENT_DATE LIMIT 1",
    [userId, gymId]
  );
  return r.rows.length > 0;
};

const respuestaBloqueo = (res, deuda, motivo) =>
  res.status(403).json({
    error: 'PENALTY_PENDING',
    message: motivo,
    penalty: { id: deuda.id, amount: parseFloat(deuda.amount) },
  });

// Bloquea siempre que haya deuda (comprar membresías)
const bloquearCompraConDeuda = async (req, res, next) => {
  try {
    const deuda = await buscarDeuda(req.user.id, req.gym.id);
    if (!deuda) return next();
    return respuestaBloqueo(res, deuda,
      'Tienes una penalidad pendiente. Debes pagarla antes de adquirir una nueva membresía.');
  } catch (err) {
    console.error('Error bloquearCompraConDeuda:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// Bloquea solo si además ya no tiene membresía vigente
const bloquearAppConDeuda = async (req, res, next) => {
  try {
    const deuda = await buscarDeuda(req.user.id, req.gym.id);
    if (!deuda) return next();
    if (await tieneMembresiaVigente(req.user.id, req.gym.id)) return next();
    return respuestaBloqueo(res, deuda,
      'Tienes una penalidad pendiente. Págala para volver a usar la aplicación.');
  } catch (err) {
    console.error('Error bloquearAppConDeuda:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

module.exports = { bloquearCompraConDeuda, bloquearAppConDeuda, buscarDeuda, tieneMembresiaVigente };
