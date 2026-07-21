const bcrypt = require('bcryptjs');
const db = require('../config/database');
const { canAddUser } = require('../utils/planLimits');

// GET /api/recepcion/dashboard
const getDashboard = async (req, res) => {
  try {
    const gymId = req.gym.id;

    const kpis = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM user_gym_roles ugr WHERE ugr.gym_id=$1 AND ugr.role='user' AND ugr.is_active=TRUE
          AND ugr.user_id NOT IN (
            SELECT user_id FROM user_gym_roles WHERE gym_id=$1 AND role IN ('admin','instructor','recepcionista') AND is_active=TRUE
          )) as total_clients,
        (SELECT COUNT(*) FROM attendance WHERE gym_id=$1 AND DATE(check_in_time)=CURRENT_DATE) as asistencias_hoy,
        (SELECT COUNT(DISTINCT ci.id) FROM class_instances ci WHERE ci.gym_id=$1 AND ci.class_date=CURRENT_DATE AND ci.status='scheduled') as clases_hoy,
        (SELECT COALESCE(SUM(amount),0) FROM payments WHERE gym_id=$1 AND status='pagado' AND DATE(created_at)=CURRENT_DATE) as pagos_dia
    `, [gymId]);

    // Clases de hoy
    const todayClasses = await db.query(`
      SELECT ci.id, ci.class_date, ci.start_time, ci.end_time, ci.max_capacity,
             s.name as session_name, i.name as instructor_name,
             COUNT(b.id) FILTER (WHERE b.status='confirmed') as booked_count
      FROM class_instances ci
      JOIN sessions s ON s.id = ci.session_id
      LEFT JOIN instructors i ON i.id = ci.instructor_id
      LEFT JOIN bookings b ON b.class_instance_id = ci.id
      WHERE ci.gym_id = $1 AND ci.class_date = CURRENT_DATE AND ci.status = 'scheduled'
      GROUP BY ci.id, s.name, i.name
      ORDER BY ci.start_time ASC
    `, [gymId]);

    // Últimos ingresos hoy
    const recentAttendance = await db.query(`
      SELECT u.name, u.cedula, a.check_in_time, a.method
      FROM attendance a JOIN users u ON u.id = a.user_id
      WHERE a.gym_id = $1 AND DATE(a.check_in_time) = CURRENT_DATE
      ORDER BY a.check_in_time DESC LIMIT 10
    `, [gymId]);

    res.json({
      kpis: kpis.rows[0],
      todayClasses: todayClasses.rows,
      recentAttendance: recentAttendance.rows
    });
  } catch (err) {
    console.error('Error recepcion getDashboard:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/recepcion/clients
const getClients = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const { search } = req.query;
    const params = [gymId];
    let searchCondition = '';

    if (search) {
      params.push(`%${search}%`);
      searchCondition = `AND (u.name ILIKE $${params.length} OR u.cedula ILIKE $${params.length})`;
    }

    const result = await db.query(`
      SELECT u.id, u.name, u.cedula, u.phone,
        CASE 
          WHEN m.id IS NOT NULL THEN mt.name
          ELSE NULL
        END as membership_name,
        CASE 
          WHEN m.id IS NOT NULL AND m.end_date >= CURRENT_DATE THEN 'active'
          ELSE 'inactive'
        END as membership_status,
        m.end_date
      FROM user_gym_roles ugr
      JOIN users u ON u.id = ugr.user_id
      LEFT JOIN LATERAL (
        SELECT m2.id, m2.end_date, m2.membership_type_id
        FROM memberships m2
        WHERE m2.user_id = u.id AND m2.gym_id = $1
          AND m2.status = 'active' AND m2.end_date >= CURRENT_DATE
        ORDER BY m2.end_date DESC LIMIT 1
      ) m ON TRUE
      LEFT JOIN membership_types mt ON mt.id = m.membership_type_id
      WHERE ugr.gym_id = $1 AND ugr.role = 'user' AND ugr.is_active = TRUE
      AND ugr.user_id NOT IN (
        SELECT user_id FROM user_gym_roles WHERE gym_id = $1 AND role IN ('admin','instructor','recepcionista') AND is_active = TRUE
      )
      ${searchCondition}
      ORDER BY u.name ASC
    `, params);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/recepcion/clients/:userId
const getClientDetail = async (req, res) => {
  try {
    const { userId } = req.params;
    const gymId = req.gym.id;

    const userResult = await db.query(`
      SELECT u.id, u.cedula, u.name, u.email, u.phone, u.qr_code,
             u.birth_date, u.emergency_contact_name, u.emergency_contact_phone
      FROM users u
      JOIN user_gym_roles ugr ON ugr.user_id = u.id AND ugr.gym_id = $2 AND ugr.role = 'user'
      WHERE u.id = $1
    `, [userId, gymId]);

    if (!userResult.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });

    // Membresía activa
    const membership = await db.query(`
      SELECT m.id, m.start_date, m.end_date, m.status, mt.name as type_name,
             (m.end_date - CURRENT_DATE) as days_remaining
      FROM memberships m JOIN membership_types mt ON mt.id = m.membership_type_id
      WHERE m.user_id = $1 AND m.gym_id = $2
        AND m.status = 'active' AND m.end_date >= CURRENT_DATE
      ORDER BY m.end_date DESC LIMIT 1
    `, [userId, gymId]);

    // Pagos recientes
    const payments = await db.query(`
      SELECT p.id, p.amount, p.method, p.status, p.created_at, mt.name as membership_name
      FROM payments p LEFT JOIN membership_types mt ON mt.id = p.membership_type_id
      WHERE p.user_id = $1 AND p.gym_id = $2
      ORDER BY p.created_at DESC LIMIT 10
    `, [userId, gymId]);

    res.json({
      client: userResult.rows[0],
      membership: membership.rows[0] || null,
      payments: payments.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/recepcion/clients — crear nuevo cliente
const createClient = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const { cedula, name, email, phone, password, birthDate, emergencyContactName, emergencyContactPhone } = req.body;

    if (!cedula || !name || !password) {
      return res.status(400).json({ error: 'Cédula, nombre y contraseña son requeridos' });
    }
    // Verificar límite del plan
    const limitCheck = await canAddUser(gymId);
    if (!limitCheck.allowed) {
      return res.status(403).json({ error: limitCheck.reason });
    }

    // Verificar si ya existe en este gym
    const existsInGym = await db.query(`
      SELECT u.id FROM users u
      JOIN user_gym_roles ugr ON ugr.user_id = u.id
      WHERE u.cedula = $1 AND ugr.gym_id = $2 AND ugr.is_active = TRUE
    `, [cedula, gymId]);

    if (existsInGym.rows.length) {
      return res.status(400).json({ error: 'Ya existe un cliente con esa cédula en este gimnasio' });
    }

    const hash = await bcrypt.hash(password, 10);
    const newUser = await db.query(
      `INSERT INTO users (cedula, name, email, phone, password_hash, birth_date, emergency_contact_name, emergency_contact_phone) 
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [cedula, name, email, phone, hash, birthDate || null, emergencyContactName || null, emergencyContactPhone || null]
    );
    const userId = newUser.rows[0].id;

    await db.query(
      "INSERT INTO user_gym_roles (user_id, gym_id, role) VALUES ($1,$2,'user')",
      [userId, gymId]
    );

    // Auditoría
    await db.query(
      "INSERT INTO receptionists_audit (gym_id, receptionist_id, action, target_user_id) VALUES ($1,$2,'Cliente creado',$3)",
      [gymId, req.user.id, userId]
    );

    res.status(201).json({ message: 'Cliente creado exitosamente', userId });
  } catch (err) {
    console.error('Error createClient:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/recepcion/clients/:userId/membership — nueva membresía
const createMembership = async (req, res) => {
  try {
    const { userId } = req.params;
    const gymId = req.gym.id;
    const { membershipTypeId, method, startDate: customStartDate } = req.body;

    const typeResult = await db.query(
      'SELECT * FROM membership_types WHERE id = $1 AND gym_id = $2 AND is_active = TRUE',
      [membershipTypeId, gymId]
    );
    if (!typeResult.rows.length) return res.status(404).json({ error: 'Plan no encontrado' });
    const mType = typeResult.rows[0];

    // Usar fecha personalizada si viene, o hoy por defecto (sin conversión de zona horaria)
    let startStr;
    if (customStartDate) {
      startStr = customStartDate; // ya viene como YYYY-MM-DD
    } else {
      const now = new Date();
      startStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }
    // Calcular fecha fin a partir de la fecha inicio (en UTC puro para evitar desfases)
    const [sy, sm, sd] = startStr.split('-').map(Number);
    const endDate = new Date(Date.UTC(sy, sm - 1, sd));
    if (mType.duration_unit === 'days') endDate.setUTCDate(endDate.getUTCDate() + mType.duration_value);
    else if (mType.duration_unit === 'weeks') endDate.setUTCDate(endDate.getUTCDate() + mType.duration_value * 7);
    else if (mType.duration_unit === 'months') endDate.setUTCMonth(endDate.getUTCMonth() + mType.duration_value);
    else if (mType.duration_unit === 'years') endDate.setUTCFullYear(endDate.getUTCFullYear() + mType.duration_value);

// Expirar membresías activas anteriores del usuario
    await db.query(`
      UPDATE memberships SET status = 'expired'
      WHERE user_id = $1 AND gym_id = $2 AND status = 'active'
    `, [userId, gymId]);

    const memResult = await db.query(`
      INSERT INTO memberships (user_id, gym_id, membership_type_id, start_date, end_date, status)
      VALUES ($1,$2,$3,$4,$5,'active') RETURNING id
    `, [userId, gymId, membershipTypeId,
        startStr,
        endDate.toISOString().split('T')[0]]);

    await db.query(`
      INSERT INTO payments (gym_id, user_id, membership_id, membership_type_id, amount, method, status, registered_by)
      VALUES ($1,$2,$3,$4,$5,$6,'pagado',$7)
    `, [gymId, userId, memResult.rows[0].id, membershipTypeId, mType.price, method || 'efectivo', req.user.id]);

    // Auditoría
    await db.query(
      "INSERT INTO receptionists_audit (gym_id, receptionist_id, action, target_user_id) VALUES ($1,$2,'Membresía creada',$3)",
      [gymId, req.user.id, userId]
    );

    res.status(201).json({ message: 'Membresía creada exitosamente' });
  } catch (err) {
    console.error('Error createMembership recepcion:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/recepcion/clients/:userId/payment — registrar pago manual
const registerPayment = async (req, res) => {
  try {
    const { userId } = req.params;
    const gymId = req.gym.id;
    const { membershipTypeId, amount, method, notes } = req.body;

    await db.query(`
      INSERT INTO payments (gym_id, user_id, membership_type_id, amount, method, status, registered_by, notes)
      VALUES ($1,$2,$3,$4,$5,'pagado',$6,$7)
    `, [gymId, userId, membershipTypeId, amount, method || 'efectivo', req.user.id, notes]);

    await db.query(
      "INSERT INTO receptionists_audit (gym_id, receptionist_id, action, target_user_id) VALUES ($1,$2,'Pago registrado',$3)",
      [gymId, req.user.id, userId]
    );

    res.status(201).json({ message: 'Pago registrado exitosamente' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/recepcion/memberships
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
             m.id, m.start_date, m.end_date, m.status, mt.name as type_name,
             u.id as user_id, u.name as client_name, u.cedula as client_cedula,
             p.method as payment_method,
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

    const sorted = result.rows.sort((a, b) => new Date(a.end_date) - new Date(b.end_date));
    res.json(sorted);
  } catch (err) {
    console.error('Error getMemberships recepcion:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/recepcion/payments
const getPayments = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const { date, method, status, period = 'day' } = req.query;
    const params = [gymId];
    let dateCondition = '';

    if (period === 'day' && date) {
      params.push(date);
      dateCondition = `AND DATE(p.created_at) = $${params.length}`;
    } else if (period === 'month') {
      dateCondition = "AND DATE_TRUNC('month', p.created_at) = DATE_TRUNC('month', CURRENT_DATE)";
    } else if (period === 'year') {
      dateCondition = "AND DATE_TRUNC('year', p.created_at) = DATE_TRUNC('year', CURRENT_DATE)";
    }

    let methodCondition = '';
    if (method && method !== 'todos') {
      params.push(method);
      methodCondition = `AND p.method = $${params.length}`;
    }

    let statusCondition = '';
    if (status && status !== 'todos') {
      params.push(status);
      statusCondition = `AND p.status = $${params.length}`;
    }

    const result = await db.query(`
      SELECT p.id, p.amount, p.method, p.status, p.created_at, p.notes,
             u.name as client_name, u.cedula as client_cedula,
             mt.name as membership_name
      FROM payments p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN membership_types mt ON mt.id = p.membership_type_id
      WHERE p.gym_id = $1 ${dateCondition} ${methodCondition} ${statusCondition}
      ORDER BY p.created_at DESC
    `, params);

    const totals = await db.query(`
      SELECT COALESCE(SUM(amount) FILTER (WHERE status='pagado'),0) as total_dia,
             COALESCE(AVG(amount) FILTER (WHERE status='pagado'),0) as promedio
      FROM payments WHERE gym_id=$1 AND DATE(created_at) = CURRENT_DATE
    `, [gymId]);

    res.json({ payments: result.rows, totals: totals.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/recepcion/schedules?date=
const getSchedules = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const { date = new Date().toISOString().split('T')[0] } = req.query;

    // Generar instancias si no existen
    await db.query('SELECT generate_class_instances_for_date($1, $2)', [gymId, date]);

    const result = await db.query(`
      SELECT ci.id, ci.class_date, ci.start_time, ci.end_time, ci.max_capacity, ci.status,
             s.name as session_name, s.duration_minutes,
             i.name as instructor_name,
             COUNT(b.id) FILTER (WHERE b.status='confirmed') as booked_count
      FROM class_instances ci
      JOIN sessions s ON s.id = ci.session_id
      LEFT JOIN instructors i ON i.id = ci.instructor_id
      LEFT JOIN bookings b ON b.class_instance_id = ci.id
      WHERE ci.gym_id = $1 AND ci.class_date = $2
      GROUP BY ci.id, s.name, s.duration_minutes, i.name
      ORDER BY ci.start_time ASC
    `, [gymId, date]);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/recepcion/schedules/:classInstanceId/book — inscribir cliente
const bookClient = async (req, res) => {
  try {
    const { classInstanceId } = req.params;
    const gymId = req.gym.id;
    const { userId } = req.body;

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
      return res.status(400).json({ error: 'El cliente no tiene membresía activa' });
    }

    // Crear reserva
    await db.query(`
      INSERT INTO bookings (gym_id, user_id, class_instance_id, status, booked_by, booked_by_role)
      VALUES ($1,$2,$3,'confirmed',$4,'recepcionista')
      ON CONFLICT (user_id, class_instance_id) DO UPDATE SET status='confirmed'
    `, [gymId, userId, classInstanceId, req.user.id]);

    // Auditoría
    await db.query(`
      INSERT INTO receptionists_audit (gym_id, receptionist_id, action, target_user_id, class_instance_id)
      VALUES ($1,$2,'Reserva creada',$3,$4)
    `, [gymId, req.user.id, userId, classInstanceId]);

    res.status(201).json({ message: 'Cliente inscrito exitosamente' });
  } catch (err) {
    console.error('Error bookClient:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/recepcion/schedules/:classInstanceId/enrolled
const getEnrolled = async (req, res) => {
  try {
    const { classInstanceId } = req.params;
    const result = await db.query(`
      SELECT u.id, u.name, u.cedula, b.status, b.created_at
      FROM bookings b JOIN users u ON u.id = b.user_id
      WHERE b.class_instance_id = $1 AND b.gym_id = $2
      ORDER BY u.name
    `, [classInstanceId, req.gym.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/recepcion/scanner/validate
const validateEntry = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const { code } = req.body;

    const userResult = await db.query(`
      SELECT u.id, u.name, u.cedula
      FROM users u
      JOIN user_gym_roles ugr ON ugr.user_id = u.id AND ugr.gym_id = $1 AND ugr.is_active = TRUE
      WHERE (u.qr_code = $2 OR u.cedula = $2)
    `, [gymId, code]);

    if (!userResult.rows.length) {
      return res.json({ valid: false, error: 'Usuario no encontrado en este gimnasio' });
    }

    const user = userResult.rows[0];

    const memResult = await db.query(`
      SELECT m.id, mt.name as type_name, m.end_date
      FROM memberships m JOIN membership_types mt ON mt.id = m.membership_type_id
      WHERE m.user_id=$1 AND m.gym_id=$2 AND m.status='active' AND m.end_date>=CURRENT_DATE
      ORDER BY m.end_date DESC LIMIT 1
    `, [user.id, gymId]);

    if (!memResult.rows.length) {
      return res.json({
        valid: false,
        user: { name: user.name, cedula: user.cedula },
        error: 'Sin membresía activa'
      });
    }

    const membership = memResult.rows[0];

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
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/recepcion/attendance
const getAttendance = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const tz = req.gym.timezone || 'America/Guayaquil';
    const { dateFrom, dateTo } = req.query;
    const params = [gymId];
    let dateCondition = '';

    if (dateFrom) { params.push(dateFrom); dateCondition += ` AND DATE(a.check_in_time) >= $${params.length}`; }
    if (dateTo) { params.push(dateTo); dateCondition += ` AND DATE(a.check_in_time) <= $${params.length}`; }

    const kpis = await db.query(`
      SELECT COUNT(*) as total, COUNT(DISTINCT a.user_id) as unique_users,
             COUNT(DISTINCT a.membership_id) as with_membership
      FROM attendance a WHERE a.gym_id=$1 ${dateCondition}
    `, params);

    const horaPico = await db.query(`
      SELECT EXTRACT(HOUR FROM a.check_in_time AT TIME ZONE '${tz}')::text || ':00' as hora
      FROM attendance a WHERE a.gym_id=$1 ${dateCondition}
      GROUP BY EXTRACT(HOUR FROM a.check_in_time AT TIME ZONE '${tz}')
      ORDER BY COUNT(*) DESC LIMIT 1
    `, params);

    const byDay = await db.query(`
      SELECT DATE(a.check_in_time AT TIME ZONE '${tz}') as date, COUNT(*) as count
      FROM attendance a WHERE a.gym_id=$1 ${dateCondition}
      GROUP BY DATE(a.check_in_time AT TIME ZONE '${tz}') ORDER BY date
    `, params);

    const heatmap = await db.query(`
      SELECT EXTRACT(DOW FROM a.check_in_time AT TIME ZONE '${tz}')::int as dow,
             EXTRACT(HOUR FROM a.check_in_time AT TIME ZONE '${tz}')::int as hour, COUNT(*) as count
      FROM attendance a WHERE a.gym_id=$1 ${dateCondition}
      GROUP BY dow, hour
    `, params);

    res.json({ 
      kpis: { ...kpis.rows[0], hora_pico: horaPico.rows[0]?.hora || '--:--' }, 
      byDay: byDay.rows, 
      heatmap: heatmap.rows 
    });
  } catch (err) {
    console.error('Error getAttendance recepcion:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/recepcion/membership-types
const getMembershipTypes = async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM membership_types WHERE gym_id = $1 AND is_active = TRUE ORDER BY price ASC',
      [req.gym.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error getMembershipTypes recepcion:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/recepcion/memberships/:membershipId/cancel — anular membresía (solo las que ella creó hoy, sin PayPhone)
const cancelMembership = async (req, res) => {
  try {
    const { membershipId } = req.params;
    const gymId = req.gym.id;
    const receptionistId = req.user.id;

    const memResult = await db.query(`
      SELECT m.id, m.user_id, m.status, m.created_at,
             p.id as payment_id, p.method, p.registered_by, p.created_at as payment_date
      FROM memberships m
      LEFT JOIN payments p ON p.membership_id = m.id AND p.status = 'pagado'
      WHERE m.id = $1 AND m.gym_id = $2
    `, [membershipId, gymId]);

    if (!memResult.rows.length) return res.status(404).json({ error: 'Membresía no encontrada' });
    const mem = memResult.rows[0];

    if (mem.status === 'cancelled') {
      return res.status(400).json({ error: 'Esta membresía ya está anulada' });
    }

    // No puede anular pagos de PayPhone
    if (mem.method === 'payphone') {
      return res.status(403).json({ error: 'No puedes anular membresías pagadas con PayPhone. Solicítalo al administrador.' });
    }

    // Solo puede anular las que ella misma registró
    if (mem.registered_by && mem.registered_by !== receptionistId) {
      return res.status(403).json({ error: 'Solo puedes anular membresías que tú registraste. Solicítalo al administrador.' });
    }

    // Solo el mismo día
    const created = new Date(mem.payment_date || mem.created_at);
    const today = new Date();
    const sameDay = created.toDateString() === today.toDateString();
    if (!sameDay) {
      return res.status(403).json({ error: 'Solo puedes anular membresías creadas hoy. Solicítalo al administrador.' });
    }

    await db.query("UPDATE memberships SET status = 'cancelled', auto_renew = FALSE WHERE id = $1", [membershipId]);
    if (mem.payment_id) {
      await db.query("UPDATE payments SET status = 'anulado' WHERE id = $1", [mem.payment_id]);
    }

    await db.query(
      "INSERT INTO receptionists_audit (gym_id, receptionist_id, action, target_user_id) VALUES ($1,$2,'Membresía anulada',$3)",
      [gymId, receptionistId, mem.user_id]
    );

    res.json({ message: 'Membresía anulada exitosamente' });
  } catch (err) {
    console.error('Error cancelMembership recepcion:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/recepcion/users/:userId/memberships-history
const getUserMembershipsHistory = async (req, res) => {
  try {
    const { userId } = req.params;
    const gymId = req.gym.id;

    const result = await db.query(`
      SELECT m.id, m.start_date, m.end_date, m.status, m.created_at,
             mt.name as type_name,
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
    console.error('Error getUserMembershipsHistory recepcion:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/recepcion/birthdays?filter=today|week|month
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
    console.error('Error getBirthdays recepcion:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

module.exports = {
  getDashboard, getClients, getClientDetail, createClient,
  createMembership, registerPayment, getMemberships, getPayments,
  getSchedules, bookClient, getEnrolled, validateEntry, getAttendance,
  getMembershipTypes, cancelMembership, getUserMembershipsHistory, getBirthdays
};
