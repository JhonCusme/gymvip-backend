const db = require('../config/database');
const QRCode = require('qrcode');
const axios = require('axios');

// GET /api/usuario/home
const getHome = async (req, res) => {
  try {
    const userId = req.user.id;
    const gymId = req.gym.id;

    // Membresía activa o la última vencida (para mostrar estado de cobro fallido)
    const membership = await db.query(`
      SELECT m.id, m.start_date, m.end_date, m.status, m.auto_renew,
             m.recurring_failed_attempts,
             mt.name as type_name, (m.end_date - CURRENT_DATE) as days_remaining
      FROM memberships m JOIN membership_types mt ON mt.id = m.membership_type_id
      WHERE m.user_id=$1 AND m.gym_id=$2 
        AND m.status IN ('active', 'expired')
      ORDER BY 
        CASE WHEN m.end_date >= CURRENT_DATE THEN 0 ELSE 1 END,
        m.end_date DESC 
      LIMIT 1
    `, [userId, gymId]);

    // Próximas clases reservadas
    const upcomingClasses = await db.query(`
      SELECT b.id, ci.class_date, ci.start_time, ci.end_time,
             s.name as session_name, i.name as instructor_name, b.status
      FROM bookings b
      JOIN class_instances ci ON ci.id = b.class_instance_id
      JOIN sessions s ON s.id = ci.session_id
      LEFT JOIN instructors i ON i.id = ci.instructor_id
      WHERE b.user_id=$1 AND b.gym_id=$2 AND b.status='confirmed'
        AND ci.class_date >= CURRENT_DATE
      ORDER BY ci.class_date ASC, ci.start_time ASC LIMIT 5
    `, [userId, gymId]);

    // Info del gym
    const gym = await db.query(`
      SELECT name, logo_url, email, phone, address, primary_color, secondary_color, theme, payphone_enabled
      FROM gyms WHERE id=$1
    `, [gymId]);

    // WOD de hoy
    const wod = await db.query(
      'SELECT * FROM wods WHERE gym_id=$1 AND wod_date=CURRENT_DATE LIMIT 1',
      [gymId]
    );

    res.json({
      user: {
        name: req.user.name,
        cedula: req.user.cedula
      },
      gym: gym.rows[0],
      membership: membership.rows[0] || null,
      upcomingClasses: upcomingClasses.rows,
      todayWod: wod.rows[0] || null
    });
  } catch (err) {
    console.error('Error usuario getHome:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};


// GET /api/usuario/schedule?date=
const getSchedule = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const userId = req.user.id;
    const { date = new Date().toISOString().split('T')[0] } = req.query;
    console.log('getSchedule llamado - gymId:', gymId, 'date:', date, 'userId:', userId);

// Generar instancias
try {
  await db.query('SELECT generate_class_instances_for_date($1::uuid, $2::date)', [gymId, date]);
  console.log('Instancias generadas OK');
} catch (genErr) {
  console.error('Error generando instancias:', genErr.message);
}

// Verificar membresía
console.log('Verificando membresía...');
const hasMembership = await db.query(`
  SELECT id FROM memberships
  WHERE user_id=$1 AND gym_id=$2 AND status='active' AND end_date>=CURRENT_DATE LIMIT 1
`, [userId, gymId]);
console.log('Membresía encontrada:', hasMembership.rows.length);

console.log('Obteniendo config del gym...');
const gymConfig = await db.query(
  'SELECT booking_advance_days FROM gyms WHERE id=$1', [gymId]
);
console.log('Config gym OK, advanceDays:', gymConfig.rows[0]?.booking_advance_days);

const advanceDays = gymConfig.rows[0]?.booking_advance_days || 7;
const maxDate = new Date();
maxDate.setDate(maxDate.getDate() + advanceDays);
const requestDate = new Date(date);
console.log('maxDate:', maxDate, 'requestDate:', requestDate, 'valido:', requestDate <= maxDate);

console.log('Consultando clases...');

    if (requestDate > maxDate) {
      return res.json({ classes: [], message: `Solo puedes ver hasta ${advanceDays} días de anticipación` });
    }

const classes = await db.query(`
  SELECT ci.id, ci.class_date, ci.start_time, ci.end_time, ci.max_capacity,
         s.name as session_name, s.duration_minutes, s.difficulty,
         i.name as instructor_name,
         COUNT(b2.id) FILTER (WHERE b2.status='confirmed') as booked_count,
         BOOL_OR(CASE WHEN b.user_id=$3 AND b.status='confirmed' THEN true ELSE false END) as is_booked
  FROM class_instances ci
  JOIN sessions s ON s.id = ci.session_id
  LEFT JOIN instructors i ON i.id = ci.instructor_id
  LEFT JOIN bookings b ON b.class_instance_id = ci.id AND b.user_id = $3
  LEFT JOIN bookings b2 ON b2.class_instance_id = ci.id
 WHERE ci.gym_id=$1 AND ci.class_date=$2 AND ci.status='scheduled'
AND (ci.class_date > CURRENT_DATE OR ci.end_time > CURRENT_TIME)
  GROUP BY ci.id, s.name, s.duration_minutes, s.difficulty, i.name
  ORDER BY ci.start_time ASC
`, [gymId, date, userId]);
console.log('Clases encontradas:', classes.rows.length);

res.json({
  classes: classes.rows,
  hasMembership: hasMembership.rows.length > 0,
  advanceDays
});
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/usuario/schedule/:classInstanceId/book — reservar clase
const bookClass = async (req, res) => {
  try {
    const { classInstanceId } = req.params;
    const userId = req.user.id;
    const gymId = req.gym.id;

    // Verificar membresía activa
    const mem = await db.query(`
      SELECT id FROM memberships
      WHERE user_id=$1 AND gym_id=$2 AND status='active' AND end_date>=CURRENT_DATE LIMIT 1
    `, [userId, gymId]);

    if (!mem.rows.length) {
      return res.status(400).json({ error: 'Necesitas una membresía activa para reservar clases' });
    }

    // Verificar capacidad
    const classResult = await db.query(`
      SELECT ci.max_capacity, ci.class_date, ci.start_time,
             COUNT(b.id) FILTER (WHERE b.status='confirmed') as booked
      FROM class_instances ci
      LEFT JOIN bookings b ON b.class_instance_id = ci.id
      WHERE ci.id=$1 AND ci.gym_id=$2
      GROUP BY ci.id
    `, [classInstanceId, gymId]);

    if (!classResult.rows.length) return res.status(404).json({ error: 'Clase no encontrada' });
    const cls = classResult.rows[0];

    if (parseInt(cls.booked) >= cls.max_capacity) {
      return res.status(400).json({ error: 'La clase ya no tiene lugares disponibles' });
    }

    // Verificar que no esté ya reservada
    const existing = await db.query(
      "SELECT id FROM bookings WHERE user_id=$1 AND class_instance_id=$2 AND status='confirmed'",
      [userId, classInstanceId]
    );
    if (existing.rows.length) {
      return res.status(400).json({ error: 'Ya tienes una reserva para esta clase' });
    }

    await db.query(`
      INSERT INTO bookings (gym_id, user_id, class_instance_id, status, booked_by, booked_by_role)
      VALUES ($1,$2,$3,'confirmed',$2,'user')
    `, [gymId, userId, classInstanceId]);

    res.status(201).json({ message: 'Clase reservada exitosamente' });
  } catch (err) {
    console.error('Error bookClass:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// DELETE /api/usuario/bookings/:bookingId — cancelar reserva
const cancelBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    await db.query(
      "UPDATE bookings SET status='cancelled', updated_at=NOW() WHERE id=$1 AND user_id=$2",
      [bookingId, req.user.id]
    );
    res.json({ message: 'Reserva cancelada' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/usuario/bookings — mis reservas
const getMyBookings = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT b.id, b.status, ci.class_date, ci.start_time, ci.end_time,
             s.name as session_name, i.name as instructor_name,
             (b.status = 'attended') as attended
      FROM bookings b
      JOIN class_instances ci ON ci.id = b.class_instance_id
      JOIN sessions s ON s.id = ci.session_id
      LEFT JOIN instructors i ON i.id = ci.instructor_id
      WHERE b.user_id=$1 AND b.gym_id=$2
      ORDER BY ci.class_date DESC, ci.start_time DESC
    `, [req.user.id, req.gym.id]);

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const cancelled = result.rows.filter(b => b.status === 'cancelled');
    // Próximas: confirmadas y de hoy en adelante
    const upcoming = result.rows.filter(b => 
      b.status === 'confirmed' && new Date(b.class_date.toISOString?.() || b.class_date) >= today
    );
    // Pasadas: ya marcadas por el coach (attended/no_show) o de fecha anterior
    const past = result.rows.filter(b => 
      b.status === 'attended' || b.status === 'no_show' ||
      (b.status === 'confirmed' && new Date(b.class_date.toISOString?.() || b.class_date) < today)
    );

    res.json({ upcoming, past, cancelled });
  } catch (err) {
    console.error('Error getMyBookings:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/usuario/qr — mi código QR
const getMyQR = async (req, res) => {
  try {
    const userId = req.user.id;
    const gymId = req.gym.id;

    const userResult = await db.query(
      'SELECT name, cedula, qr_code FROM users WHERE id=$1', [userId]
    );
    const user = userResult.rows[0];

    // Generar imagen QR
    const qrDataUrl = await QRCode.toDataURL(user.qr_code, {
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });

    // Membresía activa
    const mem = await db.query(`
      SELECT m.end_date, m.status, mt.name as type_name
      FROM memberships m JOIN membership_types mt ON mt.id = m.membership_type_id
      WHERE m.user_id=$1 AND m.gym_id=$2 AND m.status='active' AND m.end_date>=CURRENT_DATE
      ORDER BY m.end_date DESC LIMIT 1
    `, [userId, gymId]);

    res.json({
      name: user.name,
      cedula: user.cedula,
      qrCode: user.qr_code,
      qrImage: qrDataUrl,
      membership: mem.rows[0] || null
    });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/usuario/profile
const getProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const gymId = req.gym.id;

    const user = await db.query(
      'SELECT id, cedula, name, email, phone, created_at FROM users WHERE id=$1', [userId]
    );

    const membership = await db.query(`
      SELECT m.id, m.start_date, m.end_date, m.status, m.auto_renew,
             mt.name as type_name
      FROM memberships m JOIN membership_types mt ON mt.id=m.membership_type_id
      WHERE m.user_id=$1 AND m.gym_id=$2 AND m.status='active' AND m.end_date>=CURRENT_DATE
      ORDER BY m.end_date DESC LIMIT 1
    `, [userId, gymId]);

    res.json({ user: user.rows[0], membership: membership.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// PUT /api/usuario/profile
const updateProfile = async (req, res) => {
  try {
    const { name, email, phone } = req.body;
    await db.query(
      'UPDATE users SET name=COALESCE($1,name), email=COALESCE($2,email), phone=COALESCE($3,phone), updated_at=NOW() WHERE id=$4',
      [name, email, phone, req.user.id]
    );
    res.json({ message: 'Perfil actualizado' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/usuario/payment-history
const getPaymentHistory = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT p.id, p.amount, p.method, p.status, p.created_at, mt.name as membership_name
      FROM payments p LEFT JOIN membership_types mt ON mt.id=p.membership_type_id
      WHERE p.user_id=$1 AND p.gym_id=$2
      ORDER BY p.created_at DESC
    `, [req.user.id, req.gym.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/usuario/notifications
const getNotifications = async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM notifications WHERE user_id=$1 AND (gym_id=$2 OR gym_id IS NULL) ORDER BY created_at DESC LIMIT 30',
      [req.user.id, req.gym.id]
    );
    await db.query('UPDATE notifications SET is_read=TRUE WHERE user_id=$1 AND is_read=FALSE', [req.user.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// ============================================================
// PAYPHONE — Pagar membresía
// ============================================================

// GET /api/usuario/membership-plans — planes disponibles del gym
const getMembershipPlans = async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM membership_types WHERE gym_id=$1 AND is_active=TRUE AND is_public=TRUE ORDER BY price ASC',
      [req.gym.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/usuario/payphone/pay — iniciar pago PayPhone
const initiatePayphonePayment = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const userId = req.user.id;
    const { membershipTypeId, cardNumber, cardExpiry, cardCvv, cardHolder, email } = req.body;

    // Obtener credenciales PayPhone del gym
    const gymResult = await db.query(
      'SELECT payphone_enabled, payphone_store_id, payphone_token FROM gyms WHERE id=$1',
      [gymId]
    );
    const gym = gymResult.rows[0];

    if (!gym.payphone_enabled || !gym.payphone_token) {
      return res.status(400).json({ error: 'Pagos con PayPhone no habilitados en este gimnasio' });
    }

    // Obtener plan
    const planResult = await db.query(
      'SELECT * FROM membership_types WHERE id=$1 AND gym_id=$2 AND is_active=TRUE',
      [membershipTypeId, gymId]
    );
    if (!planResult.rows.length) return res.status(404).json({ error: 'Plan no encontrado' });
    const plan = planResult.rows[0];

    const amountCents = Math.round(plan.price * 100);

    // Llamar a PayPhone API
    const payphoneResponse = await axios.post(
      `${process.env.PAYPHONE_API_URL}/button/Payments`,
      {
        storeId: gym.payphone_store_id,
        amount: amountCents,
        amountWithTax: 0,
        amountWithoutTax: amountCents,
        tax: 0,
        currency: 'USD',
        reference: `MEM-${userId}-${Date.now()}`,
        documentId: req.user.cedula,
        email,
        cardNumber,
        cardExpirationDate: cardExpiry,
        cvv: cardCvv,
        cardHolder,
        phoneNumber: req.user.phone || ''
      },
      {
        headers: {
          Authorization: `Bearer ${gym.payphone_token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const ppData = payphoneResponse.data;

    if (ppData.transactionStatus === 'Approved') {
      // Calcular fechas
      const startDate = new Date();
      const endDate = new Date();
      if (plan.duration_unit === 'days') endDate.setDate(endDate.getDate() + plan.duration_value);
      else if (plan.duration_unit === 'weeks') endDate.setDate(endDate.getDate() + plan.duration_value * 7);
      else if (plan.duration_unit === 'months') endDate.setMonth(endDate.getMonth() + plan.duration_value);
      else if (plan.duration_unit === 'years') endDate.setFullYear(endDate.getFullYear() + plan.duration_value);

      // Crear membresía
      const memResult = await db.query(`
        INSERT INTO memberships (user_id, gym_id, membership_type_id, start_date, end_date, status, auto_renew)
        VALUES ($1,$2,$3,$4,$5,'active',$6) RETURNING id
      `, [userId, gymId, membershipTypeId,
          startDate.toISOString().split('T')[0],
          endDate.toISOString().split('T')[0],
          req.user.payphone_token ? true : false]);

      // Registrar pago
      await db.query(`
        INSERT INTO payments (gym_id, user_id, membership_id, membership_type_id, amount, method, status, payphone_transaction_id, payphone_response)
        VALUES ($1,$2,$3,$4,$5,'payphone','pagado',$6,$7)
      `, [gymId, userId, memResult.rows[0].id, membershipTypeId, plan.price,
          ppData.transactionId, JSON.stringify(ppData)]);

      return res.json({
        success: true,
        message: '¡Pago exitoso! Tu membresía ha sido renovada.',
        membership: { startDate, endDate, typeName: plan.name }
      });
    } else {
      return res.status(400).json({
        success: false,
        error: 'Pago rechazado por PayPhone',
        details: ppData.transactionStatus
      });
    }
  } catch (err) {
    if (err.response) {
      return res.status(400).json({ error: 'Error en PayPhone', details: err.response.data });
    }
    console.error('Error payphone:', err);
    res.status(500).json({ error: 'Error interno al procesar el pago' });
  }
};

// POST /api/usuario/payphone/consent — firmar contrato de cobro automático
const signAutoChargeConsent = async (req, res) => {
  try {
    await db.query(
      'UPDATE users SET payphone_consent_signed=TRUE, payphone_consent_date=NOW() WHERE id=$1',
      [req.user.id]
    );
    res.json({ message: 'Consentimiento firmado exitosamente' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/usuario/payphone/auto-charge-status
const getAutoChargeStatus = async (req, res) => {
  try {
    const result = await db.query(
      'SELECT payphone_token, payphone_token_date, payphone_consent_signed, payphone_consent_date FROM users WHERE id=$1',
      [req.user.id]
    );
    const u = result.rows[0];

    // Pagos PayPhone del usuario
    const payments = await db.query(`
      SELECT p.amount, p.created_at, mt.name as membership_name, p.status
      FROM payments p LEFT JOIN membership_types mt ON mt.id=p.membership_type_id
      WHERE p.user_id=$1 AND p.gym_id=$2 AND p.method='payphone'
      ORDER BY p.created_at DESC LIMIT 10
    `, [req.user.id, req.gym.id]);

    res.json({
      hasCard: !!u.payphone_token,
      cardDate: u.payphone_token_date,
      consentSigned: u.payphone_consent_signed,
      consentDate: u.payphone_consent_date,
      autoRenewActive: !!(u.payphone_token && u.payphone_consent_signed),
      payphonePayments: payments.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// DELETE /api/usuario/payphone/auto-charge — cancelar cobro automático
const cancelAutoCharge = async (req, res) => {
  try {
    await db.query(
      'UPDATE users SET payphone_token=NULL, payphone_consent_signed=FALSE WHERE id=$1',
      [req.user.id]
    );
    // Desactivar auto_renew en membresías activas
    await db.query(
      'UPDATE memberships SET auto_renew=FALSE WHERE user_id=$1 AND gym_id=$2 AND status=\'active\'',
      [req.user.id, req.gym.id]
    );
    res.json({ message: 'Cobro automático cancelado' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/usuario/wod — WOD de hoy
const getTodayWod = async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM wods WHERE gym_id=$1 AND wod_date=CURRENT_DATE LIMIT 1',
      [req.gym.id]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/usuario/payphone/payment-result — resultado de pago (webhook/redirect)
const paymentResult = async (req, res) => {
  try {
    const { clientTransactionId, transactionStatus } = req.query;
    if (transactionStatus === 'Approved') {
      res.json({ success: true, message: '¡Pago aprobado! Tu membresía ha sido renovada.' });
    } else {
      res.json({ success: false, message: 'El pago no fue aprobado. Intenta de nuevo.' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

module.exports = {
  getHome, getSchedule, bookClass, cancelBooking, getMyBookings,
  getMyQR, getProfile, updateProfile, getPaymentHistory,
  getNotifications, getMembershipPlans,
  initiatePayphonePayment, signAutoChargeConsent,
  getAutoChargeStatus, cancelAutoCharge,
  getTodayWod, paymentResult
};
