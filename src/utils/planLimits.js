const db = require('../config/database');

const TOLERANCE = 0.10; // 10% de margen

// Verifica si el gym puede agregar un usuario más
async function canAddUser(gymId) {
  const gym = await db.query(
    'SELECT saas_max_users, name FROM gyms WHERE id = $1',
    [gymId]
  );

  if (!gym.rows.length) return { allowed: false, reason: 'Gym no encontrado' };

  const maxUsers = gym.rows[0].saas_max_users;

  // Sin límite (plan ilimitado o sin plan asignado)
  if (!maxUsers) return { allowed: true };

  const count = await db.query(`
    SELECT COUNT(*) as total FROM user_gym_roles ugr
    JOIN users u ON u.id = ugr.user_id
    WHERE ugr.gym_id = $1 AND ugr.role = 'user' AND ugr.is_active = TRUE AND u.is_active = TRUE
      AND ugr.user_id NOT IN (
        SELECT user_id FROM user_gym_roles WHERE gym_id = $1 AND role IN ('admin','instructor','recepcionista') AND is_active = TRUE
      )
  `, [gymId]);

  const current = parseInt(count.rows[0].total);
  const hardLimit = Math.floor(maxUsers * (1 + TOLERANCE));

  if (current >= hardLimit) {
    return {
      allowed: false,
      reason: `Has alcanzado el límite de usuarios de tu plan (${maxUsers}). Contacta a soporte para ampliar tu plan.`,
      current,
      maxUsers,
      hardLimit
    };
  }

  return { allowed: true, current, maxUsers, hardLimit };
}

module.exports = { canAddUser };