require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const db = require('./config/database');
const routes = require('./routes/index');

const app = express();
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false // deshabilitado para permitir el widget de PayPhone
}));
app.set('trust proxy', 1); 
const PORT = process.env.PORT || 3001;

// ============================================================
// SEGURIDAD
// ============================================================
app.use(helmet());

// Lista de orígenes permitidos
const allowedOrigins = [
  'https://gymvip-frontend.vercel.app',  // ← CAMBIAR luego por tu dominio real de producción
  process.env.FRONTEND_URL                // dominio desde variable de entorno
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Permitir peticiones sin origin (apps móviles, Postman, health checks)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('No permitido por CORS'));
  },
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 1000,
  message: { error: 'Demasiadas solicitudes, intenta más tarde' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

// Protección contra adivinar contraseñas. Se aplica más abajo, después de
// express.json(), porque el límite por cuenta necesita leer la cédula.
//
// Dos capas:
//  - Por IP: frena escaneos masivos. Se deja holgado porque los socios de un
//    mismo gimnasio comparten la IP del WiFi y no hay que dejarlos afuera.
//  - Por cuenta: es la que realmente protege la contraseña de cada persona,
//    aunque el atacante cambie de IP.
const loginLimiterIP = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Demasiados intentos fallidos desde esta red, espera unos minutos' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true
});

const loginLimiterCuenta = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 6,
  message: { error: 'Demasiados intentos fallidos para esta cuenta. Espera 15 minutos o contacta a tu gimnasio.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `cuenta:${String(req.body?.cedula || 'sin-cedula').slice(0, 20)}`,
});
// Rate limiting para PayPhone — más estricto
const payphoneLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 10,
  message: { error: 'Demasiadas solicitudes de pago, espera un momento' }
});
app.use('/api/usuario/payphone', payphoneLimiter);

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Va aquí y no antes: el límite por cuenta necesita el cuerpo ya parseado
app.use('/api/auth/login', loginLimiterIP, loginLimiterCuenta);


// Sanitización básica — eliminar caracteres peligrosos
app.use((req, res, next) => {
  const sanitize = (obj) => {
    if (!obj) return obj;
    Object.keys(obj).forEach(key => {
      if (typeof obj[key] === 'string') {
        // Eliminar tags HTML y scripts
        obj[key] = obj[key].replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
        obj[key] = obj[key].replace(/<[^>]+>/g, '');
        obj[key] = obj[key].trim();
      } else if (typeof obj[key] === 'object') {
        sanitize(obj[key]);
      }
    });
    return obj;
  };
  req.body = sanitize(req.body);
  req.query = sanitize(req.query);
  next();
});

// ============================================================
// RUTAS
// ============================================================
app.use('/api', routes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// 404
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// Error handler global
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ============================================================
// CRON JOBS — multi-zona horaria
// ============================================================
// Cada box puede estar en un país distinto, así que las tareas diarias no
// pueden correr "a las 8 del servidor": corren CADA HORA y se ejecutan solo
// para los gimnasios donde en ese momento sea la hora local indicada.

// Hora local actual (0-23) de un gimnasio, según su zona horaria
const horaLocalDelGym = (timezone) => {
  const tz = db.isValidTimezone(timezone) ? timezone : db.DEFAULT_TZ;
  return parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date()),
    10
  );
};

// Fecha local actual (YYYY-MM-DD) de un gimnasio
const fechaLocalDelGym = (timezone) => {
  const tz = db.isValidTimezone(timezone) ? timezone : db.DEFAULT_TZ;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  return p; // en-CA ya entrega YYYY-MM-DD
};

const gimnasiosActivos = async () => {
  const r = await db.query('SELECT id, name, timezone FROM gyms WHERE is_active = TRUE');
  return r.rows;
};

// Recorre los gimnasios y ejecuta la tarea solo en los que sea `horaObjetivo`
// local, con la zona horaria del box aplicada a todas sus consultas.
const porCadaGymALaHora = async (horaObjetivo, etiqueta, tarea) => {
  let gyms;
  try { gyms = await gimnasiosActivos(); }
  catch (err) { return console.error(`[CRON] ${etiqueta}: error listando gimnasios:`, err.message); }

  for (const gym of gyms) {
    if (horaLocalDelGym(gym.timezone) !== horaObjetivo) continue;
    try {
      await db.runWithTimezone(gym.timezone, () => tarea(gym));
    } catch (err) {
      console.error(`[CRON] ${etiqueta} falló para ${gym.name}:`, err.message);
    }
  }
};

// Expirar membresías vencidas — cada hora, aplica a la medianoche local de cada box
cron.schedule('5 * * * *', async () => {
  try {
    await db.query('SELECT expire_memberships()');
  } catch (err) {
    console.error('[CRON] Error al expirar membresías:', err.message);
  }
});

// Pre-generar clases de los próximos 7 días — a la 01:00 local de cada box
cron.schedule('0 * * * *', async () => {
  await porCadaGymALaHora(1, 'generar clases', async (gym) => {
    const base = new Date(`${fechaLocalDelGym(gym.timezone)}T12:00:00Z`);
    for (let i = 0; i <= 7; i++) {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + i);
      await db.query('SELECT generate_class_instances_for_date($1, $2)', [gym.id, d.toISOString().split('T')[0]]);
    }
    console.log(`[CRON] Clases generadas (7 días) para ${gym.name}`);
  });
});

// Avisar membresías por vencer — a las 09:00 local de cada box
cron.schedule('0 * * * *', async () => {
  await porCadaGymALaHora(9, 'avisos de vencimiento', async (gym) => {
    const expiring = await db.query(`
      SELECT m.user_id, m.gym_id, mt.name as type_name,
             (m.end_date - CURRENT_DATE) as days_remaining
      FROM memberships m
      JOIN membership_types mt ON mt.id = m.membership_type_id
      WHERE m.gym_id = $1 AND m.status = 'active'
        AND m.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '3 days'
    `, [gym.id]);

    for (const mem of expiring.rows) {
      await db.query(`
        INSERT INTO notifications (user_id, gym_id, title, message, type)
        VALUES ($1, $2, 'Membresía por vencer', $3, 'membership')
        ON CONFLICT DO NOTHING
      `, [mem.user_id, mem.gym_id,
          `Tu membresía "${mem.type_name}" vence en ${mem.days_remaining} día(s). ¡Renuévala para seguir entrenando!`]);
    }
    if (expiring.rows.length) console.log(`[CRON] ${expiring.rows.length} avisos enviados en ${gym.name}`);
  });
});

// Compromisos de permanencia — a las 10:00 local de cada box
cron.schedule('0 * * * *', async () => {
  await porCadaGymALaHora(10, 'compromisos', async (gym) => {
    // 1) Cerrar los que ya cumplieron el plazo
    const cumplidos = await db.query(`
      UPDATE membership_commitments c
      SET status = 'completed', ended_at = NOW()
      WHERE c.gym_id = $1 AND c.status = 'active' AND c.end_date < CURRENT_DATE
      RETURNING c.user_id, c.penalty_renews, c.commitment_months
    `, [gym.id]);

    for (const c of cumplidos.rows) {
      // Sin renovación de penalidad no se le pregunta nada: sigue cobrándose
      // normal y puede cancelar cuando quiera. Solo se le informa.
      if (!c.penalty_renews) {
        await db.query(`
          INSERT INTO notifications (user_id, gym_id, title, message, type)
          VALUES ($1, $2, '🎉 Cumpliste tu compromiso', $3, 'membership')
        `, [c.user_id, gym.id,
            `Completaste tus ${c.commitment_months} meses de permanencia. Tu membresía sigue activa con tu precio preferencial y ya puedes cancelarla cuando quieras, sin penalidad.`]);
      }
    }

    // 2) Avisar (y recordar cada 5 días) a los que sí deben decidir
    const porVencer = await db.query(`
      SELECT c.id, c.user_id, c.commitment_months, c.end_date::text AS end_date,
             c.renewal_reminders, c.renewal_asked_at
      FROM membership_commitments c
      WHERE c.gym_id = $1
        AND c.penalty_renews = TRUE
        AND c.renewal_answer IS NULL
        AND c.status IN ('active', 'completed')
        AND c.end_date <= CURRENT_DATE + INTERVAL '15 days'
        AND (c.renewal_asked_at IS NULL OR c.renewal_asked_at < NOW() - INTERVAL '5 days')
        AND EXISTS (SELECT 1 FROM memberships m
                    WHERE m.user_id = c.user_id AND m.gym_id = c.gym_id AND m.auto_renew = TRUE)
    `, [gym.id]);

    for (const c of porVencer.rows) {
      const primeraVez = !c.renewal_asked_at;
      await db.query(`
        UPDATE membership_commitments
        SET renewal_asked_at = NOW(), renewal_reminders = COALESCE(renewal_reminders,0) + 1
        WHERE id = $1
      `, [c.id]);

      await db.query(`
        INSERT INTO notifications (user_id, gym_id, title, message, type)
        VALUES ($1, $2, $3, $4, 'membership')
      `, [c.user_id, gym.id,
          primeraVez ? 'Tu compromiso está por terminar' : 'Recordatorio: decide sobre tu compromiso',
          `Tu compromiso de ${c.commitment_months} meses termina el ${c.end_date}. Entra a la app para decidir si deseas continuar. Mientras tanto tu membresía sigue cobrándose normal, sin nueva permanencia.`]);
    }

    if (cumplidos.rows.length || porVencer.rows.length) {
      console.log(`[CRON] ${gym.name}: ${cumplidos.rows.length} compromisos cumplidos, ${porVencer.rows.length} avisos de renovación`);
    }
  });
});

// Cobro recurrente PayPhone — a las 08:00 local de cada box
cron.schedule('0 * * * *', async () => {
  const { processRecurringPayments } = require('./controllers/payphone.controller');
  await porCadaGymALaHora(8, 'cobro recurrente', async (gym) => {
    console.log(`[CRON] Cobros recurrentes — ${gym.name} (${gym.timezone})`);
    await processRecurringPayments(gym.id);
  });
});

// Expirar intenciones de pago pendientes — cada 15 minutos (no depende de zona)
cron.schedule('*/15 * * * *', async () => {
  try {
    await db.query('SELECT expire_payment_intents()');
  } catch (err) {
    console.error('[CRON] Error expirando payment_intents:', err.message);
  }
});

// ============================================================
async function startServer() {
  try {
    // Verificar conexión a BD
    await db.query('SELECT 1');
    console.log('✅ Conexión a PostgreSQL establecida');

    app.listen(PORT, () => {
      console.log(`🚀 GymVIP API corriendo en http://localhost:${PORT}`);
      console.log(`📊 Ambiente: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (err) {
    console.error('❌ No se pudo conectar a PostgreSQL:', err.message);
    process.exit(1);
  }
}

startServer();

module.exports = app;
