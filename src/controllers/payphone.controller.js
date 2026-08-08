const axios = require('axios');
const db = require('../config/database');
const { encrypt, decrypt } = require('../utils/crypto');
const { renderContrato, calcularPenalidad, redondear, sumarMeses } = require('../utils/contrato');
const { registrarRetiro } = require('../utils/compromiso');

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
      // Si el plan exige permanencia, se arma el contrato para mostrárselo
      // ANTES de firmar. Es el mismo texto que quedará guardado.
      const meses = parseInt(plan.commitment_months || 0);
      let commitment = null;
      if (meses > 0) {
        const desc = parseFloat(plan.recurring_discount || 0);
        const precioMensual = redondear(
          desc > 0 ? plan.price * (1 - desc / 100) : plan.price
        );
        const tz = req.gym?.timezone || 'America/Guayaquil';
        const hoyQ = await db.query('SELECT (NOW() AT TIME ZONE $1)::date::text AS d', [tz]);
        const inicio = hoyQ.rows[0].d;
        const fin = sumarMeses(inicio, meses);
        const penaltyPercent = parseFloat(plan.penalty_percent || 0);

        const { version, texto } = renderContrato({
          gymName: req.gym?.name, planName: plan.name,
          precioMensual, precioLista: plan.price, meses,
          penaltyPercent, penaltyRenews: plan.penalty_renews === true,
          fechaInicio: inicio, fechaFin: fin, timezone: tz,
        });

        commitment = {
          months: meses,
          penaltyPercent,
          penaltyRenews: plan.penalty_renews === true,
          monthlyPrice: precioMensual,
          startDate: inicio,
          endDate: fin,
          // Ejemplo concreto: penalidad si se retirara a mitad del plazo
          penaltyExample: {
            monthsIn: Math.max(1, Math.round(meses / 2)),
            amount: calcularPenalidad({
              mesesRestantes: meses - Math.max(1, Math.round(meses / 2)),
              precioMensual, penaltyPercent,
            }),
          },
          contractVersion: version,
          contractText: texto,
        };
      }

      return res.json({
        plan: {
          name: plan.name,
          price: plan.price,
          durationValue: plan.duration_value,
          durationUnit: plan.duration_unit,
          recurringDiscount: parseFloat(plan.recurring_discount || 0),
          lostDiscount: false // se conserva por compatibilidad; ya no se penaliza
        },
        commitment
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

    // El precio final debe calcularse ANTES de guardar la intención: el pago
    // que se registra al confirmar toma su monto de aquí. Si se guardara el
    // precio de lista, el historial diría $49.99 aunque se cobraran $34.99.
    const recurringDiscount = parseFloat(plan.recurring_discount || 0);
    const wantsRecurring = req.query.recurring === 'true';

    // El descuento depende solo de elegir débito recurrente. Un cobro fallido
    // ya no lo hace perder: el contrato (cláusula 6) promete que un rechazo
    // ajeno a su voluntad no se penaliza, y el freno ahora es la penalidad
    // por retiro anticipado, que el socio firmó expresamente.
    const applyDiscount = wantsRecurring && recurringDiscount > 0;
    const finalPrice = applyDiscount
      ? plan.price * (1 - recurringDiscount / 100)
      : plan.price;
    // El amount en PayPhone va en centavos (enteros)
    const amountCents = Math.round(finalPrice * 100);

    // Guardar la intención de pago (con el monto realmente a cobrar)
    await db.query(`
      INSERT INTO payment_intents (client_transaction_id, user_id, gym_id, membership_type_id, amount, status)
      VALUES ($1, $2, $3, $4, $5, 'pending')
      ON CONFLICT (client_transaction_id) DO NOTHING
    `, [clientTransactionId, userId, gymId, membershipTypeId, (amountCents / 100).toFixed(2)]);

    // Devolver parámetros al frontend para renderizar la cajita
    res.json({
      token: decrypt(gym.payphone_token),
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
              mt.price as list_price, mt.commitment_months, mt.penalty_percent, mt.penalty_renews,
              g.name as gym_name, g.timezone as gym_timezone,
              g.payphone_token, g.payphone_enabled
       FROM payment_intents pi
       LEFT JOIN membership_types mt ON mt.id = pi.membership_type_id
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
            'Authorization': `Bearer ${decrypt(intent.payphone_token)}`,
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

    // Idempotencia: si este pago ya fue procesado, no duplicar
const existingPayment = await db.query(
  `SELECT m.id as membership_id FROM payments p
   JOIN memberships m ON m.id = p.membership_id
   WHERE p.payphone_transaction_id = $1 LIMIT 1`,
  [payphoneData.transactionId?.toString()]
);

if (existingPayment.rows.length) {
  return res.json({
    success: true,
    message: 'Este pago ya fue procesado anteriormente.',
    alreadyProcessed: true
  });
}

    // ---- Pago de una PENALIDAD (no de una membresía) ----
    if (intent.penalty_id) {
      const cobrado = Number(payphoneData.amount);
      const monto = Number.isFinite(cobrado) && cobrado > 0
        ? (cobrado / 100).toFixed(2)
        : intent.amount;

      const pago = await db.query(`
        INSERT INTO payments (gym_id, user_id, amount, method, status, payphone_transaction_id, payphone_response, notes)
        VALUES ($1, $2, $3, 'payphone', 'pagado', $4, $5, 'Penalidad por retiro anticipado')
        RETURNING id
      `, [intent.gym_id, intent.user_id, monto,
          payphoneData.transactionId?.toString(), JSON.stringify(payphoneData)]);

      await db.query(`
        UPDATE penalties SET status='paid', payment_id=$1, resolved_at=NOW()
        WHERE id=$2 AND status='pending'
      `, [pago.rows[0].id, intent.penalty_id]);

      await db.query(
        "UPDATE payment_intents SET status='completed', payphone_transaction_id=$1, updated_at=NOW() WHERE id=$2",
        [payphoneData.transactionId?.toString(), intent.id]
      );

      await db.query(`
        INSERT INTO notifications (user_id, gym_id, title, message, type)
        VALUES ($1, $2, '✅ Penalidad pagada', $3, 'payment')
      `, [intent.user_id, intent.gym_id,
          `Tu penalidad de $${Number(monto).toFixed(2)} fue pagada. Ya puedes volver a usar la app y adquirir membresías.`]);

      return res.json({
        success: true,
        penaltyPaid: true,
        amount: parseFloat(monto),
        message: 'Penalidad pagada. Ya puedes volver a usar la aplicación.',
      });
    }

    // PAGO APROBADO — Activar membresía (fecha según timezone del gym)
    const tz = req.gym?.timezone || 'America/Guayaquil';
    const tzDate = await db.query(`SELECT (NOW() AT TIME ZONE $1)::date as today`, [tz]);
    const todayStr = tzDate.rows[0].today.toISOString().split('T')[0];

    const [ty, tm, td] = todayStr.split('-').map(Number);
    const endDate = new Date(Date.UTC(ty, tm - 1, td));
    const { duration_value, duration_unit } = intent;

    if (duration_unit === 'days') endDate.setUTCDate(endDate.getUTCDate() + duration_value);
    else if (duration_unit === 'weeks') endDate.setUTCDate(endDate.getUTCDate() + duration_value * 7);
    else if (duration_unit === 'months') endDate.setUTCMonth(endDate.getUTCMonth() + duration_value);
    else if (duration_unit === 'years') endDate.setUTCFullYear(endDate.getUTCFullYear() + duration_value);

    const startStr = todayStr;

    // Crear membresía
   // Verificar si el usuario tiene consentimiento firmado para auto_renew
const userConsent = await db.query(
  'SELECT payphone_consent_signed FROM users WHERE id = $1',
  [intent.user_id]
);

// Guardar cardToken si viene (para cobro automático futuro)
   const cardToken = req.body.ctoken || payphoneData.cardToken || payphoneData.ctoken;

const autoRenew = userConsent.rows[0]?.payphone_consent_signed && !!cardToken;

// Expirar membresías activas anteriores del usuario (evita duplicados activos)
await db.query(`
  UPDATE memberships SET status = 'expired'
  WHERE user_id = $1 AND gym_id = $2 AND status = 'active'
`, [intent.user_id, intent.gym_id]);

const memResult = await db.query(`
  INSERT INTO memberships (user_id, gym_id, membership_type_id, start_date, end_date, status, auto_renew)
  VALUES ($1, $2, $3, $4, $5, 'active', $6)
  RETURNING id
`, [
  intent.user_id, intent.gym_id, intent.membership_type_id,
  startStr,
  endDate.toISOString().split('T')[0],
  autoRenew
]);

    // Registrar pago — el monto se toma de la respuesta de PayPhone (viene en
    // centavos), que es la fuente de verdad de lo que realmente se cobró.
    // Si por algún motivo no viniera, se usa el monto de la intención.
    const cobradoPayphone = Number(payphoneData.amount);
    const montoReal = Number.isFinite(cobradoPayphone) && cobradoPayphone > 0
      ? (cobradoPayphone / 100).toFixed(2)
      : intent.amount;

    await db.query(`
      INSERT INTO payments (gym_id, user_id, membership_id, membership_type_id, amount, method, status, payphone_transaction_id, payphone_response)
      VALUES ($1, $2, $3, $4, $5, 'payphone', 'pagado', $6, $7)
    `, [
      intent.gym_id, intent.user_id, memResult.rows[0].id, intent.membership_type_id,
      montoReal, payphoneData.transactionId?.toString(), JSON.stringify(payphoneData)
    ]);

if (cardToken) {
  await db.query(
    'UPDATE users SET payphone_token = $1, payphone_token_date = NOW() WHERE id = $2',
    [encrypt(cardToken), intent.user_id]
  );
}

// ---- Compromiso de permanencia ----
// Se crea solo si el socio activó el débito automático y el plan exige
// permanencia. Los términos quedan CONGELADOS: si el gimnasio cambia el
// porcentaje o los meses después, a este socio se le respeta lo que firmó.
const mesesCompromiso = parseInt(intent.commitment_months || 0);
if (autoRenew && mesesCompromiso > 0) {
  const yaTiene = await db.query(
    `SELECT id FROM membership_commitments
     WHERE user_id = $1 AND gym_id = $2 AND status = 'active'`,
    [intent.user_id, intent.gym_id]
  );

  if (!yaTiene.rows.length) {
    const finCompromiso = sumarMeses(startStr, mesesCompromiso);
    const penaltyPercent = parseFloat(intent.penalty_percent || 0);
    const datosFirma = await db.query(
      'SELECT consent_signature_url, consent_ip, consent_version FROM users WHERE id = $1',
      [intent.user_id]
    );
    const firma = datosFirma.rows[0] || {};

    // El texto se genera en el servidor (no lo envía el cliente) para que el
    // contrato guardado sea exactamente el que corresponde a estos términos.
    const { version, texto } = renderContrato({
      gymName: intent.gym_name,
      planName: intent.type_name,
      precioMensual: montoReal,
      precioLista: intent.list_price,
      meses: mesesCompromiso,
      penaltyPercent,
      penaltyRenews: intent.penalty_renews === true,
      fechaInicio: startStr,
      fechaFin: finCompromiso,
      timezone: intent.gym_timezone,
    });

    await db.query(`
      INSERT INTO membership_commitments (
        user_id, gym_id, membership_id, membership_type_id,
        commitment_months, monthly_price, list_price, penalty_percent, penalty_renews,
        contract_version, contract_text, signature_url, signed_ip,
        start_date, end_date, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'active')
    `, [
      intent.user_id, intent.gym_id, memResult.rows[0].id, intent.membership_type_id,
      mesesCompromiso, montoReal, intent.list_price, penaltyPercent, intent.penalty_renews === true,
      firma.consent_version || version, texto, firma.consent_signature_url || null, firma.consent_ip || null,
      startStr, finCompromiso,
    ]);

    await db.query(`
      INSERT INTO notifications (user_id, gym_id, title, message, type)
      VALUES ($1, $2, 'Compromiso activado', $3, 'membership')
    `, [intent.user_id, intent.gym_id,
        `Tu plan con débito automático quedó activo por ${mesesCompromiso} meses a $${Number(montoReal).toFixed(2)} mensuales.`]);
  }
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
        startDate: startStr,
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
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() 
      || req.socket?.remoteAddress 
      || 'unknown';
    const consentVersion = 'v1.0';
    const { signature } = req.body;

    let signatureUrl = null;
    if (signature && signature.startsWith('data:image')) {
      try {
        const { uploadSignature } = require('../config/cloudinary');
        signatureUrl = await uploadSignature(signature, req.user.id);
      } catch (e) {
        console.error('Error subiendo firma:', e.message);
      }
    }

    await db.query(`
      UPDATE users SET 
        payphone_consent_signed = TRUE, 
        payphone_consent_date = NOW(),
        consent_ip = $1,
        consent_date = NOW(),
        consent_version = $2,
        consent_signature_url = COALESCE($3, consent_signature_url)
      WHERE id = $4
    `, [ip, consentVersion, signatureUrl, req.user.id]);

    res.json({ message: 'Consentimiento firmado exitosamente' });
  } catch (err) {
    console.error('Error signConsent:', err.message);
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
// ============================================================
// GET /api/usuario/penalty/init — pagar la penalidad desde la app
// ============================================================
// Reutiliza la cajita de PayPhone, pero la intención apunta a la penalidad
// en vez de a un plan de membresía.
const initPenaltyPayment = async (req, res) => {
  try {
    const userId = req.user.id;
    const gymId = req.gym.id;

    const deudaR = await db.query(
      "SELECT * FROM penalties WHERE user_id=$1 AND gym_id=$2 AND status='pending' ORDER BY created_at DESC LIMIT 1",
      [userId, gymId]
    );
    if (!deudaR.rows.length) return res.status(404).json({ error: 'No tienes penalidades pendientes' });
    const deuda = deudaR.rows[0];

    const gymR = await db.query(
      'SELECT name, payphone_enabled, payphone_store_id, payphone_token FROM gyms WHERE id = $1',
      [gymId]
    );
    const gym = gymR.rows[0];
    if (!gym.payphone_enabled || !gym.payphone_token || !gym.payphone_store_id) {
      return res.status(400).json({ error: 'Este gimnasio no tiene pagos en línea habilitados. Acércate a recepción para cancelar tu penalidad.' });
    }

    const clientTransactionId = `PEN-${userId.substring(0, 8)}-${Date.now()}`;
    const amountCents = Math.round(parseFloat(deuda.amount) * 100);

    await db.query(`
      INSERT INTO payment_intents (client_transaction_id, user_id, gym_id, penalty_id, amount, status)
      VALUES ($1, $2, $3, $4, $5, 'pending')
      ON CONFLICT (client_transaction_id) DO NOTHING
    `, [clientTransactionId, userId, gymId, deuda.id, deuda.amount]);

    res.json({
      token: decrypt(gym.payphone_token),
      storeId: gym.payphone_store_id,
      clientTransactionId,
      amount: amountCents,
      amountWithoutTax: amountCents,
      currency: 'USD',
      reference: `Penalidad por retiro anticipado - ${gym.name}`,
      lang: 'es',
      timeZone: -5,
      phoneNumber: req.user.phone ? `+593${req.user.phone.replace(/^0/, '')}` : undefined,
      email: req.user.email || undefined,
      documentId: req.user.cedula,
      identificationType: 1,
      penalty: { id: deuda.id, amount: parseFloat(deuda.amount) },
    });
  } catch (err) {
    console.error('Error initPenaltyPayment:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

const cancelAutoCharge = async (req, res) => {
  try {
    // Si tenía compromiso vigente, se genera la penalidad antes de dar de baja
    const deuda = await registrarRetiro(req.user.id, req.gym.id);

    await db.query(
      'UPDATE users SET payphone_token = NULL, payphone_consent_signed = FALSE WHERE id = $1',
      [req.user.id]
    );
    await db.query(
      "UPDATE memberships SET auto_renew = FALSE WHERE user_id = $1 AND gym_id = $2 AND status = 'active'",
      [req.user.id, req.gym.id]
    );
    res.json({
      message: 'Cobro automático cancelado',
      penalty: deuda ? { amount: parseFloat(deuda.amount), id: deuda.id } : null,
    });
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

    // Cifrar el token antes de guardar
    const encryptedToken = encrypt(token);

    await db.query(
      'UPDATE gyms SET payphone_store_id = $1, payphone_token = $2, payphone_coding_password = $3, updated_at = NOW() WHERE id = $4',
      [storeId, encryptedToken, codingPassword || null, gymId]
    );

    res.json({ message: 'Credenciales guardadas exitosamente' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// ============================================================
// COBRO RECURRENTE — se ejecuta desde el cron job
// ============================================================
// gymId opcional: el cron lo invoca por cada box a las 08:00 de SU hora local,
// con la zona horaria del box aplicada (así CURRENT_DATE es su "hoy" real).
const processRecurringPayments = async (gymId = null) => {
  const crypto = require('crypto');
  
 try {
    // Buscar membresías que vencen hoy O que fallaron antes (hasta 3 intentos, dentro de 3 días de gracia)
    const memberships = await db.query(`
      SELECT 
        m.id as membership_id, m.user_id, m.gym_id, m.membership_type_id,
        mt.price, mt.name as type_name, mt.duration_value, mt.duration_unit,
        mt.recurring_discount,
        u.payphone_token as card_token, u.email, u.phone, u.cedula, u.name as user_name,
        u.payphone_consent_signed,
        g.payphone_token as gym_token, g.payphone_store_id, g.payphone_coding_password,
        m.recurring_failed_attempts, m.end_date
      FROM memberships m
      JOIN membership_types mt ON mt.id = m.membership_type_id
      JOIN users u ON u.id = m.user_id
      JOIN gyms g ON g.id = m.gym_id
      WHERE m.auto_renew = TRUE
        -- Se incluyen las vencidas: tras el primer cobro fallido, a medianoche
        -- expire_memberships() marca la membresía como 'expired'. Si solo se
        -- buscaran las activas, los reintentos de los días 2 y 3 nunca correrían.
        -- No hay riesgo de cobrar dos veces: last_charge_attempt limita a un
        -- intento por día y un cobro exitoso pone auto_renew = FALSE.
        AND m.status IN ('active', 'expired')
        AND m.end_date <= CURRENT_DATE
        AND m.end_date >= CURRENT_DATE - INTERVAL '3 days'
        AND m.recurring_failed_attempts < 3
        AND (m.last_charge_attempt IS NULL OR m.last_charge_attempt < CURRENT_DATE)
        AND u.payphone_token IS NOT NULL
        AND u.payphone_consent_signed = TRUE
        AND g.payphone_enabled = TRUE
        AND g.payphone_token IS NOT NULL
        AND g.payphone_coding_password IS NOT NULL
        AND ($1::uuid IS NULL OR m.gym_id = $1)
    `, [gymId]);

    console.log(`[CRON] Procesando ${memberships.rows.length} cobros recurrentes`);

    for (const mem of memberships.rows) {
      try {
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

        // El descuento por débito recurrente debe aplicarse en CADA cobro, igual
        // que en el pago inicial: al usuario se le prometió ese precio "cada vez".
        // El descuento se mantiene siempre mientras el débito siga activo.
        const recurringDiscount = parseFloat(mem.recurring_discount || 0);
        const applyDiscount = recurringDiscount > 0;
        const finalPrice = applyDiscount
          ? parseFloat(mem.price) * (1 - recurringDiscount / 100)
          : parseFloat(mem.price);
        const amountCents = Math.round(finalPrice * 100);

        // Cobrar con cardToken
       const encryptedHolder = encryptCardHolder(mem.user_name, mem.payphone_coding_password);
// Descifrar tokens antes de usarlos
    const gymTokenPlain = decrypt(mem.gym_token);
    const cardTokenPlain = decrypt(mem.card_token);

  
const payphoneRes = await axios.post(
  'https://pay.payphonetodoesposible.com/api/transaction/web',
  {
    amount: amountCents,
    amountWithoutTax: amountCents,
    currency: 'USD',
    clientTransactionId,
    storeId: mem.payphone_store_id,
    reference: `Renovación ${mem.type_name}`,
    cardToken: cardTokenPlain,
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
                lastName: mem.user_name.split(' ').slice(1).join(' ') || mem.user_name.split(' ')[0] || 'N/A',
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
      'Authorization': `Bearer ${gymTokenPlain}`,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  }
);
        

        const data = payphoneRes.data;

        if ((data.transactionStatus === 'Approved' || data.status === 'Approved') && data.statusCode === 3) {
          // Calcular nueva fecha de fin
          const startDate = new Date();
          const endDate = new Date();
          if (mem.duration_unit === 'days') endDate.setDate(endDate.getDate() + mem.duration_value);
          else if (mem.duration_unit === 'weeks') endDate.setDate(endDate.getDate() + mem.duration_value * 7);
          else if (mem.duration_unit === 'months') endDate.setMonth(endDate.getMonth() + mem.duration_value);
          else if (mem.duration_unit === 'years') endDate.setFullYear(endDate.getFullYear() + mem.duration_value);

          // Marcar la membresía vencida como renovada (evita reintentos)
          await db.query(`UPDATE memberships SET status = 'expired', auto_renew = FALSE WHERE id = $1`, [mem.membership_id]);

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
              finalPrice.toFixed(2), data.transactionId?.toString()]);

          await db.query(`
            INSERT INTO notifications (user_id, gym_id, title, message, type)
            VALUES ($1, $2, '✅ Membresía renovada', $3, 'payment')
          `, [mem.user_id, mem.gym_id,
              `Tu membresía "${mem.type_name}" se renovó automáticamente. Válida hasta ${endDate.toLocaleDateString('es-EC')}.`]);

          console.log(`[CRON] ✅ Cobro exitoso para usuario ${mem.user_id}`);
        } else {
          // Cobro fallido — incrementar contador
          const newAttempts = (mem.recurring_failed_attempts || 0) + 1;
          const cancelAutoRenew = newAttempts >= 3;

          await db.query(`
            UPDATE memberships SET 
              recurring_failed_attempts = $1,
              last_charge_attempt = CURRENT_DATE,
              auto_renew = CASE WHEN $2 THEN FALSE ELSE auto_renew END
            WHERE id = $3
          `, [newAttempts, cancelAutoRenew, mem.membership_id]);

          if (cancelAutoRenew) {
            // Un cobro fallido NO es un retiro voluntario: no se genera penalidad
            // ni se le quita el descuento (así lo promete la cláusula 6 del contrato).
            // El compromiso queda "en revisión" para que recepción contacte al socio.
            await db.query(`
              UPDATE membership_commitments SET status = 'payment_failed'
              WHERE user_id = $1 AND gym_id = $2 AND status = 'active'
            `, [mem.user_id, mem.gym_id]);
          }

          const msg = cancelAutoRenew
            ? `No pudimos renovar tu membresía "${mem.type_name}" tras 3 intentos. El cobro automático se desactivó. Por favor paga manualmente desde la app.`
            : `Intento ${newAttempts} de 3 fallido para renovar "${mem.type_name}". Lo intentaremos de nuevo mañana. Puedes pagar manualmente cuando quieras.`;

          await db.query(`
            INSERT INTO notifications (user_id, gym_id, title, message, type)
            VALUES ($1, $2, '⚠️ Error en renovación automática', $3, 'payment')
          `, [mem.user_id, mem.gym_id, msg]);

          console.log(`[CRON] ❌ Cobro fallido (intento ${newAttempts}) para usuario ${mem.user_id}`);
        }
      } catch (err) {
        console.error(`[CRON] Error procesando cobro para usuario ${mem.user_id}:`, err.message);
console.error(`[CRON] Error PayPhone:`, err.response?.data?.message);     }
    }
  } catch (err) {
    console.error('[CRON] Error en processRecurringPayments:', err.message);
  }
};

module.exports = {
  initPayment, confirmPayment, paymentResult,
  signConsent, getAutoChargeStatus, cancelAutoCharge,
  saveGymPayphoneCredentials, processRecurringPayments,
  initPenaltyPayment
};
