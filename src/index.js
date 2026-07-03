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
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:5173',
    /\.vercel\.app$/,
    /gymvip/
  ],
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 200,
  message: { error: 'Demasiadas solicitudes, intenta más tarde' }
});
app.use('/api/', limiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados intentos de login' }
});
app.use('/api/auth/login', loginLimiter);
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
// CRON JOBS
// ============================================================

// Expirar membresías todos los días a medianoche
cron.schedule('0 0 * * *', async () => {
  try {
    await db.query('SELECT expire_memberships()');
    console.log('[CRON] Membresías expiradas actualizadas');
  } catch (err) {
    console.error('[CRON] Error al expirar membresías:', err);
  }
});

// Pre-generar instancias de clases para los próximos 7 días (todos los días a las 01:00)
cron.schedule('0 1 * * *', async () => {
  try {
    const gyms = await db.query('SELECT id FROM gyms WHERE is_active = TRUE');
    for (const gym of gyms.rows) {
      for (let i = 0; i <= 7; i++) {
        const date = new Date();
        date.setDate(date.getDate() + i);
        const dateStr = date.toISOString().split('T')[0];
        await db.query('SELECT generate_class_instances_for_date($1, $2)', [gym.id, dateStr]);
      }
    }
    console.log('[CRON] Instancias de clases generadas para próximos 7 días');
  } catch (err) {
    console.error('[CRON] Error generando instancias de clases:', err);
  }
});

// Notificar membresías por vencer (cada día a las 09:00)
cron.schedule('0 9 * * *', async () => {
  try {
    const expiring = await db.query(`
      SELECT m.user_id, m.gym_id, mt.name as type_name,
             (m.end_date - CURRENT_DATE) as days_remaining
      FROM memberships m
      JOIN membership_types mt ON mt.id = m.membership_type_id
      WHERE m.status = 'active'
        AND m.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '3 days'
    `);

    for (const mem of expiring.rows) {
      await db.query(`
        INSERT INTO notifications (user_id, gym_id, title, message, type)
        VALUES ($1, $2, 'Membresía por vencer', $3, 'membership')
        ON CONFLICT DO NOTHING
      `, [
        mem.user_id, mem.gym_id,
        `Tu membresía "${mem.type_name}" vence en ${mem.days_remaining} día(s). ¡Renuévala para seguir entrenando!`
      ]);
    }
    console.log(`[CRON] ${expiring.rows.length} notificaciones de membresía enviadas`);
  } catch (err) {
    console.error('[CRON] Error en notificaciones de membresía:', err);
  }
});

// Cobro recurrente PayPhone — todos los días a las 8am
cron.schedule('0 8 * * *', async () => {
  console.log('[CRON] Ejecutando cobros recurrentes PayPhone...');
  const { processRecurringPayments } = require('./controllers/payphone.controller');
  await processRecurringPayments();
});

// Expirar payment_intents pendientes cada 15 minutos
cron.schedule('*/15 * * * *', async () => {
  try {
    await db.query('SELECT expire_payment_intents()');
  } catch (err) {
    console.error('[CRON] Error expirando payment_intents:', err);
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
