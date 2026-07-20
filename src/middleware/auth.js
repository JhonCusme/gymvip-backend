const jwt = require('jsonwebtoken');
const db = require('../config/database');

// Verificar token JWT
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token requerido' });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Obtener usuario actualizado de la BD
    const result = await db.query(
      'SELECT id, cedula, name, email, phone, is_active, is_super_admin, qr_code FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (!result.rows.length || !result.rows[0].is_active) {
      return res.status(401).json({ error: 'Usuario inválido o inactivo' });
    }

    req.user = result.rows[0];
    req.gymSlug = req.query.gym || req.params.gymSlug || decoded.gymSlug;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado' });
    }
    return res.status(401).json({ error: 'Token inválido' });
  }
};

// Verificar que el usuario tiene un rol específico en el gym actual
const requireRole = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      // Super admin tiene acceso a todo
      if (req.user.is_super_admin) return next();

      if (!req.gymSlug) {
        return res.status(400).json({ error: 'Gym no especificado' });
      }

      // Buscar el gym
      const gymResult = await db.query(
        'SELECT id FROM gyms WHERE slug = $1 AND is_active = TRUE',
        [req.gymSlug]
      );

      if (!gymResult.rows.length) {
        return res.status(404).json({ error: 'Gimnasio no encontrado' });
      }

      req.gym = gymResult.rows[0];

      // Verificar rol del usuario en este gym
      const roleResult = await db.query(
        `SELECT role FROM user_gym_roles 
         WHERE user_id = $1 AND gym_id = $2 AND is_active = TRUE
         AND role = ANY($3::varchar[])`,
        [req.user.id, req.gym.id, allowedRoles]
      );

      if (!roleResult.rows.length) {
        return res.status(403).json({ error: 'No tienes permisos para esta acción' });
      }

      req.userRole = roleResult.rows[0].role;
      next();
    } catch (err) {
      console.error('Error en requireRole:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  };
};

// Solo super admin
const requireSuperAdmin = (req, res, next) => {
  if (!req.user.is_super_admin) {
    return res.status(403).json({ error: 'Acceso exclusivo para Super Admin' });
  }
  next();
};

// Obtener gym del request (para rutas que necesitan el gym completo)
const loadGym = async (req, res, next) => {
  try {
    const slug = req.query.gym || req.params.gymSlug;
    if (!slug) return res.status(400).json({ error: 'Gym no especificado' });

    const result = await db.query(
      `SELECT id, slug, name, logo_url, email, phone, address, 
              primary_color, secondary_color, theme, booking_advance_days,
              is_active, payphone_enabled, timezone, saas_status
       FROM gyms WHERE slug = $1`,
      [slug]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Gimnasio no encontrado' });
    }

    const gym = result.rows[0];

    // Bloqueo por suspensión de pago del SaaS (402 = Payment Required)
    if (gym.saas_status === 'suspended') {
      return res.status(402).json({
        error: 'SERVICE_SUSPENDED',
        gymName: gym.name,
        message: 'El servicio está temporalmente suspendido.'
      });
    }

    req.gym = gym;
    next();
  } catch (err) {
    console.error('Error en loadGym:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Permite acceso si es admin/super_admin O instructor head coach
const requireAdminOrHeadCoach = async (req, res, next) => {
  try {
    if (req.user.is_super_admin) return next();

    if (!req.gymSlug) {
      return res.status(400).json({ error: 'Gym no especificado' });
    }

    const gymResult = await db.query(
      'SELECT id FROM gyms WHERE slug = $1 AND is_active = TRUE',
      [req.gymSlug]
    );
    if (!gymResult.rows.length) {
      return res.status(404).json({ error: 'Gimnasio no encontrado' });
    }
    req.gym = gymResult.rows[0];

    // ¿Es admin?
    const adminRole = await db.query(
      `SELECT role FROM user_gym_roles 
       WHERE user_id = $1 AND gym_id = $2 AND role = 'admin' AND is_active = TRUE`,
      [req.user.id, req.gym.id]
    );
    if (adminRole.rows.length) {
      req.userRole = 'admin';
      return next();
    }

    // ¿Es instructor head coach?
    const headCoach = await db.query(
      `SELECT id FROM instructors 
       WHERE user_id = $1 AND gym_id = $2 AND is_head_coach = TRUE AND is_active = TRUE`,
      [req.user.id, req.gym.id]
    );
    if (headCoach.rows.length) {
      req.userRole = 'head_coach';
      return next();
    }

    return res.status(403).json({ error: 'Solo administradores o head coaches pueden gestionar WODs' });
  } catch (err) {
    console.error('Error en requireAdminOrHeadCoach:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// Permite admin, head coach o cualquier instructor (para ver WODs)
const requireStaffForWod = async (req, res, next) => {
  try {
    if (req.user.is_super_admin) return next();
    if (!req.gymSlug) return res.status(400).json({ error: 'Gym no especificado' });

    const gymResult = await db.query('SELECT id FROM gyms WHERE slug = $1 AND is_active = TRUE', [req.gymSlug]);
    if (!gymResult.rows.length) return res.status(404).json({ error: 'Gimnasio no encontrado' });
    req.gym = gymResult.rows[0];

    // Admin, instructor o recepcionista pueden ver
    const role = await db.query(
      `SELECT role FROM user_gym_roles 
       WHERE user_id = $1 AND gym_id = $2 AND is_active = TRUE
       AND role IN ('admin', 'instructor', 'recepcionista')`,
      [req.user.id, req.gym.id]
    );
    if (role.rows.length) return next();

    return res.status(403).json({ error: 'Sin acceso' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

module.exports = { authenticate, requireRole, requireSuperAdmin, loadGym, requireAdminOrHeadCoach, requireStaffForWod };