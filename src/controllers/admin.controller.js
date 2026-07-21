const bcrypt = require('bcryptjs');
const db = require('../config/database');
const { decrypt } = require('../utils/crypto');
const { canAddUser } = require('../utils/planLimits');
// ============================================================
// USUARIOS
// ============================================================

// GET /api/admin/users
const getUsers = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const { search, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = `WHERE ugr.gym_id = $1 AND ugr.role = 'user'
      AND ugr.user_id NOT IN (
        SELECT user_id FROM user_gym_roles 
        WHERE gym_id = $1 AND role IN ('admin', 'instructor', 'recepcionista') AND is_active = TRUE
      )`;
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

    // Verificar límite del plan (solo para clientes)
    if (role === 'user') {
      const limitCheck = await canAddUser(gymId);
      if (!limitCheck.allowed) {
        return res.status(403).json({ error: limitCheck.reason });
      }
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
    const { name, description, durationValue, durationUnit, price, sessionsPerWeek, isActive, isPublic, recurringDiscount } = req.body;
    const result = await db.query(`
      INSERT INTO membership_types (gym_id, name, description, duration_value, duration_unit, price, sessions_per_week, is_active, is_public, recurring_discount)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [req.gym.id, name, description, durationValue || 1, durationUnit || 'months', price || 0, sessionsPerWeek, isActive !== false, isPublic !== false, recurringDiscount || 0]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error createMembershipType:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

const updateMembershipType = async (req, res) => {
  try {
    const { typeId } = req.params;
    const { name, description, durationValue, durationUnit, price, sessionsPerWeek, isActive, isPublic, recurringDiscount } = req.body;
    const result = await db.query(`
      UPDATE membership_types SET
        name = COALESCE($1,name), description = COALESCE($2,description),
        duration_value = COALESCE($3,duration_value), duration_unit = COALESCE($4,duration_unit),
        price = COALESCE($5,price), sessions_per_week = COALESCE($6,sessions_per_week),
        is_active = COALESCE($7,is_active), is_public = COALESCE($8,is_public),
        recurring_discount = COALESCE($9,recurring_discount),
        updated_at = NOW()
      WHERE id = $10 AND gym_id = $11 RETURNING *
    `, [name, description, durationValue, durationUnit, price, sessionsPerWeek, isActive, isPublic, recurringDiscount, typeId, req.gym.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Plan no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updateMembershipType:', err.message);
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
    const startDate = req.body.startDate ? new Date(req.body.startDate) : new Date();
    const endDate = new Date(startDate);
    const unit = mType.duration_unit;
    const value = mType.duration_value;

    if (unit === 'days') endDate.setDate(endDate.getDate() + value);
    else if (unit === 'weeks') endDate.setDate(endDate.getDate() + value * 7);
    else if (unit === 'months') endDate.setMonth(endDate.getMonth() + value);
    else if (unit === 'years') endDate.setFullYear(endDate.getFullYear() + value);


    // Expirar membresías activas anteriores del usuario
    await db.query(`
      UPDATE memberships SET status = 'expired'
      WHERE user_id = $1 AND gym_id = $2 AND status = 'active'
    `, [userId, gymId]);

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
      SELECT i.*, COUNT(sch.id) as schedule_count,
             u.cedula,
             EXISTS(
               SELECT 1 FROM user_gym_roles ugr 
               WHERE ugr.user_id = i.user_id AND ugr.gym_id = $1 
               AND ugr.role = 'user' AND ugr.is_active = TRUE
             ) as has_user_role,
             EXISTS(
               SELECT 1 FROM memberships m
               WHERE m.user_id = i.user_id AND m.gym_id = $1
               AND m.status = 'active' AND m.end_date >= CURRENT_DATE
             ) as has_active_membership
      FROM instructors i
      LEFT JOIN schedules sch ON sch.instructor_id = i.id AND sch.is_active = TRUE
      LEFT JOIN users u ON u.id = i.user_id
      WHERE i.gym_id = $1
      GROUP BY i.id, u.cedula ORDER BY i.name
    `, [req.gym.id]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error getInstructors:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

const createInstructor = async (req, res) => {
  try {
    const { name, photoUrl, specialization, phone, cedula, password, bio, isActive, isHeadCoach } = req.body;
    const gymId = req.gym.id;

    let userId = null;
    if (cedula && password) {
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
      await db.query(`
        INSERT INTO user_gym_roles (user_id, gym_id, role) VALUES ($1,$2,'instructor')
        ON CONFLICT (user_id, gym_id, role) DO UPDATE SET is_active = TRUE
      `, [userId, gymId]);
    }

    const result = await db.query(`
      INSERT INTO instructors (gym_id, user_id, name, photo_url, specialization, phone, bio, is_active, is_head_coach)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [gymId, userId, name, photoUrl, specialization, phone, bio, isActive !== false, isHeadCoach === true]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error createInstructor:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

const updateInstructor = async (req, res) => {
  try {
    const { instructorId } = req.params;
    const { name, photoUrl, specialization, phone, bio, isActive, isHeadCoach } = req.body;
    const result = await db.query(`
      UPDATE instructors SET name=COALESCE($1,name), photo_url=COALESCE($2,photo_url),
        specialization=COALESCE($3,specialization), phone=COALESCE($4,phone),
        bio=COALESCE($5,bio), is_active=COALESCE($6,is_active),
        is_head_coach=COALESCE($7,is_head_coach), updated_at=NOW()
      WHERE id=$8 AND gym_id=$9 RETURNING *
    `, [name, photoUrl, specialization, phone, bio, isActive, isHeadCoach, instructorId, req.gym.id]);
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
      SELECT u.id, u.cedula, u.name, u.email, u.phone, u.is_active, ugr.created_at,
             EXISTS(
               SELECT 1 FROM user_gym_roles ugr2 
               WHERE ugr2.user_id = u.id AND ugr2.gym_id = $1 
               AND ugr2.role = 'user' AND ugr2.is_active = TRUE
             ) as has_user_role,
             EXISTS(
               SELECT 1 FROM memberships m
               WHERE m.user_id = u.id AND m.gym_id = $1
               AND m.status = 'active' AND m.end_date >= CURRENT_DATE
             ) as has_active_membership
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

    const tz = req.gym.timezone || 'America/Guayaquil';
    const dailyRevenue = await db.query(`
      SELECT DATE(created_at AT TIME ZONE '${tz}') as date, SUM(amount) as total
      FROM payments WHERE gym_id = $1 AND status = 'pagado' ${dateFilter}
      GROUP BY DATE(created_at AT TIME ZONE '${tz}') ORDER BY date ASC
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
        (SELECT COUNT(*) FROM user_gym_roles ugr 
          JOIN users u ON u.id = ugr.user_id
          WHERE ugr.gym_id=$1 AND ugr.role='user' AND ugr.is_active=TRUE AND u.is_active=TRUE
          AND ugr.user_id NOT IN (
            SELECT user_id FROM user_gym_roles WHERE gym_id=$1 AND role IN ('admin','instructor','recepcionista') AND is_active=TRUE
          )) as total_users,
        (SELECT COUNT(*) FROM memberships m WHERE m.gym_id=$1 AND m.status='active' AND m.end_date>=CURRENT_DATE
          AND m.user_id NOT IN (
            SELECT user_id FROM user_gym_roles WHERE gym_id=$1 AND role IN ('admin','instructor','recepcionista') AND is_active=TRUE
          )) as active_members,
        (SELECT COUNT(*) FROM memberships m WHERE m.gym_id=$1 AND m.status='active' AND m.end_date>=CURRENT_DATE
          AND EXISTS (SELECT 1 FROM payments p WHERE p.membership_id=m.id AND p.method NOT IN ('cortesia','beca'))
        ) as paid_members,
        (SELECT COUNT(*) FROM memberships m WHERE m.gym_id=$1 AND m.status='active' AND m.end_date>=CURRENT_DATE
          AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.membership_id=m.id AND p.method NOT IN ('cortesia','beca'))
        ) as free_members,
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

    const tz = req.gym.timezone || 'America/Guayaquil';
    const kpis = await db.query(`
      SELECT 
        COUNT(*) as total_ingresos,
        COUNT(DISTINCT user_id) as usuarios_unicos,
        COUNT(DISTINCT membership_id) as membresias_validas,
        COALESCE(
          (SELECT EXTRACT(HOUR FROM check_in_time AT TIME ZONE '${tz}')::text || ':00'
           FROM attendance 
           WHERE gym_id = $1 ${dateCondition}
           GROUP BY EXTRACT(HOUR FROM check_in_time AT TIME ZONE '${tz}')
           ORDER BY COUNT(*) DESC LIMIT 1),
          '--:--'
        ) as hora_pico
      FROM attendance
      WHERE gym_id = $1 ${dateCondition}
    `, params);

    const byDay = await db.query(`
      SELECT DATE(check_in_time AT TIME ZONE '${tz}') as date, COUNT(*) as count
      FROM attendance WHERE gym_id = $1 ${dateCondition}
      GROUP BY DATE(check_in_time AT TIME ZONE '${tz}') ORDER BY date ASC
    `, params);

    const heatmap = await db.query(`
      SELECT EXTRACT(DOW FROM check_in_time AT TIME ZONE '${tz}')::int as day_of_week,
             EXTRACT(HOUR FROM check_in_time AT TIME ZONE '${tz}')::int as hour,
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

// GET /api/admin/memberships — solo la membresía más reciente de cada cliente
const getMemberships = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const { filter = 'all' } = req.query;
    let condition = '';
    if (filter === 'active') condition = "AND m.status='active' AND m.end_date>=CURRENT_DATE";
    else if (filter === 'expired') condition = "AND (m.status='expired' OR (m.status='active' AND m.end_date<CURRENT_DATE))";
    else if (filter === 'expiring') condition = "AND m.status='active' AND m.end_date >= CURRENT_DATE AND m.end_date <= CURRENT_DATE + 5";
    else if (filter === 'cancelled') condition = "AND m.status='cancelled'";

    const result = await db.query(`
      SELECT DISTINCT ON (m.user_id)
             m.id, m.start_date, m.end_date, m.status, m.created_at,
             mt.name as type_name,
             u.id as user_id, u.name as client_name, u.cedula as client_cedula,
             p.method as payment_method,
             p.registered_by,
             (p.registered_by IS NOT NULL) as by_staff
      FROM memberships m
      JOIN membership_types mt ON mt.id = m.membership_type_id
      JOIN users u ON u.id = m.user_id
      LEFT JOIN LATERAL (
        SELECT p2.method, p2.registered_by
        FROM payments p2
        WHERE p2.membership_id = m.id AND p2.status = 'pagado'
        ORDER BY p2.created_at DESC LIMIT 1
      ) p ON TRUE
      WHERE m.gym_id = $1 ${condition}
      AND m.user_id NOT IN (
        SELECT user_id FROM user_gym_roles WHERE gym_id = $1 AND role IN ('admin','instructor','recepcionista') AND is_active = TRUE
      )
      ORDER BY m.user_id, m.created_at DESC
    `, [gymId]);

    // Ordenar por fecha de vencimiento (más próximas primero)
    const sorted = result.rows.sort((a, b) => new Date(a.end_date) - new Date(b.end_date));

    res.json(sorted);
  } catch (err) {
    console.error('Error getMemberships admin:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/admin/memberships/:membershipId/cancel — anular membresía
const cancelMembership = async (req, res) => {
  try {
    const { membershipId } = req.params;
    const { reason } = req.body;
    const gymId = req.gym.id;

    // Traer la membresía y su pago asociado
    const memResult = await db.query(`
      SELECT m.id, m.user_id, m.status,
             p.id as payment_id, p.method, p.status as payment_status,
             p.payphone_transaction_id, p.created_at as payment_date
      FROM memberships m
      LEFT JOIN payments p ON p.membership_id = m.id AND p.status = 'pagado'
      WHERE m.id = $1 AND m.gym_id = $2
    `, [membershipId, gymId]);

    if (!memResult.rows.length) return res.status(404).json({ error: 'Membresía no encontrada' });
    const mem = memResult.rows[0];

    if (mem.status === 'cancelled') {
      return res.status(400).json({ error: 'Esta membresía ya está anulada' });
    }

    let refundInfo = null;

    // Si fue pagada con PayPhone, intentar el reverso
    if (mem.method === 'payphone' && mem.payphone_transaction_id) {
      const gymCfg = await db.query(
        'SELECT payphone_token FROM gyms WHERE id = $1',
        [gymId]
      );
      const token = decrypt(gymCfg.rows[0]?.payphone_token);

      if (!token) {
        return res.status(400).json({ error: 'No hay credenciales de PayPhone configuradas' });
      }

      try {
        const axios = require('axios');
        const reverseRes = await axios.post(
          'https://pay.payphonetodoesposible.com/api/Reverse',
          { id: parseInt(mem.payphone_transaction_id) },
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );
        refundInfo = { success: true, data: reverseRes.data };
      } catch (payErr) {
        console.error('Error reverso PayPhone:', JSON.stringify(payErr.response?.data || payErr.message));
        const msg = payErr.response?.data?.message || payErr.response?.data?.errors?.[0]?.message || 'No se pudo reversar el pago en PayPhone';
        return res.status(400).json({ 
          error: `${msg}. Los reversos solo se permiten el mismo día hasta las 20:00. Si ya pasó el plazo, gestiona el reembolso manualmente desde PayPhone Business.` 
        });
      }
    }

    // Anular la membresía
    await db.query(
      "UPDATE memberships SET status = 'cancelled', auto_renew = FALSE WHERE id = $1",
      [membershipId]
    );

    // Anular el pago asociado
    if (mem.payment_id) {
      await db.query(
        "UPDATE payments SET status = 'anulado' WHERE id = $1",
        [mem.payment_id]
      );
    }

    res.json({ 
      message: 'Membresía anulada exitosamente', 
      refunded: !!refundInfo,
      refundInfo 
    });
  } catch (err) {
    console.error('Error cancelMembership:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/admin/users/:userId/memberships-history — historial completo de membresías de un cliente
const getUserMembershipsHistory = async (req, res) => {
  try {
    const { userId } = req.params;
    const gymId = req.gym.id;

    const result = await db.query(`
      SELECT m.id, m.start_date, m.end_date, m.status, m.created_at,
             mt.name as type_name, mt.price,
             p.method as payment_method, p.amount, p.registered_by,
             (p.registered_by IS NOT NULL) as by_staff,
             reg.name as registered_by_name
      FROM memberships m
      JOIN membership_types mt ON mt.id = m.membership_type_id
      LEFT JOIN LATERAL (
        SELECT p2.method, p2.amount, p2.registered_by
        FROM payments p2
        WHERE p2.membership_id = m.id
        ORDER BY p2.created_at DESC LIMIT 1
      ) p ON TRUE
      LEFT JOIN users reg ON reg.id = p.registered_by
      WHERE m.user_id = $1 AND m.gym_id = $2
      ORDER BY m.created_at DESC
    `, [userId, gymId]);

    res.json(result.rows);
  } catch (err) {
    console.error('Error getUserMembershipsHistory:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/admin/attendance/classes?date= — clases de una fecha con inscritos
const getAttendanceClasses = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'Fecha requerida' });

    const classes = await db.query(`
      SELECT ci.id, ci.class_date, ci.start_time, ci.end_time, ci.status,
             s.name as session_name,
             i.name as instructor_name,
             COUNT(b.id) FILTER (WHERE b.status != 'cancelled') as enrolled,
             COUNT(b.id) FILTER (WHERE b.status = 'attended') as attended_count
      FROM class_instances ci
      JOIN sessions s ON s.id = ci.session_id
      LEFT JOIN instructors i ON i.id = ci.instructor_id
      LEFT JOIN bookings b ON b.class_instance_id = ci.id
      WHERE ci.gym_id = $1 AND ci.class_date = $2
      GROUP BY ci.id, s.name, i.name
      ORDER BY ci.start_time ASC
    `, [gymId, date]);

    res.json(classes.rows);
  } catch (err) {
    console.error('Error getAttendanceClasses:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/admin/attendance/classes/:classInstanceId/students — alumnos de una clase
const getAttendanceStudents = async (req, res) => {
  try {
    const { classInstanceId } = req.params;
    const gymId = req.gym.id;

    const cls = await db.query('SELECT id FROM class_instances WHERE id=$1 AND gym_id=$2', [classInstanceId, gymId]);
    if (!cls.rows.length) return res.status(404).json({ error: 'Clase no encontrada' });

    const students = await db.query(`
      SELECT b.id as booking_id, b.status,
             u.id as user_id, u.name, u.cedula
      FROM bookings b
      JOIN users u ON u.id = b.user_id
      WHERE b.class_instance_id = $1 AND b.status != 'cancelled'
      ORDER BY u.name ASC
    `, [classInstanceId]);

    res.json(students.rows);
  } catch (err) {
    console.error('Error getAttendanceStudents:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/admin/attendance/bookings/:bookingId — corregir asistencia (sin límite de tiempo)
const correctAttendance = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { attended } = req.body;
    const gymId = req.gym.id;

    const newStatus = attended ? 'attended' : 'no_show';
    const result = await db.query(
      "UPDATE bookings SET status=$1 WHERE id=$2 AND gym_id=$3 RETURNING id, status",
      [newStatus, bookingId, gymId]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Reserva no encontrada' });

    res.json({ message: 'Asistencia corregida', booking: result.rows[0] });
  } catch (err) {
    console.error('Error correctAttendance:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/admin/classes/:classInstanceId/cancel — cancelar una clase puntual
const cancelClass = async (req, res) => {
  try {
    const { classInstanceId } = req.params;
    const gymId = req.gym.id;

    // Verificar que la clase existe
    const cls = await db.query(
      'SELECT id, class_date, start_time, session_id FROM class_instances WHERE id=$1 AND gym_id=$2',
      [classInstanceId, gymId]
    );
    if (!cls.rows.length) return res.status(404).json({ error: 'Clase no encontrada' });

    // Traer inscritos para notificar
    const enrolled = await db.query(
      "SELECT user_id FROM bookings WHERE class_instance_id=$1 AND status='confirmed'",
      [classInstanceId]
    );

    // Marcar la clase como cancelada
    await db.query(
      "UPDATE class_instances SET status='cancelled' WHERE id=$1",
      [classInstanceId]
    );

    // Cancelar las reservas confirmadas
    await db.query(
      "UPDATE bookings SET status='cancelled' WHERE class_instance_id=$1 AND status='confirmed'",
      [classInstanceId]
    );

    // Notificar a cada inscrito
    const c = cls.rows[0];
    const fecha = new Date(c.class_date).toLocaleDateString('es-EC');
    for (const row of enrolled.rows) {
      await db.query(`
        INSERT INTO notifications (user_id, gym_id, title, message, type)
        VALUES ($1, $2, 'Clase cancelada', $3, 'class')
      `, [row.user_id, gymId, `Tu clase del ${fecha} a las ${c.start_time?.slice(0,5)} fue cancelada. Tu reserva ha sido liberada.`]);
    }

    res.json({ message: 'Clase cancelada', notified: enrolled.rows.length });
  } catch (err) {
    console.error('Error cancelClass:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/admin/classes/cancel-day — cancelar todas las clases de un día
const cancelDay = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: 'Fecha requerida' });

    // Traer todas las clases del día
    const classes = await db.query(
      "SELECT id, start_time FROM class_instances WHERE gym_id=$1 AND class_date=$2 AND status != 'cancelled'",
      [gymId, date]
    );

    let totalNotified = 0;
    for (const cls of classes.rows) {
      const enrolled = await db.query(
        "SELECT user_id FROM bookings WHERE class_instance_id=$1 AND status='confirmed'",
        [cls.id]
      );
      await db.query("UPDATE class_instances SET status='cancelled' WHERE id=$1", [cls.id]);
      await db.query("UPDATE bookings SET status='cancelled' WHERE class_instance_id=$1 AND status='confirmed'", [cls.id]);

      const fecha = new Date(date).toLocaleDateString('es-EC');
      for (const row of enrolled.rows) {
        await db.query(`
          INSERT INTO notifications (user_id, gym_id, title, message, type)
          VALUES ($1, $2, 'Clase cancelada', $3, 'class')
        `, [row.user_id, gymId, `Las clases del ${fecha} fueron canceladas. Tu reserva ha sido liberada.`]);
        totalNotified++;
      }
    }

    res.json({ message: 'Día cancelado', classesCancelled: classes.rows.length, notified: totalNotified });
  } catch (err) {
    console.error('Error cancelDay:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/admin/schedules/:classInstanceId/book — inscribir alumno a una clase
const bookStudent = async (req, res) => {
  try {
    const { classInstanceId } = req.params;
    const gymId = req.gym.id;
    const { userId } = req.body;

    if (!userId) return res.status(400).json({ error: 'Selecciona un alumno' });

    // Verificar capacidad
    const classResult = await db.query(`
      SELECT ci.max_capacity, COUNT(b.id) FILTER (WHERE b.status='confirmed') as booked
      FROM class_instances ci
      LEFT JOIN bookings b ON b.class_instance_id = ci.id
      WHERE ci.id = $1 AND ci.gym_id = $2
      GROUP BY ci.id
    `, [classInstanceId, gymId]);

    if (!classResult.rows.length) return res.status(404).json({ error: 'Clase no encontrada' });
    const cls = classResult.rows[0];

    if (parseInt(cls.booked) >= cls.max_capacity) {
      return res.status(400).json({ error: 'La clase está llena' });
    }

    // Verificar membresía activa
    const memResult = await db.query(`
      SELECT id FROM memberships
      WHERE user_id=$1 AND gym_id=$2 AND status='active' AND end_date>=CURRENT_DATE
      LIMIT 1
    `, [userId, gymId]);

    if (!memResult.rows.length) {
      return res.status(400).json({ error: 'El alumno no tiene membresía activa' });
    }

    // Crear/reactivar reserva
    await db.query(`
      INSERT INTO bookings (gym_id, user_id, class_instance_id, status, booked_by, booked_by_role)
      VALUES ($1,$2,$3,'confirmed',$4,'admin')
      ON CONFLICT (user_id, class_instance_id) DO UPDATE SET status='confirmed'
    `, [gymId, userId, classInstanceId, req.user.id]);

    res.status(201).json({ message: 'Alumno inscrito exitosamente' });
  } catch (err) {
    console.error('Error bookStudent:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/admin/birthdays?filter=today|week|month
const getBirthdays = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const { filter = 'today' } = req.query;
    const tz = req.gym.timezone || 'America/Guayaquil';

    let condition = '';
    if (filter === 'today') {
      condition = `EXTRACT(MONTH FROM u.birth_date) = EXTRACT(MONTH FROM (NOW() AT TIME ZONE '${tz}'))
                   AND EXTRACT(DAY FROM u.birth_date) = EXTRACT(DAY FROM (NOW() AT TIME ZONE '${tz}'))`;
    } else if (filter === 'week') {
      // Cumpleaños de este año dentro de la semana actual (lunes a domingo)
      condition = `MAKE_DATE(
                     EXTRACT(YEAR FROM (NOW() AT TIME ZONE '${tz}'))::int,
                     EXTRACT(MONTH FROM u.birth_date)::int,
                     EXTRACT(DAY FROM u.birth_date)::int
                   ) BETWEEN
                     DATE_TRUNC('week', (NOW() AT TIME ZONE '${tz}'))::date
                     AND (DATE_TRUNC('week', (NOW() AT TIME ZONE '${tz}'))::date + 6)`;
    } else if (filter === 'month') {
      condition = `EXTRACT(MONTH FROM u.birth_date) = EXTRACT(MONTH FROM (NOW() AT TIME ZONE '${tz}'))`;
    }

    const result = await db.query(`
      SELECT u.id, u.name, u.cedula, u.phone, u.birth_date,
             EXTRACT(DAY FROM u.birth_date)::int as day,
             EXTRACT(MONTH FROM u.birth_date)::int as month
      FROM users u
      JOIN user_gym_roles ugr ON ugr.user_id = u.id
      WHERE ugr.gym_id = $1 AND ugr.role = 'user' AND ugr.is_active = TRUE
        AND u.birth_date IS NOT NULL
        AND ${condition}
        AND u.id NOT IN (
          SELECT user_id FROM user_gym_roles WHERE gym_id = $1 AND role IN ('admin','instructor','recepcionista') AND is_active = TRUE
        )
      ORDER BY EXTRACT(MONTH FROM u.birth_date), EXTRACT(DAY FROM u.birth_date)
    `, [gymId]);

    res.json(result.rows);
  } catch (err) {
    console.error('Error getBirthdays:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/admin/plan-usage — estado del límite del plan
const getPlanUsage = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const gym = await db.query('SELECT saas_max_users FROM gyms WHERE id=$1', [gymId]);
    const maxUsers = gym.rows[0]?.saas_max_users;

    const count = await db.query(`
      SELECT COUNT(*) as total FROM user_gym_roles ugr
      JOIN users u ON u.id = ugr.user_id
      WHERE ugr.gym_id = $1 AND ugr.role = 'user' AND ugr.is_active = TRUE AND u.is_active = TRUE
        AND ugr.user_id NOT IN (
          SELECT user_id FROM user_gym_roles WHERE gym_id = $1 AND role IN ('admin','instructor','recepcionista') AND is_active = TRUE
        )
    `, [gymId]);

    const current = parseInt(count.rows[0].total);

    if (!maxUsers) {
      return res.json({ unlimited: true, current });
    }

    const hardLimit = Math.floor(maxUsers * 1.10);
    const graceLeft = Math.max(0, hardLimit - current);
    const pct = (current / maxUsers) * 100;

    res.json({
      unlimited: false,
      current,
      maxUsers,
      hardLimit,
      graceLeft,
      pct: Math.round(pct),
      status: current >= hardLimit ? 'blocked' : pct >= 100 ? 'over' : pct >= 80 ? 'warning' : 'ok'
    });
  } catch (err) {
    console.error('Error getPlanUsage:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};
module.exports = {
  getDashboard, getUsers, getUserDetail, createUser, updateUser, resetUserPassword,
  getMembershipTypes, getMemberships, cancelMembership, createMembershipType, updateMembershipType, deleteMembershipType,
  activateMembership, getSessions, createSession, updateSession, deleteSession,
  getSchedules, createSchedule, deleteSchedule,
  getInstructors, createInstructor, updateInstructor, deleteInstructor,
  getReceptionists, createReceptionist,
  getPayments, getReports, getReceptionAudit, getAttendanceHistory, validateEntry,getUserMembershipsHistory, getAttendanceClasses,
   getAttendanceStudents, correctAttendance, cancelClass, cancelDay, bookStudent, getBirthdays, getPlanUsage
};
