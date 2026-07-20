const bcrypt = require('bcryptjs');
const db = require('../config/database');

// GET /api/super/gyms — listar todos los gyms
const getGyms = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        g.*,
        COUNT(DISTINCT ugr.user_id) FILTER (WHERE ugr.role = 'user' AND ugr.is_active = TRUE) as user_count,
        COUNT(DISTINCT m.id) FILTER (WHERE m.status = 'active' AND m.end_date >= CURRENT_DATE) as active_memberships
      FROM gyms g
      LEFT JOIN user_gym_roles ugr ON ugr.gym_id = g.id
      LEFT JOIN memberships m ON m.gym_id = g.id
      GROUP BY g.id
      ORDER BY g.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error getGyms:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/super/gyms — crear gym
const createGym = async (req, res) => {
  try {
    const { slug, name, logoUrl, email, phone, address, payphoneEnabled,
        bookingAdvanceDays, primaryColor, secondaryColor, theme, timezone } = req.body;

    if (!slug || !name) return res.status(400).json({ error: 'Slug y nombre son requeridos' });

    const exists = await db.query('SELECT id FROM gyms WHERE slug = $1', [slug]);
    if (exists.rows.length) return res.status(400).json({ error: 'El slug ya está en uso' });

    const result = await db.query(`
      INSERT INTO gyms (slug, name, logo_url, email, phone, address, payphone_enabled,
                        booking_advance_days, primary_color, secondary_color, theme, timezone)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [slug, name, logoUrl, email, phone, address,
        payphoneEnabled || false, bookingAdvanceDays || 7,
        primaryColor || '#E85D04', secondaryColor || '#000000', theme || 'classic_red',
        timezone || 'America/Guayaquil']);

    const newGymId = result.rows[0].id;

    // Crear planes automáticos al crear el gym
    await db.query(`
      INSERT INTO membership_types (gym_id, name, description, duration_value, duration_unit, price, is_active, is_public)
      VALUES ($1, 'Admin - Acceso Indefinido', 'Membresía gratuita para administradores', 99, 'years', 0, TRUE, FALSE)
    `, [newGymId]);

    await db.query(`
      INSERT INTO membership_types (gym_id, name, description, duration_value, duration_unit, price, is_active, is_public)
      VALUES ($1, 'Beca Staff', 'Membresía gratuita para instructores y recepcionistas', 1, 'years', 0, TRUE, FALSE)
    `, [newGymId]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error createGym:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// PUT /api/super/gyms/:gymId — actualizar gym
const updateGym = async (req, res) => {
  try {
    const { gymId } = req.params;
    const { name, logoUrl, email, phone, address, payphoneEnabled,
        bookingAdvanceDays, primaryColor, secondaryColor, theme, isActive, timezone } = req.body;

    const result = await db.query(`
      UPDATE gyms SET
        name = COALESCE($1, name),
        logo_url = COALESCE($2, logo_url),
        email = COALESCE($3, email),
        phone = COALESCE($4, phone),
        address = COALESCE($5, address),
        payphone_enabled = COALESCE($6, payphone_enabled),
        booking_advance_days = COALESCE($7, booking_advance_days),
        primary_color = COALESCE($8, primary_color),
        secondary_color = COALESCE($9, secondary_color),
        theme = COALESCE($10, theme),
        is_active = COALESCE($11, is_active),
        timezone = COALESCE($13, timezone),
        updated_at = NOW()
      WHERE id = $12
      RETURNING *
    `, [name, logoUrl, email, phone, address, payphoneEnabled,
        bookingAdvanceDays, primaryColor, secondaryColor, theme, isActive, gymId, timezone]);

    if (!result.rows.length) return res.status(404).json({ error: 'Gym no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updateGym:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// PATCH /api/super/gyms/:gymId/toggle — activar/desactivar gym
const toggleGym = async (req, res) => {
  try {
    const { gymId } = req.params;
    const result = await db.query(
      'UPDATE gyms SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1 RETURNING id, is_active',
      [gymId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Gym no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/super/gyms/:gymId/admins — listar admins de un gym
const getGymAdmins = async (req, res) => {
  try {
    const { gymId } = req.params;
    const result = await db.query(`
      SELECT u.id, u.cedula, u.name, u.email, u.phone, ugr.is_active, ugr.created_at
      FROM user_gym_roles ugr
      JOIN users u ON u.id = ugr.user_id
      WHERE ugr.gym_id = $1 AND ugr.role = 'admin'
      ORDER BY ugr.created_at ASC
    `, [gymId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/super/gyms/:gymId/admins — agregar admin a gym
const addGymAdmin = async (req, res) => {
  try {
    const { gymId } = req.params;
    const { cedula, name, password } = req.body;

    if (!cedula) return res.status(400).json({ error: 'Cédula requerida' });

    // ¿El usuario ya existe?
    let userResult = await db.query('SELECT id FROM users WHERE cedula = $1', [cedula]);
    let userId;

    if (userResult.rows.length) {
      userId = userResult.rows[0].id;
    } else {
      // Crear usuario nuevo
      if (!name || !password) {
        return res.status(400).json({ error: 'Nombre y contraseña requeridos para nuevo usuario' });
      }
      const hash = await bcrypt.hash(password, 10);
      const newUser = await db.query(
        'INSERT INTO users (cedula, name, password_hash) VALUES ($1, $2, $3) RETURNING id',
        [cedula, name, hash]
      );
      userId = newUser.rows[0].id;
    }

    // Asignar rol admin en este gym
    await db.query(`
      INSERT INTO user_gym_roles (user_id, gym_id, role)
      VALUES ($1, $2, 'admin')
      ON CONFLICT (user_id, gym_id, role) DO UPDATE SET is_active = TRUE
    `, [userId, gymId]);

    // Asignar membresía indefinida automática al admin
    const adminPlan = await db.query(
      `SELECT id FROM membership_types WHERE gym_id = $1 AND name = 'Admin - Acceso Indefinido' LIMIT 1`,
      [gymId]
    );

    if (adminPlan.rows.length) {
      const startDate = new Date();
      const endDate = new Date();
      endDate.setFullYear(endDate.getFullYear() + 99);

      await db.query(`
        INSERT INTO memberships (user_id, gym_id, membership_type_id, start_date, end_date, status)
        VALUES ($1, $2, $3, $4, $5, 'active')
        ON CONFLICT DO NOTHING
      `, [userId, gymId, adminPlan.rows[0].id,
          startDate.toISOString().split('T')[0],
          endDate.toISOString().split('T')[0]]);
    }

    res.status(201).json({ message: 'Administrador agregado exitosamente' });
  } catch (err) {
    console.error('Error addGymAdmin:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// DELETE /api/super/gyms/:gymId/admins/:userId — quitar admin
const removeGymAdmin = async (req, res) => {
  try {
    const { gymId, userId } = req.params;
    await db.query(
      `UPDATE user_gym_roles SET is_active = FALSE 
       WHERE user_id = $1 AND gym_id = $2 AND role = 'admin'`,
      [userId, gymId]
    );
    res.json({ message: 'Administrador removido' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/super/gyms/:gymId/membership-plans — planes de un gym
const getGymMembershipPlans = async (req, res) => {
  try {
    const { gymId } = req.params;
    const result = await db.query(
      'SELECT * FROM membership_types WHERE gym_id = $1 ORDER BY price ASC',
      [gymId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/super/gyms/:gymId/membership-plans — crear plan
const createMembershipPlan = async (req, res) => {
  try {
    const { gymId } = req.params;
    const { name, description, durationValue, durationUnit, price, sessionsPerWeek, isActive } = req.body;

    const result = await db.query(`
      INSERT INTO membership_types (gym_id, name, description, duration_value, duration_unit, price, sessions_per_week, is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [gymId, name, description, durationValue || 1, durationUnit || 'months', price || 0, sessionsPerWeek, isActive !== false]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error createMembershipPlan:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/super/reports — reporte global del sistema
const getGlobalReport = async (req, res) => {
  try {
    // KPIs globales
    const kpis = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM gyms WHERE is_active = TRUE) as active_gyms,
        (SELECT COUNT(DISTINCT user_id) FROM user_gym_roles WHERE role = 'user' AND is_active = TRUE) as total_users,
        (SELECT COUNT(*) FROM memberships WHERE status = 'active' AND end_date >= CURRENT_DATE) as active_memberships,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'pagado' AND created_at >= DATE_TRUNC('month', NOW())) as monthly_revenue
    `);

    // Nuevas suscripciones últimos 30 días por día
    const subscriptions = await db.query(`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM memberships
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `);

    // Recaudación diaria últimos 30 días
    const dailyRevenue = await db.query(`
      SELECT DATE(created_at) as date, SUM(amount) as total
      FROM payments
      WHERE status = 'pagado' AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `);

    // Desempeño por gym
    const gymPerformance = await db.query(`
      SELECT 
        g.id, g.name, g.is_active,
        COUNT(DISTINCT ugr.user_id) FILTER (WHERE ugr.role = 'user') as total_users,
        COUNT(DISTINCT m.id) FILTER (WHERE m.status = 'active' AND m.end_date >= CURRENT_DATE) as active_memberships,
        COUNT(DISTINCT a.id) FILTER (WHERE a.check_in_time >= NOW() - INTERVAL '30 days') as attendance_30d,
        COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'pagado' AND p.created_at >= DATE_TRUNC('month', NOW())), 0) as monthly_revenue
      FROM gyms g
      LEFT JOIN user_gym_roles ugr ON ugr.gym_id = g.id
      LEFT JOIN memberships m ON m.gym_id = g.id
      LEFT JOIN attendance a ON a.gym_id = g.id
      LEFT JOIN payments p ON p.gym_id = g.id
      GROUP BY g.id, g.name, g.is_active
      ORDER BY monthly_revenue DESC
    `);

    // Distribución de pagos por método
    const paymentDistribution = await db.query(`
      SELECT method, COUNT(*) as count, SUM(amount) as total
      FROM payments
      WHERE status = 'pagado' AND created_at >= DATE_TRUNC('month', NOW())
      GROUP BY method
    `);

    res.json({
      kpis: kpis.rows[0],
      subscriptions: subscriptions.rows,
      dailyRevenue: dailyRevenue.rows,
      gymPerformance: gymPerformance.rows,
      paymentDistribution: paymentDistribution.rows
    });
  } catch (err) {
    console.error('Error getGlobalReport:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/super/themes — listar temas del marketplace
const getThemes = async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM themes WHERE is_active = TRUE ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/super/gyms/:gymId/apply-theme — aplicar tema a un gym
const applyTheme = async (req, res) => {
  try {
    const { gymId } = req.params;
    const { themeSlug } = req.body;

    const theme = await db.query('SELECT * FROM themes WHERE slug = $1', [themeSlug]);
    if (!theme.rows.length) return res.status(404).json({ error: 'Tema no encontrado' });

    const t = theme.rows[0];
    await db.query(`
      UPDATE gyms SET 
        theme = $1, primary_color = $2, secondary_color = $3, updated_at = NOW()
      WHERE id = $4
    `, [t.slug, t.primary_color, t.secondary_color, gymId]);

    res.json({ message: 'Tema aplicado exitosamente', theme: t });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// DELETE gym — eliminar gym y todos sus datos
const deleteGym = async (req, res) => {
  try {
    const { gymId } = req.params;
    await db.query('DELETE FROM gyms WHERE id = $1', [gymId]);
    res.json({ message: 'Gimnasio eliminado exitosamente' });
  } catch (err) {
    console.error('Error deleteGym:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/super/saas-plans — listar planes
const getSaasPlans = async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM saas_plans ORDER BY sort_order ASC, price ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error getSaasPlans:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/super/saas-plans — crear plan
const createSaasPlan = async (req, res) => {
  try {
    const { name, maxUsers, price, sortOrder } = req.body;
    if (!name || price == null) return res.status(400).json({ error: 'Nombre y precio requeridos' });
    const result = await db.query(
      'INSERT INTO saas_plans (name, max_users, price, sort_order) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, maxUsers || null, price, sortOrder || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error createSaasPlan:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// PUT /api/super/saas-plans/:id — editar plan
const updateSaasPlan = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, maxUsers, price, isActive, sortOrder } = req.body;
    const result = await db.query(
      'UPDATE saas_plans SET name=$1, max_users=$2, price=$3, is_active=$4, sort_order=$5 WHERE id=$6 RETURNING *',
      [name, maxUsers || null, price, isActive !== false, sortOrder || 0, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Plan no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updateSaasPlan:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/super/gyms/:gymId/assign-plan — asignar plan a un gym
const assignPlanToGym = async (req, res) => {
  try {
    const { gymId } = req.params;
    const { planId, customPrice, customMaxUsers, startDate } = req.body;

    let price, maxUsers, planIdToSave;

    if (planId === 'custom') {
      // Plan personalizado
      if (customPrice == null) return res.status(400).json({ error: 'Precio personalizado requerido' });
      price = customPrice;
      maxUsers = customMaxUsers || null;
      planIdToSave = null;
    } else {
      // Plan predefinido
      const plan = await db.query('SELECT * FROM saas_plans WHERE id=$1', [planId]);
      if (!plan.rows.length) return res.status(404).json({ error: 'Plan no encontrado' });
      price = plan.rows[0].price;
      maxUsers = plan.rows[0].max_users;
      planIdToSave = planId;
    }

    const start = startDate || new Date().toISOString().split('T')[0];
    // Próximo pago: un mes después del inicio
    const nextPayment = new Date(start + 'T00:00:00');
    nextPayment.setMonth(nextPayment.getMonth() + 1);

    await db.query(`
      UPDATE gyms SET
        saas_plan_id = $1, saas_price = $2, saas_max_users = $3,
        saas_status = 'active', saas_start_date = $4, saas_next_payment = $5
      WHERE id = $6
    `, [planIdToSave, price, maxUsers, start, nextPayment.toISOString().split('T')[0], gymId]);

    res.json({ message: 'Plan asignado exitosamente' });
  } catch (err) {
    console.error('Error assignPlanToGym:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/super/gyms/:gymId/register-payment — registrar pago del gym
const registerGymPayment = async (req, res) => {
  try {
    const { gymId } = req.params;
    const { amount, notes, months } = req.body;
    const monthsToAdd = parseInt(months) || 1;

    const gym = await db.query('SELECT saas_price, saas_next_payment FROM gyms WHERE id=$1', [gymId]);
    if (!gym.rows.length) return res.status(404).json({ error: 'Gym no encontrado' });

    const currentNext = gym.rows[0].saas_next_payment;
    const periodStart = currentNext
      ? new Date(currentNext).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0];

    // Extender según los meses pagados
    const [py, pm, pd] = periodStart.split('-').map(Number);
    const periodEnd = new Date(Date.UTC(py, pm - 1, pd));
    periodEnd.setUTCMonth(periodEnd.getUTCMonth() + monthsToAdd);
    const periodEndStr = periodEnd.toISOString().split('T')[0];

    await db.query(`
      INSERT INTO gym_subscription_payments (gym_id, amount, period_start, period_end, notes, registered_by, months_covered)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [gymId, amount || gym.rows[0].saas_price, periodStart, periodEndStr, notes || null, req.user.id, monthsToAdd]);

    await db.query(`
      UPDATE gyms SET saas_next_payment = $1, saas_status = 'active', saas_billing_months = $2 WHERE id = $3
    `, [periodEndStr, monthsToAdd, gymId]);

    res.json({ message: 'Pago registrado', nextPayment: periodEndStr, monthsCovered: monthsToAdd });
  } catch (err) {
    console.error('Error registerGymPayment:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/super/gyms/:gymId/toggle-suspension — suspender/reactivar gym
const toggleGymSuspension = async (req, res) => {
  try {
    const { gymId } = req.params;
    const { suspend } = req.body;
    const newStatus = suspend ? 'suspended' : 'active';
    await db.query('UPDATE gyms SET saas_status=$1 WHERE id=$2', [newStatus, gymId]);
    res.json({ message: suspend ? 'Gym suspendido' : 'Gym reactivado' });
  } catch (err) {
    console.error('Error toggleGymSuspension:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/super/subscriptions — lista de gyms con estado de suscripción y conteo de usuarios
const getSubscriptions = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT g.id, g.name, g.slug, g.saas_status, g.saas_price, g.saas_max_users,
             g.saas_start_date, g.saas_next_payment,
             sp.name as plan_name,
             (SELECT COUNT(*) FROM user_gym_roles ugr 
              WHERE ugr.gym_id = g.id AND ugr.role = 'user' AND ugr.is_active = TRUE
              AND ugr.user_id NOT IN (
                SELECT user_id FROM user_gym_roles WHERE gym_id = g.id AND role IN ('admin','instructor','recepcionista') AND is_active = TRUE
              )) as current_users,
             (g.saas_next_payment - CURRENT_DATE) as days_to_payment
      FROM gyms g
      LEFT JOIN saas_plans sp ON sp.id = g.saas_plan_id
      WHERE g.is_active = TRUE
      ORDER BY g.saas_next_payment ASC NULLS LAST
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error getSubscriptions:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/super/gyms/:gymId/payments — historial de pagos de un gym
const getGymPayments = async (req, res) => {
  try {
    const { gymId } = req.params;
    const result = await db.query(
      'SELECT * FROM gym_subscription_payments WHERE gym_id=$1 ORDER BY paid_at DESC',
      [gymId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error getGymPayments:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/super/billing-periods — listar períodos de facturación
const getBillingPeriods = async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM saas_billing_periods WHERE is_active = TRUE ORDER BY sort_order ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error getBillingPeriods:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

module.exports = {
  getGyms, createGym, updateGym, toggleGym, deleteGym,
  getGymAdmins, addGymAdmin, removeGymAdmin,
  getGymMembershipPlans, createMembershipPlan,
  getGlobalReport, getThemes, applyTheme,
  getSaasPlans, createSaasPlan, updateSaasPlan,
  assignPlanToGym, registerGymPayment, toggleGymSuspension,
  getSubscriptions, getGymPayments, getBillingPeriods
};
