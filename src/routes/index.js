const express = require('express');
const router = express.Router();
const { authenticate, requireRole, requireSuperAdmin, loadGym, requireAdminOrHeadCoach, requireStaffForWod } = require('../middleware/auth');
const { uploadGymLogo, uploadInstructorPhoto } = require('../config/cloudinary');
const db = require('../config/database');

const authCtrl = require('../controllers/auth.controller');
const superCtrl = require('../controllers/super.controller');
const adminCtrl = require('../controllers/admin.controller');
const receptionCtrl = require('../controllers/reception.controller');
const userCtrl = require('../controllers/user.controller');
const instrCtrl = require('../controllers/instructor.controller');
const payphoneCtrl = require('../controllers/payphone.controller');

// ============================================================
// AUTH
// ============================================================
router.post('/auth/login', authCtrl.login);
router.get('/auth/me', authenticate, loadGym, authCtrl.getMe);
router.post('/auth/change-password', authenticate, authCtrl.changePassword);


// Manifest dinámico por gym
router.get('/gym/:slug/manifest.json', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT name, logo_url, primary_color FROM gyms WHERE slug = $1 AND is_active = TRUE',
      [req.params.slug]
    );
    
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Gym no encontrado' });
    }
    
    const gym = result.rows[0];
    const manifest = {
      name: gym.name,
      short_name: gym.name.substring(0, 12),
      description: `App de ${gym.name} - Gestiona tu membresía y reservas`,
      start_url: `/login?gym=${req.params.slug}`,
      display: 'standalone',
      background_color: '#0a0a0a',
      theme_color: gym.primary_color || '#E85D04',
      orientation: 'portrait',
      icons: [
        {
          src: gym.logo_url || '/icon-192.png',
          sizes: '192x192',
          type: 'image/png',
          purpose: 'any maskable'
        },
        {
          src: gym.logo_url || '/icon-512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any maskable'
        }
      ]
    };
    
    res.setHeader('Content-Type', 'application/manifest+json');
    res.json(manifest);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});


// Upload logo del gym
router.post('/super/upload-logo', authenticate, requireSuperAdmin, uploadGymLogo.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se subió ninguna imagen' });
  res.json({ url: req.file.path });
});

// Upload foto instructor
router.post('/admin/upload-photo', authenticate, loadGym, requireRole('admin', 'super_admin'), uploadInstructorPhoto.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se subió ninguna imagen' });
  res.json({ url: req.file.path });
});

// ============================================================
// SUPER ADMIN
// ============================================================

router.get('/super/gyms', authenticate, requireSuperAdmin, superCtrl.getGyms);
router.post('/super/gyms', authenticate, requireSuperAdmin, superCtrl.createGym);
router.put('/super/gyms/:gymId', authenticate, requireSuperAdmin, superCtrl.updateGym);
router.patch('/super/gyms/:gymId/toggle', authenticate, requireSuperAdmin, superCtrl.toggleGym);
router.delete('/super/gyms/:gymId', authenticate, requireSuperAdmin, superCtrl.deleteGym);
router.get('/super/gyms/:gymId/admins', authenticate, requireSuperAdmin, superCtrl.getGymAdmins);
router.post('/super/gyms/:gymId/admins', authenticate, requireSuperAdmin, superCtrl.addGymAdmin);
router.delete('/super/gyms/:gymId/admins/:userId', authenticate, requireSuperAdmin, superCtrl.removeGymAdmin);
router.get('/super/gyms/:gymId/membership-plans', authenticate, requireSuperAdmin, superCtrl.getGymMembershipPlans);
router.post('/super/gyms/:gymId/membership-plans', authenticate, requireSuperAdmin, superCtrl.createMembershipPlan);
router.post('/super/gyms/:gymId/apply-theme', authenticate, requireSuperAdmin, superCtrl.applyTheme);
router.get('/super/reports', authenticate, requireSuperAdmin, superCtrl.getGlobalReport);
router.get('/super/themes', authenticate, requireSuperAdmin, superCtrl.getThemes);

// ============================================================
// ADMIN DEL GYM
// ============================================================
const adminAuth = [authenticate, loadGym, requireRole('admin', 'super_admin')];
const wodAuth = [authenticate, requireAdminOrHeadCoach];
const wodReadAuth = [authenticate, requireStaffForWod];

// Actualizar perfil del admin
router.put('/admin/profile', ...adminAuth, async (req, res) => {
  try {
    const { name, email, phone } = req.body;
    await require('../config/database').query(
      'UPDATE users SET name=COALESCE($1,name), email=COALESCE($2,email), phone=COALESCE($3,phone), updated_at=NOW() WHERE id=$4',
      [name, email, phone, req.user.id]
    );
    res.json({ message: 'Perfil actualizado' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

router.get('/admin/dashboard', ...adminAuth, adminCtrl.getDashboard);

// Usuarios
router.get('/admin/users', ...adminAuth, adminCtrl.getUsers);
router.post('/admin/users', ...adminAuth, adminCtrl.createUser);
router.get('/admin/users/:userId', ...adminAuth, adminCtrl.getUserDetail);
router.put('/admin/users/:userId', ...adminAuth, adminCtrl.updateUser);
router.post('/admin/users/:userId/reset-password', ...adminAuth, adminCtrl.resetUserPassword);
router.post('/admin/users/:userId/activate-membership', ...adminAuth, adminCtrl.activateMembership);
router.get('/admin/users/:userId/memberships-history', ...adminAuth, adminCtrl.getUserMembershipsHistory);

// Tipos de membresía
router.get('/admin/membership-types', ...adminAuth, adminCtrl.getMembershipTypes);
router.post('/admin/membership-types', ...adminAuth, adminCtrl.createMembershipType);
router.put('/admin/membership-types/:typeId', ...adminAuth, adminCtrl.updateMembershipType);
router.delete('/admin/membership-types/:typeId', ...adminAuth, adminCtrl.deleteMembershipType);

// Membresías
router.get('/admin/memberships', ...adminAuth, adminCtrl.getMemberships);
router.post('/admin/memberships/:membershipId/cancel', ...adminAuth, adminCtrl.cancelMembership);

// Sesiones
router.get('/admin/sessions', ...adminAuth, adminCtrl.getSessions);
router.post('/admin/sessions', ...adminAuth, adminCtrl.createSession);
router.put('/admin/sessions/:sessionId', ...adminAuth, adminCtrl.updateSession);
router.delete('/admin/sessions/:sessionId', ...adminAuth, adminCtrl.deleteSession);

// Horarios
router.get('/admin/schedules', ...adminAuth, adminCtrl.getSchedules);
router.post('/admin/schedules', ...adminAuth, adminCtrl.createSchedule);
router.delete('/admin/schedules/:scheduleId', ...adminAuth, adminCtrl.deleteSchedule);

// Asistencia
router.get('/admin/attendance/classes', ...adminAuth, adminCtrl.getAttendanceClasses);
router.get('/admin/attendance/classes/:classInstanceId/students', ...adminAuth, adminCtrl.getAttendanceStudents);
router.post('/admin/attendance/bookings/:bookingId', ...adminAuth, adminCtrl.correctAttendance);
router.post('/admin/classes/:classInstanceId/cancel', ...adminAuth, adminCtrl.cancelClass);
router.post('/admin/classes/cancel-day', ...adminAuth, adminCtrl.cancelDay);
router.post('/admin/schedules/:classInstanceId/book', ...adminAuth, adminCtrl.bookStudent);

// Instructores
router.get('/admin/instructors', ...adminAuth, adminCtrl.getInstructors);
router.post('/admin/instructors', ...adminAuth, adminCtrl.createInstructor);
router.put('/admin/instructors/:instructorId', ...adminAuth, adminCtrl.updateInstructor);
router.delete('/admin/instructors/:instructorId', ...adminAuth, adminCtrl.deleteInstructor);

// Recepcionistas
router.get('/admin/receptionists', ...adminAuth, adminCtrl.getReceptionists);
router.post('/admin/receptionists', ...adminAuth, adminCtrl.createReceptionist);

// Pagos
router.get('/admin/payments', ...adminAuth, adminCtrl.getPayments);

// Reportes
router.get('/admin/reports', ...adminAuth, adminCtrl.getReports);
router.get('/admin/attendance', ...adminAuth, adminCtrl.getAttendanceHistory);
router.get('/admin/reception-audit', ...adminAuth, adminCtrl.getReceptionAudit);

// Validar ingreso
router.post('/admin/validate-entry', ...adminAuth, adminCtrl.validateEntry);

// Asignar rol adicional a un usuario
router.post('/admin/users/:userId/roles', ...adminAuth, async (req, res) => {
  try {
    const { role } = req.body;
    const validRoles = ['admin', 'instructor', 'recepcionista', 'user'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Rol inválido' });
    
    await db.query(`
      INSERT INTO user_gym_roles (user_id, gym_id, role, is_active)
      VALUES ($1, $2, $3, TRUE)
      ON CONFLICT (user_id, gym_id, role) DO UPDATE SET is_active = TRUE
    `, [req.params.userId, req.gym.id, role]);
    
    res.json({ message: 'Rol asignado exitosamente' });
  } catch (err) {
    console.error('Error asignando rol:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Quitar rol a un usuario
router.delete('/admin/users/:userId/roles/:role', ...adminAuth, async (req, res) => {
  try {
    await db.query(`
      UPDATE user_gym_roles SET is_active = FALSE
      WHERE user_id = $1 AND gym_id = $2 AND role = $3
    `, [req.params.userId, req.gym.id, req.params.role]);
    
    res.json({ message: 'Rol removido exitosamente' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============================================================
// RECEPCIÓN
// ============================================================
const recepAuth = [authenticate, loadGym, requireRole('recepcionista', 'admin', 'super_admin')];

router.get('/recepcion/dashboard', ...recepAuth, receptionCtrl.getDashboard);
router.get('/recepcion/clients', ...recepAuth, receptionCtrl.getClients);
router.post('/recepcion/clients', ...recepAuth, receptionCtrl.createClient);
router.get('/recepcion/clients/:userId', ...recepAuth, receptionCtrl.getClientDetail);
router.post('/recepcion/clients/:userId/membership', ...recepAuth, receptionCtrl.createMembership);
router.post('/recepcion/clients/:userId/payment', ...recepAuth, receptionCtrl.registerPayment);
router.get('/recepcion/memberships', ...recepAuth, receptionCtrl.getMemberships);
router.get('/recepcion/payments', ...recepAuth, receptionCtrl.getPayments);
router.get('/recepcion/schedules', ...recepAuth, receptionCtrl.getSchedules);
router.post('/recepcion/schedules/:classInstanceId/book', ...recepAuth, receptionCtrl.bookClient);
router.get('/recepcion/schedules/:classInstanceId/enrolled', ...recepAuth, receptionCtrl.getEnrolled);
router.post('/recepcion/scanner/validate', ...recepAuth, receptionCtrl.validateEntry);
router.get('/recepcion/attendance', ...recepAuth, receptionCtrl.getAttendance);
router.get('/recepcion/membership-types', ...recepAuth, receptionCtrl.getMembershipTypes);
router.post('/recepcion/memberships/:membershipId/cancel', ...recepAuth, receptionCtrl.cancelMembership);
router.get('/recepcion/users/:userId/memberships-history', ...recepAuth, receptionCtrl.getUserMembershipsHistory);

// ============================================================
// USUARIO / CLIENTE
// ============================================================
const userAuth = [authenticate, loadGym, requireRole('user', 'admin', 'super_admin')];

router.get('/usuario/home', ...userAuth, userCtrl.getHome);
router.get('/usuario/schedule', ...userAuth, userCtrl.getSchedule);
router.post('/usuario/schedule/:classInstanceId/book', ...userAuth, userCtrl.bookClass);
router.get('/usuario/bookings', ...userAuth, userCtrl.getMyBookings);
router.get('/usuario/qr', ...userAuth, userCtrl.getMyQR);
router.get('/usuario/profile', ...userAuth, userCtrl.getProfile);
router.put('/usuario/profile', ...userAuth, userCtrl.updateProfile);
router.get('/usuario/payment-history', ...userAuth, userCtrl.getPaymentHistory);
router.get('/usuario/notifications', ...userAuth, userCtrl.getNotifications);
router.get('/usuario/membership-plans', ...userAuth, userCtrl.getMembershipPlans);
router.get('/usuario/wod', ...userAuth, userCtrl.getTodayWod);
router.post('/usuario/cancel-auto-renew', ...userAuth, userCtrl.cancelAutoRenew);
router.post('/usuario/bookings/:bookingId/cancel', ...userAuth, userCtrl.cancelBooking);


// PayPhone — Cajita de Pagos (flujo correcto según documentación oficial)
router.get('/usuario/payphone/init', ...userAuth, payphoneCtrl.initPayment);
router.post('/usuario/payphone/confirm', ...userAuth, payphoneCtrl.confirmPayment);
router.post('/usuario/payphone/consent', ...userAuth, payphoneCtrl.signConsent);
router.get('/usuario/payphone/auto-charge', ...userAuth, payphoneCtrl.getAutoChargeStatus);
router.delete('/usuario/payphone/auto-charge', ...userAuth, payphoneCtrl.cancelAutoCharge);
router.get('/usuario/payment-result', payphoneCtrl.paymentResult); // sin auth — redirect de PayPhone

// Configuración PayPhone del Admin
router.post('/admin/settings/payphone', ...adminAuth, payphoneCtrl.saveGymPayphoneCredentials);
router.get('/admin/settings/payphone', ...adminAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT payphone_store_id as "storeId", payphone_token as "token", payphone_enabled as "enabled", payphone_coding_password as "codingPassword" FROM gyms WHERE id = $1',
      [req.gym.id]
    );
    res.json(result.rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET membresías activas del gym
router.get('/admin/memberships-list', ...adminAuth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT m.id, m.start_date, m.end_date, m.status, m.auto_renew,
             mt.name as type_name, mt.price,
             u.name as client_name, u.cedula as client_cedula
      FROM memberships m
      JOIN membership_types mt ON mt.id = m.membership_type_id
      JOIN users u ON u.id = m.user_id
      WHERE m.gym_id = $1
      ORDER BY m.created_at DESC
    `, [req.gym.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============================================================
// WODs
// ============================================================
router.get('/admin/wods', ...wodReadAuth, async (req, res) => {
  try {
    const { month, year } = req.query;
    const result = await db.query(`
      SELECT w.*, u.name as created_by_name
      FROM wods w
      LEFT JOIN users u ON u.id = w.created_by
      WHERE w.gym_id = $1
        AND EXTRACT(MONTH FROM w.wod_date) = $2
        AND EXTRACT(YEAR FROM w.wod_date) = $3
      ORDER BY w.wod_date ASC
    `, [req.gym.id, month || new Date().getMonth() + 1, year || new Date().getFullYear()]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error getWods:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.get('/admin/wods/:date', ...wodReadAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM wods WHERE gym_id = $1 AND wod_date = $2',
      [req.gym.id, req.params.date]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/admin/wods', ...wodAuth, async (req, res) => {
  try {
    const { date, title, description, warmup, workout, cooldown, notes, difficulty } = req.body;
    if (!date) return res.status(400).json({ error: 'Fecha requerida' });
    const result = await db.query(`
      INSERT INTO wods (gym_id, wod_date, title, description, warmup, workout, cooldown, notes, difficulty, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (gym_id, wod_date) DO UPDATE SET
        title = EXCLUDED.title, description = EXCLUDED.description,
        warmup = EXCLUDED.warmup, workout = EXCLUDED.workout,
        cooldown = EXCLUDED.cooldown, notes = EXCLUDED.notes,
        difficulty = EXCLUDED.difficulty, updated_at = NOW()
      RETURNING *
    `, [req.gym.id, date, title, description, warmup, workout, cooldown, notes, difficulty || 'rx', req.user.id]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error createWod:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.delete('/admin/wods/:date', ...wodAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM wods WHERE gym_id = $1 AND wod_date = $2', [req.gym.id, req.params.date]);
    res.json({ message: 'WOD eliminado' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

router.get('/usuario/wod', ...userAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await db.query(
      'SELECT * FROM wods WHERE gym_id = $1 AND wod_date = $2',
      [req.gym.id, today]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============================================================
// INSTRUCTOR
// ============================================================
const instrAuth = [authenticate, loadGym, requireRole('instructor', 'admin', 'super_admin')];

router.get('/instructor/today-classes', ...instrAuth, instrCtrl.getTodayClasses);
router.get('/instructor/attendance', ...instrAuth, instrCtrl.getAttendanceByDate);
router.get('/instructor/routines', ...instrAuth, instrCtrl.getRoutines);
router.post('/instructor/routines', ...instrAuth, instrCtrl.createRoutine);
router.get('/instructor/profile', ...instrAuth, instrCtrl.getProfile);
router.put('/instructor/profile', ...instrAuth, instrCtrl.updateProfile);
router.get('/instructor/classes/:classInstanceId/students', ...instrAuth, instrCtrl.getClassStudents);
router.post('/instructor/bookings/:bookingId/attendance', ...instrAuth, instrCtrl.markAttendance);

// ============================================================
// BACKUP — Super Admin
// ============================================================
router.get('/super/backup/download', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { exec } = require('child_process');
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) return res.status(500).json({ error: 'DATABASE_URL no configurado' });

    const filename = `gymvip_backup_${new Date().toISOString().split('T')[0]}.sql`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/sql');

    const pg_dump = exec(`pg_dump "${dbUrl}" --no-password`);
    pg_dump.stdout.pipe(res);
    pg_dump.stderr.on('data', (d) => console.error('pg_dump error:', d));
    pg_dump.on('error', () => res.status(500).json({ error: 'Error generando backup' }));
  } catch (err) {
    res.status(500).json({ error: 'Error interno al generar backup' });
  }
});

// ============================================================
// PÚBLICO — info del gym por slug (para login pages)
// ============================================================
router.get('/gym/:slug/info', async (req, res) => {
  try {
    const { slug } = req.params;
    const result = await require('../config/database').query(
      `SELECT slug, name, logo_url, email, phone, address,
              primary_color, secondary_color, theme, payphone_enabled
       FROM gyms WHERE slug=$1 AND is_active=TRUE`,
      [slug]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Gimnasio no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
