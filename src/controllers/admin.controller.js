const bcrypt = require('bcryptjs');
const db = require('../config/database');

// ============================================================
// USUARIOS
// ============================================================

// GET /api/admin/users
const getUsers = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const { search, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE ugr.gym_id = $1 AND ugr.role = \'user\'';
    const params = [gymId];

    if (search) {
      params.push(`%${search}%`);
      whereClause += ` AND (u.name ILIKE $${params.length} OR u.cedula ILIKE $${params.length} OR u.email ILIKE $${params.length})`;
    }

    const result = await db.query(`
      SELECT 
        u.id, u.cedula, u.name, u.email, u.phone, u.is_active, u.created_at,
        ugr.role,
        CASE 
          WHEN m.id IS NOT NULL AND m.end_date >= CURRENT_DATE THEN mt.name
          ELSE 'Sin membresía'
        END as membership_name,
        CASE 
          WHEN m.id IS NOT NULL AND m.end_date >= CURRENT_DATE THEN 'active'
          ELSE 'inactive'
        END as membership_status
      FROM user_gym_roles ugr
      JOIN users u ON u.id = ugr.user_id
      LEFT JOIN LATERAL (
        SELECT m2.id, m2.end_date, m2.membership_type_id 
        FROM memberships m2 
        WHERE m2.user_id = u.id AND m2.gym_id = $1 AND m2.status = 'active' AND m2.end_date >= CURRENT_DATE
        ORDER BY m2.end_date DESC LIMIT 1
      ) m ON TRUE
      LEFT JOIN membership_types mt ON mt.id = m.membership_type_id
      ${whereClause}
      AND ugr.is_active = TRUE
      ORDER BY u.name ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    const countResult = await db.query(`
      SELECT COUNT(*) FROM user_gym_roles ugr
      JOIN users u ON u.id = ugr.user_id
      ${whereClause} AND ugr.is_active = TRUE
    `, params);

    res.json({
      users: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      totalPages: Math.ceil(countResult.rows[0].count / limit)
    });
  } catch (err) {
    console.error('Error getUsers:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/admin/users/:userId
const getUserDetail = async (req, res) => {
  try {
    const { userId } = req.params;
    const gymId = req.gym.id;

    const userResult = await db.query(`
      SELECT u.id, u.cedula, u.name, u.email, u.phone, u.birth_date,
             u.emergency_contact_name, u.emergency_contact_phone, u.is_active, u.created_at, u.qr_code
      FROM users u
      JOIN user_gym_roles ugr ON ugr.user_id = u.id AND ugr.gym_id = $2
      WHERE u.id = $1
    `, [userId, gymId]);

    if (!userResult.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Membresías
    const memberships = await db.query(`
      SELECT m.*, mt.name as type_name, mt.duration_value, mt.duration_unit
      FROM memberships m
      JOIN membership_types mt ON mt.id = m.membership_type_id
      WHERE m.user_id = $1 AND m.gym_id = $2
      ORDER BY m.created_at DESC LIMIT 10
    `, [userId, gymId]);

    // Reservas recientes
    const bookings = await db.query(`
      SELECT b.id, b.status, ci.class_date, ci.start_time, ci.end_time, s.name as session_name
      FROM bookings b
      JOIN class_instances ci ON ci.id = b.class_instance_id
      JOIN sessions s ON s.id = ci.session_id
      WHERE b.user_id = $1 AND b.gym_id = $2
      ORDER BY ci.class_date DESC LIMIT 5
    `, [userId, gymId]);

    res.json({
      user: userResult.rows[0],
      memberships: memberships.rows,
      recentBookings: bookings.rows
    });
  } catch (err) {
    console.error('Error getUserDetail:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/admin/users — crear usuario
const createUser = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const { cedula, name, email, phone, birthDate, emergencyContactName,
            emergencyContactPhone, password, role = 'user' } = req.body;

    if (!cedula || !name || !password) {
      return res.status(400).json({ error: 'Cédula, nombre y contraseña son requeridos' });
    }

    // Verificar si ya existe en este gym
    const existsInGym = await db.query(`
      SELECT u.id FROM users u
      JOIN user_gym_roles ugr ON ugr.user_id = u.id
      WHERE u.cedula = $1 AND ugr.gym_id = $2
    `, [cedula, gymId]);

    if (existsInGym.rows.length) {
      return res.status(400).json({ error: 'Ya existe un usuario con esa cédula en este gimnasio' });
    }

    const hash = await bcrypt.hash(password, 10);

    // Crear usuario
    const newUser = await db.query(`
      INSERT INTO users (cedula, name, email, phone, birth_date, emergency_contact_name, emergency_contact_phone, password_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [cedula, name, email, phone, birthDate, emergencyContactName, emergencyContactPhone, hash]);

    const userId = newUser.rows[0].id;

    // Asignar al gym con rol
    await db.query(
      'INSERT INTO user_gym_roles (user_id, gym_id, role) VALUES ($1, $2, $3)',
      [userId, gymId, role]
    );

    res.status(201).json({ message: 'Usuario creado exitosamente', userId });
  } catch (err) {
    console.error('Error createUser:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// PUT /api/admin/users/:userId — actualizar usuario
const updateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { name, email, phone, birthDate, emergencyContactName, emergencyContactPhone, isActive } = req.body;

    const result = await db.query(`
      UPDATE users SET
        name = COALESCE($1, name), email = COALESCE($2, email),
        phone = COALESCE($3, phone), birth_date = COALESCE($4, birth_date),
        emergency_contact_name = COALESCE($5, emergency_contact_name),
        emergency_contact_phone = COALESCE($6, emergency_contact_phone),
        is_active = COALESCE($7, is_active), updated_at = NOW()
      WHERE id = $8 RETURNING id, name, email, phone
    `, [name, email, phone, birthDate, emergencyContactName, emergencyContactPhone, isActive, userId]);

    if (!result.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/admin/users/:userId/reset-password
const resetUserPassword = async (req, res) => {
  try {
    const { userId } = req.params;
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Contraseña debe tener al menos 6 caracteres' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, userId]);
    res.json({ message: 'Contraseña reseteada exitosamente' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// ============================================================
// MEMBRESÍAS (Tipos)
// ============================================================
const getMembershipTypes = async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM membership_types WHERE gym_id = $1 ORDER BY price ASC',
      [req.gym.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

const createMembershipType = async (req, res) => {
  try {
    const { name, description, durationValue, durationUnit, price, sessionsPerWeek, isActive } = req.body;
    const result = await db.query(`
      INSERT INTO membership_types (gym_id, name, description, duration_value, duration_unit, price, sessions_per_week, is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [req.gym.id, name, description, durationValue || 1, durationUnit || 'months', price || 0, sessionsPerWeek, isActive !== false]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

const updateMembershipType = async (req, res) => {
  try {
    const { typeId } = req.params;
    const { name, description, durationValue, durationUnit, price, sessionsPerWeek, isActive } = req.body;
    const result = await db.query(`
      UPDATE membership_types SET
        name = COALESCE($1,name), description = COALESCE($2,description),
        duration_value = COALESCE($3,duration_value), duration_unit = COALESCE($4,duration_unit),
        price = COALESCE($5,price), sessions_per_week = COALESCE($6,sessions_per_week),
        is_active = COALESCE($7,is_active), updated_at = NOW()
      WHERE id = $8 AND gym_id = $9 RETURNING *
    `, [name, description, durationValue, durationUnit, price, sessionsPerWeek, isActive, typeId, req.gym.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Plan no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

const deleteMembershipType = async (req, res) => {
  try {
    const { typeId } = req.params;
    await db.query('DELETE FROM membership_types WHERE id = $1 AND gym_id = $2', [typeId, req.gym.id]);
    res.json({ message: 'Plan eliminado' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/admin/users/:userId/activate-membership
const activateMembership = async (req, res) => {
  try {
    const { userId } = req.params;
    const gymId = req.gym.id;
    const { membershipTypeId, method, amount, notes } = req.body;

    // Obtener el tipo de membresía
    const typeResult = await db.query(
      'SELECT * FROM membership_types WHERE id = $1 AND gym_id = $2',
      [membershipTypeId, gymId]
    );
    if (!typeResult.rows.length) return res.status(404).json({ error: 'Plan no encontrado' });
    const mType = typeResult.rows[0];

    // Calcular fechas
    const startDate = new Date();
    const endDate = new Date();
    const unit = mType.duration_unit;
    const value = mType.duration_value;

    if (unit === 'days') endDate.setDate(endDate.getDate() + value);
    else if (unit === 'weeks') endDate.setDate(endDate.getDate() + value * 7);
    else if (unit === 'months') endDate.setMonth(endDate.getMonth() + value);
    else if (unit === 'years') endDate.setFullYear(endDate.getFullYear() + value);

    // Crear membresía
    const memResult = await db.query(`
      INSERT INTO memberships (user_id, gym_id, membership_type_id, start_date, end_date, status)
      VALUES ($1,$2,$3,$4,$5,'active') RETURNING id
    `, [userId, gymId, membershipTypeId, startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0]]);

    // Registrar pago
    await db.query(`
      INSERT INTO payments (gym_id, user_id, membership_id, membership_type_id, amount, method, status, registered_by, notes)
      VALUES ($1,$2,$3,$4,$5,$6,'pagado',$7,$8)
    `, [gymId, userId, memResult.rows[0].id, membershipTypeId, amount || mType.price, method || 'efectivo', req.user.id, notes]);

    res.status(201).json({ message: 'Membresía activada exitosamente', membershipId: memResult.rows[0].id });
  } catch (err) {
    console.error('Error activateMembership:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// ============================================================
// SESIONES
// ============================================================
const getSessions = async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM sessions WHERE gym_id = $1 ORDER BY name', [req.gym.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

const createSession = async (req, res) => {
  try {
    const { name, description, maxCapacity, durationMinutes, difficulty, isActive } = req.body;
    const result = await db.query(`
      INSERT INTO sessions (gym_id, name, description, max_capacity, duration_minutes, difficulty, is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [req.gym.id, name, description, maxCapacity || 20, durationMinutes || 60, difficulty || 'beginner', isActive !== false]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

const updateSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { name, description, maxCapacity, durationMinutes, difficulty, isActive } = req.body;
    const result = await db.query(`
      UPDATE sessions SET name=COALESCE($1,name), description=COALESCE($2,description),
        max_capacity=COALESCE($3,max_capacity), duration_minutes=COALESCE($4,duration_minutes),
        difficulty=COALESCE($5,difficulty), is_active=COALESCE($6,is_active), updated_at=NOW()
      WHERE id=$7 AND gym_id=$8 RETURNING *
    `, [name, description, maxCapacity, durationMinutes, difficulty, isActive, sessionId, req.gym.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

const deleteSession = async (req, res) => {
  try {
    await db.query('DELETE FROM sessions WHERE id=$1 AND gym_id=$2', [req.params.sessionId, req.gym.id]);
    res.json({ message: 'Sesión eliminada' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// ============================================================
// HORARIOS
// ============================================================
const getSchedules = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT sch.*, s.name as session_name, s.max_capacity, s.duration_minutes,
             i.name as instructor_name
      FROM schedules sch
      JOIN sessions s ON s.id = sch.session_id
      LEFT JOIN instructors i ON i.id = sch.instructor_id
      WHERE sch.gym_id = $1 AND sch.is_active = TRUE
      ORDER BY sch.day_of_week, sch.start_time
    `, [req.gym.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

const createSchedule = async (req, res) => {
  try {
    const { sessionId, instructorId, dayOfWeek, startTime, endTime } = req.body;
    const result = await db.query(`
      INSERT INTO schedules (gym_id, session_id, instructor_id, day_of_week, start_time, end_time)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [req.gym.id, sessionId, instructorId, dayOfWeek, startTime, endTime]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

const deleteSchedule = async (req, res) => {
  try {
    await db.query('DELETE FROM schedules WHERE id=$1 AND gym_id=$2', [req.params.scheduleId, req.gym.id]);
    res.json({ message: 'Horario eliminado' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// ============================================================
// INSTRUCTORES
// ============================================================
const getInstructors = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT i.*, COUNT(sch.id) as schedule_count
      FROM instructors i
      LEFT JOIN schedules sch ON sch.instructor_id = i.id AND sch.is_active = TRUE
      WHERE i.gym_id = $1
      GROUP BY i.id ORDER BY i.name
    `, [req.gym.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

const createInstructor = async (req, res) => {
  try {
    const { name, photoUrl, specialization, phone, cedula, password, bio, isActive } = req.body;
    const gymId = req.gym.id;

    let userId = null;
    if (cedula && password) {
      // Crear cuenta de usuario para el instructor
      const hash = await bcrypt.hash(password, 10);
      const existUser = await db.query('SELECT id FROM users WHERE cedula = $1', [cedula]);
      if (!existUser.rows.length) {
        const newU = await db.query(
          'INSERT INTO users (cedula, name, phone, password_hash) VALUES ($1,$2,$3,$4) RETURNING id',
          [cedula, name, phone, hash]
        );
        userId = newU.rows[0].id;
      } else {
        userId = existUser.rows[0].id;
      }
      // Asignar rol instructor en el gym
      await db.query(`
        INSERT INTO user_gym_roles (user_id, gym_id, role) VALUES ($1,$2,'instructor')
        ON CONFLICT (user_id, gym_id, role) DO UPDATE SET is_active = TRUE
      `, [userId, gymId]);
    }

    const result = await db.query(`
      INSERT INTO instructors (gym_id, user_id, name, photo_url, specialization, phone, bio, is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [gymId, userId, name, photoUrl, specialization, phone, bio, isActive !== false]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error createInstructor:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

const updateInstructor = async (req, res) => {
  try {
    const { instructorId } = req.params;
    const { name, photoUrl, specialization, phone, bio, isActive } = req.body;
    const result = await db.query(`
      UPDATE instructors SET name=COALESCE($1,name), photo_url=COALESCE($2,photo_url),
        specialization=COALESCE($3,specialization), phone=COALESCE($4,phone),
        bio=COALESCE($5,bio), is_active=COALESCE($6,is_active), updated_at=NOW()
      WHERE id=$7 AND gym_id=$8 RETURNING *
    `, [name, photoUrl, specialization, phone, bio, isActive, instructorId, req.gym.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

const deleteInstructor = async (req, res) => {
  try {
    await db.query('UPDATE instructors SET is_active=FALSE WHERE id=$1 AND gym_id=$2', [req.params.instructorId, req.gym.id]);
    res.json({ message: 'Instructor desactivado' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// ============================================================
// RECEPCIONISTAS
// ============================================================
const getReceptionists = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT u.id, u.cedula, u.name, u.email, u.phone, u.is_active, ugr.created_at
      FROM user_gym_roles ugr JOIN users u ON u.id = ugr.user_id
      WHERE ugr.gym_id = $1 AND ugr.role = 'recepcionista' AND ugr.is_active = TRUE
      ORDER BY u.name
    `, [req.gym.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

const createReceptionist = async (req, res) => {
  try {
    const { cedula, name, email, phone, password } = req.body;
    if (!cedula || !name || !password) return res.status(400).json({ error: 'Campos requeridos faltantes' });

    const hash = await bcrypt.hash(password, 10);
    let userId;
    const exists = await db.query('SELECT id FROM users WHERE cedula=$1', [cedula]);
    if (exists.rows.length) {
      userId = exists.rows[0].id;
    } else {
      const newU = await db.query(
        'INSERT INTO users (cedula,name,email,phone,password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [cedula, name, email, phone, hash]
      );
      userId = newU.rows[0].id;
    }
    await db.query(`
      INSERT INTO user_gym_roles (user_id, gym_id, role) VALUES ($1,$2,'recepcionista')
      ON CONFLICT (user_id, gym_id, role) DO UPDATE SET is_active = TRUE
    `, [userId, req.gym.id]);

    res.status(201).json({ message: 'Recepcionista creado exitosamente' });
  } catch (err) {
    console.error('Error createReceptionist:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// ============================================================
// PAGOS
// ============================================================
const getPayments = async (req, res) => {
  try {
    const { dateFrom, dateTo, method, status = 'pagado', page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    const params = [req.gym.id];
    let conditions = 'WHERE p.gym_id = $1';

    if (dateFrom) { params.push(dateFrom); conditions += ` AND DATE(p.created_at) >= $${params.length}`; }
    if (dateTo) { params.push(dateTo); conditions += ` AND DATE(p.created_at) <= $${params.length}`; }
    if (method && method !== 'todos') { params.push(method); conditions += ` AND p.method = $${params.length}`; }
    if (status && status !== 'todos') { params.push(status); conditions += ` AND p.status = $${params.length}`; }

    const result = await db.query(`
      SELECT p.*, u.name as client_name, u.cedula as client_cedula,
             mt.name as membership_name, rb.name as registered_by_name
      FROM payments p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN membership_types mt ON mt.id = p.membership_type_id
      LEFT JOIN users rb ON rb.id = p.registered_by
      ${conditions}
      ORDER BY p.created_at DESC
      LIMIT $${params.length+1} OFFSET $${params.length+2}
    `, [...params, limit, offset]);

    res.json({ payments: result.rows });
  } catch (err) {
    console.error('Error getPayments:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// ============================================================
// REPORTES DEL GYM
// ============================================================
const getReports = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const { period = 'month' } = req.query;

 const dateFilter = period === 'year'
  ? `AND created_at >= DATE_TRUNC('year', NOW())`
  : `AND created_at >= DATE_TRUNC('month', NOW())`;

    const revenue = await db.query(`
      SELECT 
        COALESCE(SUM(amount) FILTER (WHERE method = 'efectivo'), 0) as efectivo,
        COALESCE(SUM(amount) FILTER (WHERE method IN ('tarjeta','transferencia')), 0) as tarjeta_transfer,
        COALESCE(SUM(amount) FILTER (WHERE method = 'payphone'), 0) as payphone,
        COALESCE(SUM(amount), 0) as total
      FROM payments WHERE gym_id = $1 AND status = 'pagado' ${dateFilter}
    `, [gymId]);

    const dailyRevenue = await db.query(`
      SELECT DATE(created_at) as date, SUM(amount) as total
      FROM payments WHERE gym_id = $1 AND status = 'pagado' ${dateFilter}
      GROUP BY DATE(created_at) ORDER BY date ASC
    `, [gymId]);

    const membershipsByType = await db.query(`
      SELECT mt.name, COUNT(m.id) as count
      FROM memberships m JOIN membership_types mt ON mt.id = m.membership_type_id
      WHERE m.gym_id = $1 AND m.status = 'active'
      GROUP BY mt.name ORDER BY count DESC
    `, [gymId]);

    const expiringSoon = await db.query(`
      SELECT u.name, u.cedula, u.phone, m.end_date,
             (m.end_date - CURRENT_DATE) as days_remaining
      FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.gym_id = $1 AND m.status = 'active'
        AND m.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
      ORDER BY m.end_date ASC
    `, [gymId]);

    res.json({
      revenue: revenue.rows[0],
      dailyRevenue: dailyRevenue.rows,
      membershipsByType: membershipsByType.rows,
      expiringSoon: expiringSoon.rows
    });
  } catch (err) {
    console.error('Error getReports:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// ============================================================
// DASHBOARD DEL GYM
// ============================================================
const getDashboard = async (req, res) => {
  try {
    const gymId = req.gym.id;

    const kpis = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM user_gym_roles WHERE gym_id=$1 AND role='user' AND is_active=TRUE) as total_users,
        (SELECT COUNT(*) FROM memberships WHERE gym_id=$1 AND status='active' AND end_date>=CURRENT_DATE) as active_members,
        (SELECT COUNT(*) FROM bookings b JOIN class_instances ci ON ci.id=b.class_instance_id WHERE b.gym_id=$1 AND ci.class_date=CURRENT_DATE AND b.status='confirmed') as reservas_hoy,
        (SELECT COUNT(*) FROM memberships WHERE gym_id=$1 AND status='active' AND end_date BETWEEN CURRENT_DATE AND CURRENT_DATE+7) as por_vencer
    `, [gymId]);

    const monthlyRevenue = await db.query(`
      SELECT COALESCE(SUM(amount),0) as total,
             ROUND(((SUM(amount) - LAG(SUM(amount)) OVER (ORDER BY DATE_TRUNC('month',created_at))) / NULLIF(LAG(SUM(amount)) OVER (ORDER BY DATE_TRUNC('month',created_at)),0) * 100)::numeric,2) as growth
      FROM payments WHERE gym_id=$1 AND status='pagado'
        AND created_at >= DATE_TRUNC('month',NOW()) - INTERVAL '1 month'
      GROUP BY DATE_TRUNC('month',created_at) ORDER BY 1 DESC LIMIT 1
    `, [gymId]);

    const weeklyRevenue = await db.query(`
      SELECT DATE_TRUNC('week',created_at) as week, SUM(amount) as total
      FROM payments WHERE gym_id=$1 AND status='pagado'
        AND created_at >= DATE_TRUNC('month',NOW())
      GROUP BY DATE_TRUNC('week',created_at) ORDER BY week ASC
    `, [gymId]);

    const todayAttendance = await db.query(`
      SELECT u.name, u.cedula, a.check_in_time, a.method
      FROM attendance a JOIN users u ON u.id=a.user_id
      WHERE a.gym_id=$1 AND DATE(a.check_in_time)=CURRENT_DATE
      ORDER BY a.check_in_time DESC LIMIT 20
    `, [gymId]);

    res.json({
      kpis: kpis.rows[0],
      monthlyRevenue: monthlyRevenue.rows[0] || { total: 0, growth: 0 },
      weeklyRevenue: weeklyRevenue.rows,
      todayAttendance: todayAttendance.rows
    });
  } catch (err) {
    console.error('Error getDashboard:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// ============================================================
// AUDITORÍA RECEPCIÓN
// ============================================================
const getReceptionAudit = async (req, res) => {
  try {
    const { dateFrom, dateTo, receptionistId, action, page = 1, limit = 50 } = req.query;
    const params = [req.gym.id];
    let conditions = 'WHERE ra.gym_id = $1';

    if (dateFrom) { params.push(dateFrom); conditions += ` AND DATE(ra.created_at) >= $${params.length}`; }
    if (dateTo) { params.push(dateTo); conditions += ` AND DATE(ra.created_at) <= $${params.length}`; }
    if (receptionistId) { params.push(receptionistId); conditions += ` AND ra.receptionist_id = $${params.length}`; }
    if (action && action !== 'todas') { params.push(action); conditions += ` AND ra.action = $${params.length}`; }

    const result = await db.query(`
      SELECT ra.*, r.name as receptionist_name, u.name as client_name,
             u.cedula as client_cedula,
             ci.class_date, s.name as class_name
      FROM receptionists_audit ra
      JOIN users r ON r.id = ra.receptionist_id
      LEFT JOIN users u ON u.id = ra.target_user_id
      LEFT JOIN class_instances ci ON ci.id = ra.class_instance_id
      LEFT JOIN sessions s ON s.id = ci.session_id
      ${conditions}
      ORDER BY ra.created_at DESC
      LIMIT $${params.length+1} OFFSET $${(params.length+2)}
    `, [...params, limit, (page-1)*limit]);

    res.json({ records: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// ============================================================
// HISTORIAL DE INGRESOS (ATTENDANCE)
// ============================================================
const getAttendanceHistory = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const { dateFrom, dateTo } = req.query;

    let dateCondition = '';
    const params = [gymId];
    
    if (dateFrom) { 
      params.push(dateFrom); 
      dateCondition += ` AND DATE(check_in_time) >= $${params.length}`; 
    }
    if (dateTo) { 
      params.push(dateTo); 
      dateCondition += ` AND DATE(check_in_time) <= $${params.length}`; 
    }

    const kpis = await db.query(`
      SELECT 
        COUNT(*) as total_ingresos,
        COUNT(DISTINCT user_id) as usuarios_unicos,
        COUNT(DISTINCT membership_id) as membresias_validas,
        COALESCE(
          (SELECT EXTRACT(HOUR FROM check_in_time)::text || ':00'
           FROM attendance 
           WHERE gym_id = $1 ${dateCondition}
           GROUP BY EXTRACT(HOUR FROM check_in_time)
           ORDER BY COUNT(*) DESC LIMIT 1),
          '--:--'
        ) as hora_pico
      FROM attendance
      WHERE gym_id = $1 ${dateCondition}
    `, params);

    const byDay = await db.query(`
      SELECT DATE(check_in_time) as date, COUNT(*) as count
      FROM attendance WHERE gym_id = $1 ${dateCondition}
      GROUP BY DATE(check_in_time) ORDER BY date ASC
    `, params);

    const heatmap = await db.query(`
      SELECT EXTRACT(DOW FROM check_in_time)::int as day_of_week,
             EXTRACT(HOUR FROM check_in_time)::int as hour,
             COUNT(*) as count
      FROM attendance WHERE gym_id = $1 ${dateCondition}
      GROUP BY day_of_week, hour
    `, params);

    res.json({ kpis: kpis.rows[0], byDay: byDay.rows, heatmap: heatmap.rows });
  } catch (err) {
    console.error('Error getAttendanceHistory:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// ============================================================
// VALIDAR INGRESO (QR / CÉDULA)
// ============================================================
const validateEntry = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const { code } = req.body; // puede ser qr_code o cédula

    if (!code) return res.status(400).json({ error: 'Código requerido' });

    // Buscar usuario por QR o cédula
    const userResult = await db.query(`
      SELECT u.id, u.name, u.cedula, u.qr_code
      FROM users u
      JOIN user_gym_roles ugr ON ugr.user_id = u.id AND ugr.gym_id = $1
      WHERE (u.qr_code = $2 OR u.cedula = $2) AND ugr.is_active = TRUE
    `, [gymId, code]);

    if (!userResult.rows.length) {
      return res.status(404).json({ valid: false, error: 'Usuario no encontrado en este gimnasio' });
    }

    const user = userResult.rows[0];

    // Verificar membresía activa
    const memResult = await db.query(`
      SELECT m.id, mt.name as type_name, m.end_date, m.status
      FROM memberships m JOIN membership_types mt ON mt.id = m.membership_type_id
      WHERE m.user_id = $1 AND m.gym_id = $2 AND m.status = 'active' AND m.end_date >= CURRENT_DATE
      ORDER BY m.end_date DESC LIMIT 1
    `, [user.id, gymId]);

    if (!memResult.rows.length) {
      return res.json({
        valid: false,
        user: { name: user.name, cedula: user.cedula },
        error: 'Membresía vencida o sin membresía'
      });
    }

    const membership = memResult.rows[0];

    // Registrar ingreso
    await db.query(`
      INSERT INTO attendance (gym_id, user_id, membership_id, method, validated_by)
      VALUES ($1,$2,$3,'qr',$4)
    `, [gymId, user.id, membership.id, req.user.id]);

    res.json({
      valid: true,
      user: { name: user.name, cedula: user.cedula },
      membership: { typeName: membership.type_name, endDate: membership.end_date }
    });
  } catch (err) {
    console.error('Error validateEntry:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

module.exports = {
  getDashboard, getUsers, getUserDetail, createUser, updateUser, resetUserPassword,
  getMembershipTypes, createMembershipType, updateMembershipType, deleteMembershipType,
  activateMembership, getSessions, createSession, updateSession, deleteSession,
  getSchedules, createSchedule, deleteSchedule,
  getInstructors, createInstructor, updateInstructor, deleteInstructor,
  getReceptionists, createReceptionist,
  getPayments, getReports, getReceptionAudit, getAttendanceHistory, validateEntry
};
