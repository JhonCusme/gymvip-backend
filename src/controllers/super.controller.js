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
            bookingAdvanceDays, primaryColor, secondaryColor, theme } = req.body;

    if (!slug || !name) return res.status(400).json({ error: 'Slug y nombre son requeridos' });

    // Verificar slug único
    const exists = await db.query('SELECT id FROM gyms WHERE slug = $1', [slug]);
    if (exists.rows.length) return res.status(400).json({ error: 'El slug ya está en uso' });

    const result = await db.query(`
      INSERT INTO gyms (slug, name, logo_url, email, phone, address, payphone_enabled,
                        booking_advance_days, primary_color, secondary_color, theme)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [slug, name, logoUrl, email, phone, address,
        payphoneEnabled || false, bookingAdvanceDays || 7,
        primaryColor || '#E85D04', secondaryColor || '#000000', theme || 'classic_red']);

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
            bookingAdvanceDays, primaryColor, secondaryColor, theme, isActive } = req.body;

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
        updated_at = NOW()
      WHERE id = $12
      RETURNING *
    `, [name, logoUrl, email, phone, address, payphoneEnabled,
        bookingAdvanceDays, primaryColor, secondaryColor, theme, isActive, gymId]);

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

module.exports = {
  getGyms, createGym, updateGym, toggleGym, deleteGym,
  getGymAdmins, addGymAdmin, removeGymAdmin,
  getGymMembershipPlans, createMembershipPlan,
  getGlobalReport, getThemes, applyTheme
};
