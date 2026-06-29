const axios = require('axios');
const db = require('../config/database');

const PAYPHONE_CONFIRM_URL = 'https://paymentbox.payphonetodoesposible.com/api/confirm';

// ============================================================
// GET /api/usuario/payphone/init
// Devuelve los parámetros necesarios para renderizar la Cajita de Pagos
// El frontend inyecta el widget JS de PayPhone con estos datos
// ============================================================
const initPayment = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const userId = req.user.id;
    const { membershipTypeId } = req.query;

    if (!membershipTypeId) {
      return res.status(400).json({ error: 'membershipTypeId requerido' });
    }

    // Obtener credenciales PayPhone del gym
    const gymResult = await db.query(
      `SELECT name, payphone_enabled, payphone_store_id, payphone_token
       FROM gyms WHERE id = $1`,
      [gymId]
    );
    const gym = gymResult.rows[0];

    if (!gym.payphone_enabled) {
      return res.status(400).json({ error: 'PayPhone no está habilitado en este gimnasio' });
    }
    if (!gym.payphone_token || !gym.payphone_store_id) {
      return res.status(400).json({ error: 'Credenciales de PayPhone no configuradas. Contacta al administrador.' });
    }

    // Obtener plan de membresía
    const planResult = await db.query(
      'SELECT * FROM membership_types WHERE id = $1 AND gym_id = $2 AND is_active = TRUE',
      [membershipTypeId, gymId]
    );
    if (!planResult.rows.length) {
      return res.status(404).json({ error: 'Plan de membresía no encontrado' });
    }
    const plan = planResult.rows[0];

    // Generar clientTransactionId único (máx 50 caracteres)
    const clientTransactionId = `MEM-${userId.substring(0, 8)}-${Date.now()}`;

    // Guardar la intención de pago para poder confirmarla después
    await db.query(`
      INSERT INTO payment_intents (client_transaction_id, user_id, gym_id, membership_type_id, amount, status)
      VALUES ($1, $2, $3, $4, $5, 'pending')
      ON CONFLICT (client_transaction_id) DO NOTHING
    `, [clientTransactionId, userId, gymId, membershipTypeId, plan.price]);

    // El amount en PayPhone va en centavos (enteros)
    const amountCents = Math.round(plan.price * 100);

    // Devolver parámetros al frontend para renderizar la cajita
    res.json({
      token: gym.payphone_token,
      storeId: gym.payphone_store_id,
      clientTransactionId,
      amount: amountCents,
      amountWithoutTax: amountCents, // sin IVA por defecto (membresías de gym)
      currency: 'USD',
      reference: `Membresía ${plan.name} - ${gym.name}`,
      lang: 'es',
      timeZone: -5,
      // Datos del usuario para pre-llenar el formulario
      phoneNumber: req.user.phone ? `+593${req.user.phone.replace(/^0/, '')}` : undefined,
      email: req.user.email || undefined,
      documentId: req.user.cedula,
      identificationType: 1, // Cédula
      // Info del plan para mostrar al usuario
      plan: {
        name: plan.name,
        price: plan.price,
        durationValue: plan.duration_value,
        durationUnit: plan.duration_unit
      }
    });

  } catch (err) {
    console.error('Error payphone initPayment:', err);
    res.status(500).json({ error: 'Error interno al iniciar pago' });
  }
};

// ============================================================
// POST /api/usuario/payphone/confirm
// PayPhone redirige al usuario a la URL de respuesta con ?id=xxx&clientTransactionId=xxx
// El frontend llama a este endpoint para confirmar con PayPhone y activar la membresía
// ============================================================
const confirmPayment = async (req, res) => {
  try {
    const { id, clientTransactionId } = req.body;

    if (!id || !clientTransactionId) {
      return res.status(400).json({ error: 'id y clientTransactionId son requeridos' });
    }

    // Buscar la intención de pago
    const intentResult = await db.query(
      `SELECT pi.*, mt.duration_value, mt.duration_unit, mt.name as type_name,
              g.payphone_token, g.payphone_enabled
       FROM payment_intents pi
       JOIN membership_types mt ON mt.id = pi.membership_type_id
       JOIN gyms g ON g.id = pi.gym_id
       WHERE pi.client_transaction_id = $1`,
      [clientTransactionId]
    );

    if (!intentResult.rows.length) {
      return res.status(404).json({ error: 'Intención de pago no encontrada' });
    }

    const intent = intentResult.rows[0];

    // Verificar que el usuario es el dueño de esta intención
    if (intent.user_id !== req.user.id) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    // Si ya fue procesada, devolver el resultado guardado
    if (intent.status === 'completed') {
      return res.json({ success: true, message: 'Membresía ya activada', alreadyProcessed: true });
    }
    if (intent.status === 'failed') {
      return res.json({ success: false, message: 'El pago fue rechazado anteriormente' });
    }

    // Confirmar con PayPhone (POST al endpoint de confirmación)
    let payphoneData;
    try {
      const payphoneRes = await axios.post(
        PAYPHONE_CONFIRM_URL,
        { id: parseInt(id), clientTxId: clientTransactionId },
        {
          headers: {
            'Authorization': `Bearer ${intent.payphone_token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      payphoneData = payphoneRes.data;
    } catch (ppErr) {
      console.error('Error confirmando con PayPhone:', ppErr.response?.data || ppErr.message);
      return res.status(400).json({
        error: 'Error al confirmar pago con PayPhone',
        details: ppErr.response?.data?.message || ppErr.message
      });
    }

    // Verificar si fue aprobado (statusCode 3 = Approved)
    if (payphoneData.transactionStatus !== 'Approved' || payphoneData.statusCode !== 3) {
      // Marcar intención como fallida
      await db.query(
        "UPDATE payment_intents SET status = 'failed', payphone_response = $1 WHERE client_transaction_id = $2",
        [JSON.stringify(payphoneData), clientTransactionId]
      );
      return res.json({
        success: false,
        message: 'El pago no fue aprobado',
        status: payphoneData.transactionStatus,
        details: payphoneData.message
      });
    }

    // PAGO APROBADO — Activar membresía
    const startDate = new Date();
    const endDate = new Date();
    const { duration_value, duration_unit } = intent;

    if (duration_unit === 'days') endDate.setDate(endDate.getDate() + duration_value);
    else if (duration_unit === 'weeks') endDate.setDate(endDate.getDate() + duration_value * 7);
    else if (duration_unit === 'months') endDate.setMonth(endDate.getMonth() + duration_value);
    else if (duration_unit === 'years') endDate.setFullYear(endDate.getFullYear() + duration_value);

    // Crear membresía
    const memResult = await db.query(`
      INSERT INTO memberships (user_id, gym_id, membership_type_id, start_date, end_date, status)
      VALUES ($1, $2, $3, $4, $5, 'active')
      RETURNING id
    `, [
      intent.user_id, intent.gym_id, intent.membership_type_id,
      startDate.toISOString().split('T')[0],
      endDate.toISOString().split('T')[0]
    ]);

    // Registrar pago
    await db.query(`
      INSERT INTO payments (gym_id, user_id, membership_id, membership_type_id, amount, method, status, payphone_transaction_id, payphone_response)
      VALUES ($1, $2, $3, $4, $5, 'payphone', 'pagado', $6, $7)
    `, [
      intent.gym_id, intent.user_id, memResult.rows[0].id, intent.membership_type_id,
      intent.amount, payphoneData.transactionId?.toString(), JSON.stringify(payphoneData)
    ]);

    // Guardar cardToken si viene (para cobro automático futuro)
    if (payphoneData.cardToken) {
      await db.query(
        'UPDATE users SET payphone_token = $1, payphone_token_date = NOW() WHERE id = $2',
        [payphoneData.cardToken, intent.user_id]
      );
    }

    // Marcar intención como completada
    await db.query(
      "UPDATE payment_intents SET status = 'completed', payphone_response = $1, payphone_transaction_id = $2 WHERE client_transaction_id = $3",
      [JSON.stringify(payphoneData), payphoneData.transactionId?.toString(), clientTransactionId]
    );

    // Notificación al usuario
    await db.query(`
      INSERT INTO notifications (user_id, gym_id, title, message, type)
      VALUES ($1, $2, '¡Pago exitoso!', $3, 'payment')
    `, [
      intent.user_id, intent.gym_id,
      `Tu membresía "${intent.type_name}" ha sido activada exitosamente. Válida hasta ${endDate.toLocaleDateString('es-EC')}.`
    ]);

    res.json({
      success: true,
      message: '¡Pago aprobado! Tu membresía ha sido renovada.',
      membership: {
        typeName: intent.type_name,
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0]
      },
      transaction: {
        id: payphoneData.transactionId,
        authorizationCode: payphoneData.authorizationCode,
        cardBrand: payphoneData.cardBrand,
        lastDigits: payphoneData.lastDigits
      }
    });

  } catch (err) {
    console.error('Error payphone confirmPayment:', err);
    res.status(500).json({ error: 'Error interno al confirmar pago' });
  }
};

// ============================================================
// GET /api/usuario/payment-result
// URL de respuesta pública (sin auth) a donde PayPhone redirige al usuario
// El frontend en esta ruta llama a /confirm con los parámetros de la URL
// ============================================================
const paymentResult = async (req, res) => {
  // Solo devuelve los parámetros recibidos para que el frontend los procese
  const { id, clientTransactionId } = req.query;
  res.json({ id, clientTransactionId });
};

// ============================================================
// POST /api/usuario/payphone/consent — firmar contrato cobro automático
// ============================================================
const signConsent = async (req, res) => {
  try {
    await db.query(
      'UPDATE users SET payphone_consent_signed = TRUE, payphone_consent_date = NOW() WHERE id = $1',
      [req.user.id]
    );
    res.json({ message: 'Consentimiento firmado exitosamente' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// ============================================================
// GET /api/usuario/payphone/auto-charge — estado del cobro automático
// ============================================================
const getAutoChargeStatus = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT payphone_token, payphone_token_date, payphone_consent_signed, payphone_consent_date
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    const u = result.rows[0];

    const payments = await db.query(`
      SELECT p.amount, p.created_at, mt.name as membership_name, p.status
      FROM payments p
      LEFT JOIN membership_types mt ON mt.id = p.membership_type_id
      WHERE p.user_id = $1 AND p.gym_id = $2 AND p.method = 'payphone'
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

// ============================================================
// DELETE /api/usuario/payphone/auto-charge — cancelar cobro automático
// ============================================================
const cancelAutoCharge = async (req, res) => {
  try {
    await db.query(
      'UPDATE users SET payphone_token = NULL, payphone_consent_signed = FALSE WHERE id = $1',
      [req.user.id]
    );
    await db.query(
      "UPDATE memberships SET auto_renew = FALSE WHERE user_id = $1 AND gym_id = $2 AND status = 'active'",
      [req.user.id, req.gym.id]
    );
    res.json({ message: 'Cobro automático cancelado' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// ============================================================
// POST /api/admin/settings/payphone — guardar credenciales PayPhone del gym
// ============================================================
const saveGymPayphoneCredentials = async (req, res) => {
  try {
    const gymId = req.gym.id;
    const { storeId, token } = req.body;

    if (!storeId || !token) {
      return res.status(400).json({ error: 'StoreId y Token son requeridos' });
    }

    await db.query(
      'UPDATE gyms SET payphone_store_id = $1, payphone_token = $2, updated_at = NOW() WHERE id = $3',
      [storeId, token, gymId]
    );

    res.json({ message: 'Credenciales guardadas exitosamente' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

module.exports = {
  initPayment, confirmPayment, paymentResult,
  signConsent, getAutoChargeStatus, cancelAutoCharge,
  saveGymPayphoneCredentials
};
