const db = require('../config/database');

// ============================================================
// GESTIÓN DE PENALIDADES (recepción y admin)
// ============================================================
// Recepción puede cobrar una penalidad; solo el admin puede condonarla,
// porque perdonar una deuda es una decisión del negocio, no del mostrador.

// GET /api/(admin|recepcion)/penalties?status=pending
const getPenalties = async (req, res) => {
  try {
    const { status = 'pending' } = req.query;
    const params = [req.gym.id];
    let filtro = '';
    if (status !== 'all') { params.push(status); filtro = ' AND p.status = $2'; }

    const r = await db.query(`
      SELECT p.id, p.amount, p.months_remaining, p.monthly_price, p.penalty_percent,
             p.status, p.waived_reason, p.created_at, p.resolved_at,
             u.id AS user_id, u.name AS user_name, u.cedula, u.phone,
             c.end_date::text AS commitment_end, c.commitment_months,
             mt.name AS plan_name,
             quien.name AS resolved_by_name
      FROM penalties p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN membership_commitments c ON c.id = p.commitment_id
      LEFT JOIN membership_types mt ON mt.id = c.membership_type_id
      LEFT JOIN users quien ON quien.id = p.resolved_by
      WHERE p.gym_id = $1${filtro}
      ORDER BY p.status = 'pending' DESC, p.created_at DESC
    `, params);

    const totales = await db.query(`
      SELECT COALESCE(SUM(amount) FILTER (WHERE status='pending'), 0) AS pendiente,
             COALESCE(SUM(amount) FILTER (WHERE status='paid'), 0) AS cobrado,
             COALESCE(SUM(amount) FILTER (WHERE status='waived'), 0) AS condonado,
             COUNT(*) FILTER (WHERE status='pending') AS n_pendientes
      FROM penalties WHERE gym_id = $1
    `, [req.gym.id]);

    res.json({ penalties: r.rows, totals: totales.rows[0] });
  } catch (err) {
    console.error('Error getPenalties:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/(admin|recepcion)/penalties/:penaltyId/collect
const collectPenalty = async (req, res) => {
  try {
    const { penaltyId } = req.params;
    const { method = 'efectivo', notes } = req.body;

    if (!['efectivo', 'transferencia', 'tarjeta'].includes(method)) {
      return res.status(400).json({ error: 'Método de pago inválido' });
    }

    const pr = await db.query(
      "SELECT * FROM penalties WHERE id=$1 AND gym_id=$2 AND status='pending'",
      [penaltyId, req.gym.id]
    );
    if (!pr.rows.length) return res.status(404).json({ error: 'Penalidad no encontrada o ya resuelta' });
    const deuda = pr.rows[0];

    const pago = await db.query(`
      INSERT INTO payments (gym_id, user_id, amount, method, status, registered_by, notes)
      VALUES ($1, $2, $3, $4, 'pagado', $5, $6) RETURNING id
    `, [req.gym.id, deuda.user_id, deuda.amount, method, req.user.id,
        notes || 'Penalidad por retiro anticipado']);

    await db.query(`
      UPDATE penalties SET status='paid', payment_id=$1, resolved_by=$2, resolved_at=NOW()
      WHERE id=$3
    `, [pago.rows[0].id, req.user.id, penaltyId]);

    await db.query(`
      INSERT INTO notifications (user_id, gym_id, title, message, type)
      VALUES ($1, $2, '✅ Penalidad pagada', $3, 'payment')
    `, [deuda.user_id, req.gym.id,
        `Tu penalidad de $${Number(deuda.amount).toFixed(2)} fue registrada como pagada. Ya puedes volver a usar la app y adquirir membresías.`]);

    res.json({ message: 'Penalidad cobrada', paymentId: pago.rows[0].id });
  } catch (err) {
    console.error('Error collectPenalty:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/admin/penalties/:penaltyId/waive — solo admin
const waivePenalty = async (req, res) => {
  try {
    const { penaltyId } = req.params;
    const { reason } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'Debes indicar el motivo de la condonación' });
    }

    const r = await db.query(`
      UPDATE penalties SET status='waived', waived_reason=$1, resolved_by=$2, resolved_at=NOW()
      WHERE id=$3 AND gym_id=$4 AND status='pending'
      RETURNING user_id, amount
    `, [reason.trim(), req.user.id, penaltyId, req.gym.id]);

    if (!r.rows.length) return res.status(404).json({ error: 'Penalidad no encontrada o ya resuelta' });

    await db.query(`
      INSERT INTO notifications (user_id, gym_id, title, message, type)
      VALUES ($1, $2, 'Penalidad condonada', $3, 'payment')
    `, [r.rows[0].user_id, req.gym.id,
        `El gimnasio condonó tu penalidad de $${Number(r.rows[0].amount).toFixed(2)}. Ya puedes volver a usar la app.`]);

    res.json({ message: 'Penalidad condonada' });
  } catch (err) {
    console.error('Error waivePenalty:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/(admin|recepcion)/commitments/at-risk
// Compromisos suspendidos por cobros fallidos: NO generan penalidad, pero
// alguien del gimnasio debería contactar al socio.
const getCommitmentsAtRisk = async (req, res) => {
  try {
    const r = await db.query(`
      SELECT c.id, c.commitment_months, c.monthly_price, c.end_date::text AS end_date,
             u.id AS user_id, u.name AS user_name, u.cedula, u.phone,
             mt.name AS plan_name,
             m.recurring_failed_attempts AS intentos_fallidos
      FROM membership_commitments c
      JOIN users u ON u.id = c.user_id
      LEFT JOIN membership_types mt ON mt.id = c.membership_type_id
      LEFT JOIN memberships m ON m.id = c.membership_id
      WHERE c.gym_id = $1 AND c.status = 'payment_failed'
      ORDER BY c.ended_at DESC NULLS LAST, c.created_at DESC
    `, [req.gym.id]);
    res.json(r.rows);
  } catch (err) {
    console.error('Error getCommitmentsAtRisk:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

module.exports = { getPenalties, collectPenalty, waivePenalty, getCommitmentsAtRisk };
