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
              is_active, payphone_enabled
       FROM gyms WHERE slug = $1`,
      [slug]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Gimnasio no encontrado' });
    }

    req.gym = result.rows[0];
    next();
  } catch (err) {
    console.error('Error en loadGym:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

module.exports = { authenticate, requireRole, requireSuperAdmin, loadGym };
