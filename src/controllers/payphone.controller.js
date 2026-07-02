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
    const { membershipTypeId, infoOnly, recurring } = req.query;

    if (!membershipTypeId) {
      return res.status(400).json({ error: 'membershipTypeId requerido' });
    }

    // Si solo quiere info del plan (para mostrar opciones)
    if (infoOnly === 'true') {
      const planResult = await db.query(
        'SELECT * FROM membership_types WHERE id = $1 AND gym_id = $2 AND is_active = TRUE',
        [membershipTypeId, gymId]
      );
      if (!planResult.rows.length) return res.status(404).json({ error: 'Plan no encontrado' });
      const plan = planResult.rows[0];
      return res.json({
        plan: {
          name: plan.name,
          price: plan.price,
          durationValue: plan.duration_value,
          durationUnit: plan.duration_unit,
          recurringDiscount: parseFloat(plan.recurring_discount || 0)
        }
      });
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
    const recurringDiscount = parseFloat(plan.recurring_discount || 0);
const wantsRecurring = req.query.recurring === 'true';
const finalPrice = wantsRecurring && recurringDiscount > 0
  ? plan.price * (1 - recurringDiscount / 100)
  : plan.price;
const amountCents = Math.round(finalPrice * 100);

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
  durationUnit: plan.duration_unit,
  recurringDiscount: recurringDiscount
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
   // Verificar si el usuario tiene consentimiento firmado para auto_renew
const userConsent = await db.query(
  'SELECT payphone_consent_signed FROM users WHERE id = $1',
  [intent.user_id]
);

// Guardar cardToken si viene (para cobro automático futuro)
   const cardToken = req.body.ctoken || payphoneData.cardToken || payphoneData.ctoken;

const autoRenew = userConsent.rows[0]?.payphone_consent_signed && !!cardToken;

const memResult = await db.query(`
  INSERT INTO memberships (user_id, gym_id, membership_type_id, start_date, end_date, status, auto_renew)
  VALUES ($1, $2, $3, $4, $5, 'active', $6)
  RETURNING id
`, [
  intent.user_id, intent.gym_id, intent.membership_type_id,
  startDate.toISOString().split('T')[0],
  endDate.toISOString().split('T')[0],
  autoRenew
]);

    // Registrar pago
    await db.query(`
      INSERT INTO payments (gym_id, user_id, membership_id, membership_type_id, amount, method, status, payphone_transaction_id, payphone_response)
      VALUES ($1, $2, $3, $4, $5, 'payphone', 'pagado', $6, $7)
    `, [
      intent.gym_id, intent.user_id, memResult.rows[0].id, intent.membership_type_id,
      intent.amount, payphoneData.transactionId?.toString(), JSON.stringify(payphoneData)
    ]);

if (cardToken) {
  await db.query(
    'UPDATE users SET payphone_token = $1, payphone_token_date = NOW() WHERE id = $2',
    [cardToken, intent.user_id]
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
    const { storeId, token, codingPassword } = req.body;

    if (!storeId || !token) {
      return res.status(400).json({ error: 'StoreId y Token son requeridos' });
    }

    await db.query(
      'UPDATE gyms SET payphone_store_id = $1, payphone_token = $2, payphone_coding_password = $3, updated_at = NOW() WHERE id = $4',
      [storeId, token, codingPassword || null, gymId]
    );

    res.json({ message: 'Credenciales guardadas exitosamente' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// ============================================================
// COBRO RECURRENTE — se ejecuta desde el cron job
// ============================================================
const processRecurringPayments = async () => {
  const crypto = require('crypto');
  
  try {
    // Buscar membresías que vencen hoy con cobro automático activo
    const memberships = await db.query(`
      SELECT 
        m.id as membership_id, m.user_id, m.gym_id, m.membership_type_id,
        mt.price, mt.name as type_name, mt.duration_value, mt.duration_unit,
        u.payphone_token as card_token, u.email, u.phone, u.cedula, u.name as user_name,
        u.payphone_consent_signed,
        g.payphone_token as gym_token, g.payphone_store_id, g.payphone_coding_password
      FROM memberships m
      JOIN membership_types mt ON mt.id = m.membership_type_id
      JOIN users u ON u.id = m.user_id
      JOIN gyms g ON g.id = m.gym_id
      WHERE m.auto_renew = TRUE
        AND m.status = 'active'
        AND m.end_date = CURRENT_DATE
        AND u.payphone_token IS NOT NULL
        AND u.payphone_consent_signed = TRUE
        AND g.payphone_enabled = TRUE
        AND g.payphone_token IS NOT NULL
        AND g.payphone_coding_password IS NOT NULL
    `);

    console.log(`[CRON] Procesando ${memberships.rows.length} cobros recurrentes`);

    for (const mem of memberships.rows) {
      try {
        console.log('[CRON] Enviando cardHolder:', mem.user_name);
console.log('[CRON] codingPassword disponible:', !!mem.payphone_coding_password);
        // Encriptar nombre del titular con AES-256-CBC
        const encryptCardHolder = (name, password) => {
  const key = Buffer.alloc(32);
  Buffer.from(password, 'utf8').copy(key);
  const iv = Buffer.alloc(16); // IV vacío (ceros)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(name, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return encrypted;
};

        const clientTransactionId = `REC-${mem.user_id.substring(0,8)}-${Date.now()}`;
        const amountCents = Math.round(parseFloat(mem.price) * 100);

        // Cobrar con cardToken
       const encryptedHolder = encryptCardHolder(mem.user_name, mem.payphone_coding_password);
console.log('[CRON] cardHolder encriptado:', encryptedHolder?.substring(0, 30));

const payphoneRes = await axios.post(
  'https://pay.payphonetodoesposible.com/api/transaction/web',
  {
    amount: amountCents,
    amountWithoutTax: amountCents,
    currency: 'USD',
    clientTransactionId,
    storeId: mem.payphone_store_id,
    reference: `Renovación ${mem.type_name}`,
    cardToken: mem.card_token,
    cardHolder: encryptedHolder,
    email: mem.email,
    phoneNumber: mem.phone ? `+593${mem.phone.replace(/^0/, '')}` : undefined,
    documentId: mem.cedula,
            identificationType: 1,
            order: {
              billTo: {
                address1: 'Ecuador',
                address2: '',
                country: 'EC',
                state: 'Guayas',
                locality: 'Guayaquil',
                firstName: mem.user_name.split(' ')[0] || mem.user_name,
                lastName: mem.user_name.split(' ')[1] || '',
                phoneNumber: mem.phone ? `+593${mem.phone.replace(/^0/, '')}` : '+593000000000',
                email: mem.email || '',
                postalCode: '090101',
                ipAddress: '127.0.0.1'
              },
              lineItems: [{
                productName: `Membresía ${mem.type_name}`,
                unitPrice: amountCents,
                quantity: 1,
                totalAmount: amountCents,
                taxAmount: 0,
                productSKU: `MEM-${mem.membership_type_id.substring(0, 8)}`,
                productDescription: `Renovación automática membresía ${mem.type_name}`
              }]
            },
          },
  {
    headers: {
      'Authorization': `Bearer ${mem.gym_token}`,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  }
);
        

        const data = payphoneRes.data;

        if (data.transactionStatus === 'Approved' && data.statusCode === 3) {
          // Calcular nueva fecha de fin
          const startDate = new Date();
          const endDate = new Date();
          if (mem.duration_unit === 'days') endDate.setDate(endDate.getDate() + mem.duration_value);
          else if (mem.duration_unit === 'weeks') endDate.setDate(endDate.getDate() + mem.duration_value * 7);
          else if (mem.duration_unit === 'months') endDate.setMonth(endDate.getMonth() + mem.duration_value);
          else if (mem.duration_unit === 'years') endDate.setFullYear(endDate.getFullYear() + mem.duration_value);

          // Crear nueva membresía
          const newMem = await db.query(`
            INSERT INTO memberships (user_id, gym_id, membership_type_id, start_date, end_date, status, auto_renew)
            VALUES ($1, $2, $3, $4, $5, 'active', TRUE) RETURNING id
          `, [mem.user_id, mem.gym_id, mem.membership_type_id,
              startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0]]);

          // Registrar pago
          await db.query(`
            INSERT INTO payments (gym_id, user_id, membership_id, membership_type_id, amount, method, status, payphone_transaction_id)
            VALUES ($1, $2, $3, $4, $5, 'payphone', 'pagado', $6)
          `, [mem.gym_id, mem.user_id, newMem.rows[0].id, mem.membership_type_id,
              mem.price, data.transactionId?.toString()]);

          // Notificación
          await db.query(`
            INSERT INTO notifications (user_id, gym_id, title, message, type)
            VALUES ($1, $2, '✅ Membresía renovada', $3, 'payment')
          `, [mem.user_id, mem.gym_id,
              `Tu membresía "${mem.type_name}" se renovó automáticamente. Válida hasta ${endDate.toLocaleDateString('es-EC')}.`]);

          console.log(`[CRON] ✅ Cobro exitoso para usuario ${mem.user_id}`);
        } else {
          // Cobro fallido — notificar al usuario
          await db.query(`
            INSERT INTO notifications (user_id, gym_id, title, message, type)
            VALUES ($1, $2, '⚠️ Error en renovación automática', $3, 'payment')
          `, [mem.user_id, mem.gym_id,
              `No pudimos renovar tu membresía "${mem.type_name}" automáticamente. Por favor realiza el pago manualmente.`]);

          console.log(`[CRON] ❌ Cobro fallido para usuario ${mem.user_id}: ${data.message}`);
        }
      } catch (err) {
        console.error(`[CRON] Error procesando cobro para usuario ${mem.user_id}:`, err.message);
console.error(`[CRON] Detalle completo:`, JSON.stringify(err.response?.data, null, 2));      }
    }
  } catch (err) {
    console.error('[CRON] Error en processRecurringPayments:', err.message);
  }
};

module.exports = {
  initPayment, confirmPayment, paymentResult,
  signConsent, getAutoChargeStatus, cancelAutoCharge,
  saveGymPayphoneCredentials, processRecurringPayments
};
