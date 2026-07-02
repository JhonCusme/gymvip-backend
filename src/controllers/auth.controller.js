const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');

// POST /api/auth/login
// Body: { cedula, password, gym } (gym es el slug)
const login = async (req, res) => {
  try {
    const { cedula, password, gym } = req.body;

    if (!cedula || !password) {
      return res.status(400).json({ error: 'Cédula y contraseña son requeridas' });
    }

    // 1. Buscar usuario
    const userResult = await db.query(
      `SELECT id, cedula, name, email, phone, password_hash, is_active, is_super_admin, qr_code
       FROM users WHERE cedula = $1`,
      [cedula]
    );

    if (!userResult.rows.length) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    const user = userResult.rows[0];

    if (!user.is_active) {
      return res.status(401).json({ error: 'Usuario inactivo' });
    }

    // 2. Verificar contraseña
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    // 3. Super Admin — no necesita gym
    if (user.is_super_admin && !gym) {
      const token = jwt.sign(
        { userId: user.id, role: 'super_admin', isSuperAdmin: true },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );
      return res.json({
        token,
        user: {
          id: user.id,
          cedula: user.cedula,
          name: user.name,
          email: user.email,
          role: 'super_admin',
          isSuperAdmin: true
        },
        redirectTo: '/gyms'
      });
    }

    // 4. Necesita gym para login normal
    if (!gym) {
      return res.status(400).json({ error: 'Debes especificar el gimnasio' });
    }

    // 5. Buscar el gym
    const gymResult = await db.query(
  'SELECT id, slug, name, logo_url, primary_color, secondary_color, theme, payphone_enabled FROM gyms WHERE slug = $1 AND is_active = TRUE',
  [gym]
);

    if (!gymResult.rows.length) {
      return res.status(404).json({ error: 'Gimnasio no encontrado o inactivo' });
    }

    const gymData = gymResult.rows[0];

 // 6. Obtener todos los roles del usuario en este gym
    const roleResult = await db.query(
      `SELECT role FROM user_gym_roles 
       WHERE user_id = $1 AND gym_id = $2 AND is_active = TRUE
       ORDER BY 
         CASE role 
           WHEN 'admin' THEN 1 
           WHEN 'recepcionista' THEN 2 
           WHEN 'instructor' THEN 3 
           WHEN 'user' THEN 4 
         END`,
      [user.id, gymData.id]
    );

    if (!roleResult.rows.length) {
      return res.status(403).json({ error: 'No tienes acceso a este gimnasio' });
    }

    const roles = roleResult.rows.map(r => r.role);
    const primaryRole = roles[0]; // rol de mayor prioridad

    // 7. Si tiene múltiples roles, devolver lista para que el frontend muestre selección
    if (roles.length > 1) {
      return res.json({
        multiRole: true,
        roles,
        user: {
          id: user.id,
          cedula: user.cedula,
          name: user.name,
          email: user.email,
          phone: user.phone,
          qrCode: user.qr_code
        },
        gym: {
          id: gymData.id,
          slug: gymData.slug,
          name: gymData.name,
          logoUrl: gymData.logo_url,
          primaryColor: gymData.primary_color,
          secondaryColor: gymData.secondary_color,
          theme: gymData.theme,
          payphoneEnabled: gymData.payphone_enabled || false
        }
      });
    }

    // 8. Un solo rol — flujo normal
    const role = primaryRole;
    const token = jwt.sign(
      { userId: user.id, gymId: gymData.id, gymSlug: gymData.slug, role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    const redirectMap = {
      admin: '/dashboard',
      recepcionista: '/recepcion',
      instructor: '/instructor',
      user: '/usuario/home'
    };

    res.json({
      token,
      role,
      user: {
        id: user.id,
        cedula: user.cedula,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role,
        qrCode: user.qr_code
      },
      gym: {
        id: gymData.id,
        slug: gymData.slug,
        name: gymData.name,
        logoUrl: gymData.logo_url,
        primaryColor: gymData.primary_color,
        secondaryColor: gymData.secondary_color,
        theme: gymData.theme,
        payphoneEnabled: gymData.payphone_enabled || false
      },
      redirectTo: redirectMap[role] || '/usuario/home'
    });

  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// GET /api/auth/me
const getMe = async (req, res) => {
  try {
    const user = req.user;
    let gymData = null;
    let membershipData = null;

    if (req.gym) {
      gymData = {
        id: req.gym.id,
        slug: req.gym.slug,
        name: req.gym.name,
      };

      // Obtener membresía activa si es usuario
      if (req.userRole === 'user') {
        const memResult = await db.query(
          `SELECT m.id, mt.name, m.start_date, m.end_date, m.status, m.auto_renew,
                  (m.end_date - CURRENT_DATE) as days_remaining
           FROM memberships m
           JOIN membership_types mt ON m.membership_type_id = mt.id
           WHERE m.user_id = $1 AND m.gym_id = $2
             AND m.status = 'active' AND m.end_date >= CURRENT_DATE
           ORDER BY m.end_date DESC LIMIT 1`,
          [user.id, req.gym.id]
        );
        membershipData = memResult.rows[0] || null;
      }
    }

    res.json({
      user: {
        id: user.id,
        cedula: user.cedula,
        name: user.name,
        email: user.email,
        phone: user.phone,
        isSuperAdmin: user.is_super_admin,
        qrCode: user.qr_code
      },
      gym: gymData,
      role: req.userRole || (user.is_super_admin ? 'super_admin' : null),
      membership: membershipData
    });
  } catch (err) {
    console.error('Error en getMe:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// POST /api/auth/change-password
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    // Obtener password actual
    const result = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);

    if (!valid) {
      return res.status(400).json({ error: 'Contraseña actual incorrecta' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, req.user.id]);

    res.json({ message: 'Contraseña actualizada exitosamente' });
  } catch (err) {
    console.error('Error en changePassword:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

module.exports = { login, getMe, changePassword };
