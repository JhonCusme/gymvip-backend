-- ============================================================
-- MIGRACIÓN: Sincronizar esquema con el código actual
-- Columnas y tablas que el código usa pero faltan en gymvip-schema.sql
-- ============================================================

-- Planes SaaS (facturación de gimnasios)
CREATE TABLE IF NOT EXISTS saas_plans (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    max_users INTEGER,
    price DECIMAL(10,2) NOT NULL DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO saas_plans (name, max_users, price, sort_order)
SELECT * FROM (VALUES
    ('Básico', 50, 25.00, 1),
    ('Pro', 150, 45.00, 2),
    ('Premium', 400, 75.00, 3),
    ('Ilimitado', NULL::int, 120.00, 4)
) AS v(name, max_users, price, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM saas_plans);

-- Períodos de facturación SaaS (catálogo tomado de la BD de Railway)
CREATE TABLE IF NOT EXISTS saas_billing_periods (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(30),
    months INTEGER NOT NULL,
    discount_percent DECIMAL(5,2) DEFAULT 0,
    label VARCHAR(60),
    is_active BOOLEAN DEFAULT TRUE,
    sort_order INTEGER DEFAULT 0
);

INSERT INTO saas_billing_periods (name, months, discount_percent, label, sort_order)
SELECT * FROM (VALUES
    ('Mensual', 1, 0.00, NULL, 1),
    ('Trimestral', 3, 5.00, NULL, 2),
    ('Semestral', 6, 10.00, NULL, 3),
    ('Anual', 12, 16.67, '2 meses gratis', 4)
) AS v(name, months, discount_percent, label, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM saas_billing_periods);

-- Pagos de suscripción de cada gimnasio
CREATE TABLE IF NOT EXISTS gym_subscription_payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    amount DECIMAL(10,2) NOT NULL,
    period_start DATE,
    period_end DATE,
    notes TEXT,
    registered_by UUID REFERENCES users(id),
    months_covered INTEGER DEFAULT 1,
    paid_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gym_sub_payments_gym ON gym_subscription_payments(gym_id);

-- Récords personales de usuarios
CREATE TABLE IF NOT EXISTS user_prs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    exercise VARCHAR(100) NOT NULL,
    weight DECIMAL(10,2),
    unit VARCHAR(10) DEFAULT 'lb',
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, gym_id, exercise)
);
CREATE INDEX IF NOT EXISTS idx_user_prs_user ON user_prs(user_id);

-- Control de peso corporal de usuarios
CREATE TABLE IF NOT EXISTS user_weights (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gym_id UUID REFERENCES gyms(id) ON DELETE CASCADE,
    weight DECIMAL(6,2) NOT NULL,
    unit VARCHAR(2) NOT NULL DEFAULT 'kg',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_weights_user ON user_weights(user_id, created_at DESC);

-- Gyms: zona horaria, PayPhone y módulo SaaS
ALTER TABLE gyms ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'America/Guayaquil';
ALTER TABLE gyms ADD COLUMN IF NOT EXISTS payphone_coding_password TEXT;
ALTER TABLE gyms ADD COLUMN IF NOT EXISTS saas_plan_id UUID REFERENCES saas_plans(id);
ALTER TABLE gyms ADD COLUMN IF NOT EXISTS saas_price DECIMAL(10,2);
ALTER TABLE gyms ADD COLUMN IF NOT EXISTS saas_max_users INTEGER;
ALTER TABLE gyms ADD COLUMN IF NOT EXISTS saas_status VARCHAR(20) DEFAULT 'active';
ALTER TABLE gyms ADD COLUMN IF NOT EXISTS saas_start_date DATE;
ALTER TABLE gyms ADD COLUMN IF NOT EXISTS saas_next_payment DATE;
ALTER TABLE gyms ADD COLUMN IF NOT EXISTS saas_billing_months INTEGER DEFAULT 1;
ALTER TABLE gyms ADD COLUMN IF NOT EXISTS saas_grace_days INTEGER DEFAULT 5;

-- Instructores
ALTER TABLE instructors ADD COLUMN IF NOT EXISTS is_head_coach BOOLEAN DEFAULT FALSE;

-- Tipos de membresía
ALTER TABLE membership_types ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT TRUE;
ALTER TABLE membership_types ADD COLUMN IF NOT EXISTS recurring_discount DECIMAL(10,2) DEFAULT 0;

-- Membresías: cobro recurrente
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS recurring_failed_attempts INTEGER DEFAULT 0;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS last_charge_attempt DATE;

-- Usuarios
ALTER TABLE users ADD COLUMN IF NOT EXISTS lost_recurring_discount BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_ip VARCHAR(45);
ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_date TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_version VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_signature_url TEXT;

-- Restricciones CHECK desactualizadas respecto al código
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check
    CHECK (method IN ('efectivo', 'transferencia', 'tarjeta', 'payphone', 'cortesia', 'beca'));

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
    CHECK (status IN ('pagado', 'pendiente', 'fallido', 'anulado'));

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
    CHECK (type IN ('info', 'warning', 'success', 'payment', 'membership', 'class'));

-- WODs ampliados
ALTER TABLE wods ADD COLUMN IF NOT EXISTS warmup TEXT;
ALTER TABLE wods ADD COLUMN IF NOT EXISTS workout TEXT;
ALTER TABLE wods ADD COLUMN IF NOT EXISTS cooldown TEXT;
ALTER TABLE wods ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE wods ADD COLUMN IF NOT EXISTS difficulty VARCHAR(20);
ALTER TABLE wods ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
