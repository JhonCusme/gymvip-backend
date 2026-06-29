-- ============================================================
-- MIGRACIÓN: Tabla payment_intents para PayPhone
-- Guarda la intención de pago antes de redirigir al usuario
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_intents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_transaction_id VARCHAR(50) UNIQUE NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    membership_type_id UUID NOT NULL REFERENCES membership_types(id),
    amount DECIMAL(10,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'expired')),
    payphone_transaction_id VARCHAR(100),
    payphone_response JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_intents_client_tx ON payment_intents(client_transaction_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_user_id ON payment_intents(user_id);

-- Expirar intenciones pendientes después de 10 minutos (cajita de pagos expira en 10 min)
CREATE OR REPLACE FUNCTION expire_payment_intents()
RETURNS void AS $$
BEGIN
    UPDATE payment_intents
    SET status = 'expired', updated_at = NOW()
    WHERE status = 'pending'
      AND created_at < NOW() - INTERVAL '15 minutes';
END;
$$ LANGUAGE plpgsql;
