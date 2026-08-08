-- ============================================================
-- MIGRACIÓN: Compromiso de permanencia y penalidad por retiro
-- ============================================================
-- Al activar el débito recurrente el socio obtiene un descuento a cambio de
-- permanecer N meses. Si se retira antes, paga una penalidad calculada como:
--     meses restantes × precio mensual que paga × penalty_percent
-- Los términos se congelan al firmar (ver membership_commitments): si el
-- gimnasio cambia el porcentaje después, a quien ya firmó se le respeta el suyo.

-- ---------- Configuración por plan de membresía ----------
-- El mismo plan sirve con y sin compromiso: el compromiso solo aplica si el
-- socio elige débito recurrente. commitment_months = 0 -> descuento sin permanencia.
ALTER TABLE membership_types ADD COLUMN IF NOT EXISTS commitment_months INTEGER DEFAULT 0;
ALTER TABLE membership_types ADD COLUMN IF NOT EXISTS penalty_percent DECIMAL(5,2) DEFAULT 25.00;
-- Si es FALSE, al cumplirse el plazo sigue cobrando normal y puede cancelar
-- sin penalidad (no se le pregunta nada). Si es TRUE, se le pide confirmar
-- un nuevo período con permanencia.
ALTER TABLE membership_types ADD COLUMN IF NOT EXISTS penalty_renews BOOLEAN DEFAULT FALSE;

-- ---------- Contrato firmado (términos congelados) ----------
CREATE TABLE IF NOT EXISTS membership_commitments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    membership_id UUID REFERENCES memberships(id) ON DELETE SET NULL,
    membership_type_id UUID NOT NULL REFERENCES membership_types(id),

    -- Términos vigentes el día de la firma (no cambian después)
    commitment_months INTEGER NOT NULL,
    monthly_price DECIMAL(10,2) NOT NULL,   -- lo que efectivamente paga
    list_price DECIMAL(10,2) NOT NULL,      -- precio sin descuento, informativo
    penalty_percent DECIMAL(5,2) NOT NULL,
    penalty_renews BOOLEAN NOT NULL DEFAULT FALSE,

    -- Evidencia del consentimiento
    contract_version VARCHAR(20),
    contract_text TEXT,
    signature_url TEXT,
    signed_ip VARCHAR(45),
    signed_at TIMESTAMPTZ DEFAULT NOW(),

    start_date DATE NOT NULL,
    end_date DATE NOT NULL,

    -- active: vigente | completed: cumplió el plazo | broken: se retiró antes
    -- waived: el gimnasio lo liberó | payment_failed: 3 cobros fallidos, en revisión
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'completed', 'broken', 'waived', 'payment_failed')),
    ended_at TIMESTAMPTZ,

    -- Renovación (solo se usa cuando penalty_renews = TRUE)
    renewal_asked_at TIMESTAMPTZ,
    renewal_answer VARCHAR(3) CHECK (renewal_answer IN ('si', 'no')),
    renewal_answered_at TIMESTAMPTZ,
    renewal_reminders INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commitments_user ON membership_commitments(user_id, status);
CREATE INDEX IF NOT EXISTS idx_commitments_gym ON membership_commitments(gym_id, status);
CREATE INDEX IF NOT EXISTS idx_commitments_end ON membership_commitments(end_date) WHERE status = 'active';

-- ---------- Deudas por retiro anticipado ----------
CREATE TABLE IF NOT EXISTS penalties (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    commitment_id UUID REFERENCES membership_commitments(id) ON DELETE SET NULL,

    amount DECIMAL(10,2) NOT NULL,
    -- Desglose guardado para poder explicarle al socio cómo se calculó
    months_remaining INTEGER,
    monthly_price DECIMAL(10,2),
    penalty_percent DECIMAL(5,2),

    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'paid', 'waived')),
    payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
    waived_reason TEXT,
    resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_penalties_pendientes ON penalties(user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_penalties_gym ON penalties(gym_id, status);
