const db = require('../config/database');

// GET /api/instructor/today-classes
const getTodayClasses = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const userId = req.user.id;

    // Buscar el instructor por user_id
    const instrResult = await db.query(
      'SELECT id FROM instructors WHERE user_id=$1 AND gym_id=$2 AND is_active=TRUE LIMIT 1',
      [userId, gymId]
    );
    if (!instrResult.rows.length) return res.status(404).json({ error: 'Instructor no encontrado' });
    const instructorId = instrResult.rows[0].id;

    const classes = await db.query(`
      SELECT ci.id, ci.class_date, ci.start_time, ci.end_time, ci.max_capacity, ci.status,
             s.name as session_name, s.duration_minutes,
             COUNT(b.id) FILTER (WHERE b.status='confirmed') as booked_count
      FROM class_instances ci
      JOIN sessions s ON s.id = ci.session_id
      LEFT JOIN bookings b ON b.class_instance_id = ci.id
      WHERE ci.gym_id=$1 AND ci.instructor_id=$2 AND ci.class_date=CURRENT_DATE
      GROUP BY ci.id, s.name, s.duration_minutes
      ORDER BY ci.start_time ASC
    `, [gymId, instructorId]);

    const kpis = await db.query(`
      SELECT COUNT(*) as classes_today,
             COALESCE(SUM(cnt.booked),0) as total_capacity
      FROM class_instances ci
      LEFT JOIN (
        SELECT class_instance_id, COUNT(*) as booked FROM bookings WHERE status='confirmed' GROUP BY class_instance_id
      ) cnt ON cnt.class_instance_id = ci.id
      WHERE ci.gym_id=$1 AND ci.instructor_id=$2 AND ci.class_date=CURRENT_DATE
    `, [gymId, instructorId]);

    res.json({
      classes: classes.rows,
      kpis: kpis.rows[0],
      gym: { name: req.gym.name }
    });
  } catch (err) {
    console.error('Error instructor getTodayClasses:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/instructor/attendance?date=
const getAttendanceByDate = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const userId = req.user.id;
    const { date = new Date().toISOString().split('T')[0] } = req.query;

    const instrResult = await db.query(
      'SELECT id FROM instructors WHERE user_id=$1 AND gym_id=$2 AND is_active=TRUE LIMIT 1',
      [userId, gymId]
    );
    if (!instrResult.rows.length) return res.status(404).json({ error: 'Instructor no encontrado' });
    const instructorId = instrResult.rows[0].id;

    const classes = await db.query(`
      SELECT ci.id, ci.start_time, ci.end_time, s.name as session_name,
             COUNT(b.id) FILTER (WHERE b.status IN ('confirmed','attended')) as enrolled
      FROM class_instances ci
      JOIN sessions s ON s.id = ci.session_id
      LEFT JOIN bookings b ON b.class_instance_id = ci.id
      WHERE ci.gym_id=$1 AND ci.instructor_id=$2 AND ci.class_date=$3
      GROUP BY ci.id, s.name
      ORDER BY ci.start_time ASC
    `, [gymId, instructorId, date]);

    // Para cada clase, obtener los alumnos
    const classesWithStudents = await Promise.all(classes.rows.map(async (cls) => {
      const students = await db.query(`
        SELECT u.name, u.cedula, b.status
        FROM bookings b JOIN users u ON u.id = b.user_id
        WHERE b.class_instance_id=$1 AND b.status IN ('confirmed','attended')
        ORDER BY u.name
      `, [cls.id]);
      return { ...cls, students: students.rows };
    }));

    res.json({ date, classes: classesWithStudents });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/instructor/routines
const getRoutines = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const instrResult = await db.query(
      'SELECT id FROM instructors WHERE user_id=$1 AND gym_id=$2 LIMIT 1',
      [req.user.id, gymId]
    );
    if (!instrResult.rows.length) return res.json({ plans: [], assignments: [] });
    const instructorId = instrResult.rows[0].id;

    const plans = await db.query(
      'SELECT * FROM training_plans WHERE instructor_id=$1 AND gym_id=$2 ORDER BY created_at DESC',
      [instructorId, gymId]
    );

    const assignments = await db.query(`
      SELECT tpa.*, tp.name as plan_name, u.name as student_name, u.cedula
      FROM training_plan_assignments tpa
      JOIN training_plans tp ON tp.id = tpa.training_plan_id
      JOIN users u ON u.id = tpa.user_id
      WHERE tp.instructor_id=$1 AND tpa.gym_id=$2
      ORDER BY tpa.assigned_at DESC
    `, [instructorId, gymId]);

    res.json({ plans: plans.rows, assignments: assignments.rows });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/instructor/routines
const createRoutine = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const { name, description, content } = req.body;

    const instrResult = await db.query(
      'SELECT id FROM instructors WHERE user_id=$1 AND gym_id=$2 LIMIT 1',
      [req.user.id, gymId]
    );
    if (!instrResult.rows.length) return res.status(404).json({ error: 'Instructor no encontrado' });

    const result = await db.query(`
      INSERT INTO training_plans (gym_id, instructor_id, name, description, content)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [gymId, instrResult.rows[0].id, name, description, JSON.stringify(content || {})]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/instructor/profile
const getProfile = async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM instructors WHERE user_id=$1 AND gym_id=$2 LIMIT 1',
      [req.user.id, req.gym.id]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// PUT /api/instructor/profile
const updateProfile = async (req, res) => {
  try {
    const { name, phone, specialization, bio } = req.body;
    const result = await db.query(`
      UPDATE instructors SET
        name=COALESCE($1,name), phone=COALESCE($2,phone),
        specialization=COALESCE($3,specialization), bio=COALESCE($4,bio), updated_at=NOW()
      WHERE user_id=$5 AND gym_id=$6 RETURNING *
    `, [name, phone, specialization, bio, req.user.id, req.gym.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

module.exports = { getTodayClasses, getAttendanceByDate, getRoutines, createRoutine, getProfile, updateProfile };
