-- ============================================================
-- GYMVIP - Schema PostgreSQL Multi-Gym
-- ============================================================

-- Extensiones
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- TABLA: gyms (cada box/gimnasio es un tenant)
-- ============================================================
CREATE TABLE gyms (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug VARCHAR(50) UNIQUE NOT NULL,           -- identificador único en URL ej: "theshed"
    name VARCHAR(100) NOT NULL,
    logo_url TEXT,
    email VARCHAR(150),
    phone VARCHAR(20),
    address TEXT,
    
    -- Configuración visual (por gym, parece su propia app)
    primary_color VARCHAR(7) DEFAULT '#E85D04', -- color primario HEX
    secondary_color VARCHAR(7) DEFAULT '#000000',
    theme VARCHAR(50) DEFAULT 'classic_red',    -- plantilla del marketplace
    
    -- Configuración operativa
    booking_advance_days INT DEFAULT 7,         -- días anticipación reservas
    is_active BOOLEAN DEFAULT TRUE,
    
    -- PayPhone (pasarela de pago por gym)
    payphone_enabled BOOLEAN DEFAULT FALSE,
    payphone_store_id VARCHAR(100),
    payphone_client_id VARCHAR(100),
    payphone_token TEXT,                        -- encriptado
    payphone_client_secret TEXT,                -- encriptado
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLA: users (todos los usuarios del sistema)
-- ============================================================
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cedula VARCHAR(20) UNIQUE NOT NULL,         -- cédula ecuatoriana como username
    name VARCHAR(150) NOT NULL,
    email VARCHAR(150),
    phone VARCHAR(20),
    birth_date DATE,
    
    -- Contacto emergencia
    emergency_contact_name VARCHAR(150),
    emergency_contact_phone VARCHAR(20),
    
    -- Credenciales
    password_hash TEXT NOT NULL,
    
    -- Estado
    is_active BOOLEAN DEFAULT TRUE,
    
    -- Para el QR personal del usuario
    qr_code VARCHAR(100) UNIQUE DEFAULT uuid_generate_v4()::TEXT,
    
    -- PayPhone tokenización (cobro automático)
    payphone_token TEXT,                        -- token de tarjeta guardada
    payphone_token_date TIMESTAMPTZ,
    payphone_consent_signed BOOLEAN DEFAULT FALSE,
    payphone_consent_date TIMESTAMPTZ,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLA: user_gym_roles (relación usuario-gym con rol)
-- Permite que un usuario tenga diferentes roles en diferentes gyms
-- ============================================================
CREATE TABLE user_gym_roles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    role VARCHAR(30) NOT NULL CHECK (role IN ('super_admin', 'admin', 'recepcionista', 'instructor', 'user')),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(user_id, gym_id, role)
);

-- ============================================================
-- TABLA: membership_types (planes de membresía por gym)
-- ============================================================
CREATE TABLE membership_types (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    
    -- Duración
    duration_value INT NOT NULL DEFAULT 1,      -- cantidad
    duration_unit VARCHAR(10) NOT NULL DEFAULT 'months' CHECK (duration_unit IN ('days', 'weeks', 'months', 'years')),
    
    -- Precio
    price DECIMAL(10,2) NOT NULL DEFAULT 0,
    
    -- Opcionales
    sessions_per_week INT,                      -- null = ilimitado
    
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLA: memberships (suscripciones activas de usuarios)
-- ============================================================
CREATE TABLE memberships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    membership_type_id UUID NOT NULL REFERENCES membership_types(id),
    
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled', 'pending')),
    
    -- Auto-renovación PayPhone
    auto_renew BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLA: payments (registro de todos los pagos)
-- ============================================================
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    membership_id UUID REFERENCES memberships(id),
    membership_type_id UUID REFERENCES membership_types(id),
    
    amount DECIMAL(10,2) NOT NULL,
    method VARCHAR(30) NOT NULL CHECK (method IN ('efectivo', 'transferencia', 'tarjeta', 'payphone')),
    status VARCHAR(20) DEFAULT 'pagado' CHECK (status IN ('pagado', 'pendiente', 'fallido')),
    
    notes TEXT,
    
    -- Quién registró el pago (admin/recepcionista)
    registered_by UUID REFERENCES users(id),
    
    -- Datos PayPhone si aplica
    payphone_transaction_id VARCHAR(100),
    payphone_response JSONB,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLA: sessions (tipos de clases/sesiones del gym)
-- ============================================================
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,                 -- ej: "Sesión 5am", "CrossFit WOD"
    description TEXT,
    max_capacity INT NOT NULL DEFAULT 20,
    duration_minutes INT NOT NULL DEFAULT 60,
    difficulty VARCHAR(20) DEFAULT 'beginner' CHECK (difficulty IN ('beginner', 'intermediate', 'advanced')),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLA: instructors (entrenadores del gym)
-- Separado de users porque tienen datos específicos de instructor
-- ============================================================
CREATE TABLE instructors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),          -- si tiene cuenta de usuario
    name VARCHAR(150) NOT NULL,
    photo_url TEXT,
    specialization VARCHAR(200),
    phone VARCHAR(20),
    bio TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLA: schedules (horarios recurrentes por día de semana)
-- ============================================================
CREATE TABLE schedules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    instructor_id UUID REFERENCES instructors(id),
    
    day_of_week INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=Dom, 1=Lun...6=Sab
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLA: class_instances (instancias reales de clases por fecha)
-- Se generan automáticamente a partir de schedules
-- ============================================================
CREATE TABLE class_instances (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    schedule_id UUID NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES sessions(id),
    instructor_id UUID REFERENCES instructors(id),
    
    class_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    
    max_capacity INT NOT NULL,
    status VARCHAR(20) DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(schedule_id, class_date)
);

-- ============================================================
-- TABLA: bookings (reservas de usuarios a clases)
-- ============================================================
CREATE TABLE bookings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    class_instance_id UUID NOT NULL REFERENCES class_instances(id) ON DELETE CASCADE,
    
    status VARCHAR(20) DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled', 'attended', 'no_show')),
    
    -- Quién hizo la reserva (puede ser recepcionista)
    booked_by UUID REFERENCES users(id),
    booked_by_role VARCHAR(30),
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(user_id, class_instance_id)
);

-- ============================================================
-- TABLA: attendance (registro de ingresos al gym)
-- Se registra via QR o manual
-- ============================================================
CREATE TABLE attendance (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    membership_id UUID REFERENCES memberships(id),
    booking_id UUID REFERENCES bookings(id),
    
    check_in_time TIMESTAMPTZ DEFAULT NOW(),
    method VARCHAR(20) DEFAULT 'qr' CHECK (method IN ('qr', 'manual', 'cedula')),
    
    -- Quién validó (si fue manual)
    validated_by UUID REFERENCES users(id),
    
    notes TEXT
);

-- ============================================================
-- TABLA: receptionists_audit (auditoría de acciones de recepción)
-- ============================================================
CREATE TABLE receptionists_audit (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    receptionist_id UUID NOT NULL REFERENCES users(id),
    
    action VARCHAR(100) NOT NULL,               -- ej: "Reserva creada", "Pago registrado"
    target_user_id UUID REFERENCES users(id),
    class_instance_id UUID REFERENCES class_instances(id),
    details JSONB,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLA: wods (entrenamientos del día, creados por instructores)
-- ============================================================
CREATE TABLE wods (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    instructor_id UUID REFERENCES instructors(id),
    
    title VARCHAR(200),
    description TEXT NOT NULL,
    wod_date DATE NOT NULL,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(gym_id, wod_date)
);

-- ============================================================
-- TABLA: training_plans (rutinas/planes de entrenamiento)
-- ============================================================
CREATE TABLE training_plans (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    instructor_id UUID NOT NULL REFERENCES instructors(id),
    
    name VARCHAR(200) NOT NULL,
    description TEXT,
    content JSONB,                              -- estructura flexible para ejercicios
    
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLA: training_plan_assignments (asignación de rutinas a usuarios)
-- ============================================================
CREATE TABLE training_plan_assignments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    training_plan_id UUID NOT NULL REFERENCES training_plans(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gym_id UUID NOT NULL REFERENCES gyms(id),
    
    assigned_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    
    UNIQUE(training_plan_id, user_id)
);

-- ============================================================
-- TABLA: notifications (notificaciones para usuarios)
-- ============================================================
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gym_id UUID REFERENCES gyms(id),
    
    title VARCHAR(200) NOT NULL,
    message TEXT NOT NULL,
    type VARCHAR(50) DEFAULT 'info' CHECK (type IN ('info', 'warning', 'success', 'payment', 'membership')),
    is_read BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLA: themes (marketplace de diseños)
-- ============================================================
CREATE TABLE themes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    preview_image_url TEXT,
    
    -- Variables CSS del tema
    primary_color VARCHAR(7) NOT NULL,
    secondary_color VARCHAR(7) NOT NULL,
    background_color VARCHAR(7) NOT NULL,
    surface_color VARCHAR(7) NOT NULL,
    text_color VARCHAR(7) NOT NULL,
    accent_color VARCHAR(7),
    
    font_family VARCHAR(100),
    border_radius VARCHAR(20) DEFAULT '8px',
    
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLA: system_config (configuración global del super admin)
-- ============================================================
CREATE TABLE system_config (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ÍNDICES para performance
-- ============================================================
CREATE INDEX idx_user_gym_roles_user_id ON user_gym_roles(user_id);
CREATE INDEX idx_user_gym_roles_gym_id ON user_gym_roles(gym_id);
CREATE INDEX idx_memberships_user_gym ON memberships(user_id, gym_id);
CREATE INDEX idx_memberships_status ON memberships(status);
CREATE INDEX idx_memberships_end_date ON memberships(end_date);
CREATE INDEX idx_payments_gym_id ON payments(gym_id);
CREATE INDEX idx_payments_user_id ON payments(user_id);
CREATE INDEX idx_payments_created_at ON payments(created_at);
CREATE INDEX idx_schedules_gym_day ON schedules(gym_id, day_of_week);
CREATE INDEX idx_class_instances_gym_date ON class_instances(gym_id, class_date);
CREATE INDEX idx_bookings_user_id ON bookings(user_id);
CREATE INDEX idx_bookings_class_instance_id ON bookings(class_instance_id);
CREATE INDEX idx_attendance_gym_id ON attendance(gym_id);
CREATE INDEX idx_attendance_user_id ON attendance(user_id);
CREATE INDEX idx_attendance_check_in_time ON attendance(check_in_time);
CREATE INDEX idx_notifications_user_id ON notifications(user_id, is_read);
CREATE INDEX idx_users_cedula ON users(cedula);
CREATE INDEX idx_gyms_slug ON gyms(slug);

-- ============================================================
-- DATOS INICIALES: Super Admin
-- ============================================================
INSERT INTO users (cedula, name, email, password_hash) VALUES (
    '9999999999',
    'Super Administrador',
    'superadmin@gymvip.com',
    crypt('SuperAdmin2026!', gen_salt('bf'))
);

-- ============================================================
-- DATOS INICIALES: Temas del marketplace
-- ============================================================
INSERT INTO themes (slug, name, description, preview_image_url, primary_color, secondary_color, background_color, surface_color, text_color, accent_color, font_family, border_radius) VALUES
('classic_red', 'Estilo Clásico (Rojo)', 'El diseño original de alta intensidad con gris carbón y acentos rojos. Robusto y corporativo.', NULL, '#DC2626', '#374151', '#111827', '#1F2937', '#F9FAFB', '#EF4444', 'Inter', '6px'),
('glow_neon', 'Glow Neón', 'Aura ciberpunk con luces moradas de neón y fondos violetas eléctricos. Enérgico y futurista.', NULL, '#7C3AED', '#4C1D95', '#0F0A1E', '#1A0F3C', '#F3F0FF', '#A855F7', 'Space Grotesk', '4px'),
('fuego_fenix', 'Fuego Fénix', 'Naranja volcánico ardiente sobre negro mineral. Ideal para boxes de CrossFit con alta temperatura.', NULL, '#EA580C', '#292524', '#0C0A09', '#1C1917', '#FFF7ED', '#F97316', 'Barlow', '4px'),
('esmeralda_premium', 'Esmeralda Premium', 'Tono jade intenso y obsidiana pulida. Denota estatus, lujo y salud de alto nivel.', NULL, '#059669', '#064E3B', '#0A0F0D', '#111C17', '#ECFDF5', '#10B981', 'DM Sans', '8px'),
('acero_artico', 'Acero Ártico', 'Azul glacial de alto contraste con gris pizarra. Moderno, limpio, fresco y sofisticado.', NULL, '#0EA5E9', '#0C4A6E', '#0B1120', '#0F172A', '#F0F9FF', '#38BDF8', 'Plus Jakarta Sans', '6px'),
('oro_imperial', 'Oro Imperial', 'Dorado metálico majestuoso sobre fondo piedra oscuro. Transmite prestigio y campeonatos.', NULL, '#D97706', '#78350F', '#0F0D09', '#1C1710', '#FFFBEB', '#F59E0B', 'Outfit', '4px'),
('titan_negro', 'Titán Negro', 'Negro puro con acento blanco. Minimalismo extremo para boxes de élite.', NULL, '#FFFFFF', '#171717', '#000000', '#0A0A0A', '#FAFAFA', '#E5E5E5', 'Geist', '2px'),
('sangre_fria', 'Sangre Fría', 'Rojo carmesí profundo con negro absoluto. Intensidad máxima para atletas serios.', NULL, '#BE123C', '#881337', '#0A0004', '#14000A', '#FFF1F2', '#E11D48', 'Syne', '4px'),
('oceano_profundo', 'Océano Profundo', 'Azul marino oscuro con turquesa. Frescura, resistencia y profundidad atlética.', NULL, '#0891B2', '#164E63', '#030B12', '#0A1929', '#F0FDFF', '#06B6D4', 'Nunito', '8px'),
('arena_combat', 'Arena Combat', 'Marrón tierra y naranja quemado. Estética de entrenamiento funcional y crudo.', NULL, '#C2410C', '#7C2D12', '#120A04', '#1E1008', '#FFF7ED', '#FB923C', 'Roboto Condensed', '3px');

-- ============================================================
-- ROL de super_admin al usuario inicial
-- (sin gym_id porque super_admin es global)
-- ============================================================
-- El super_admin se maneja en la aplicación verificando si el usuario
-- tiene role = 'super_admin' en cualquier user_gym_roles con gym_id NULL
-- Lo hacemos con una fila especial:
INSERT INTO user_gym_roles (user_id, gym_id, role)
SELECT u.id, NULL, 'super_admin'
FROM users u WHERE u.cedula = '9999999999'
-- gym_id NULL no está permitido por FK, así que lo manejamos diferente:
-- usamos una tabla aparte o un flag en users
ON CONFLICT DO NOTHING;

-- Alternativa limpia: agregar columna is_super_admin en users
ALTER TABLE users ADD COLUMN is_super_admin BOOLEAN DEFAULT FALSE;
UPDATE users SET is_super_admin = TRUE WHERE cedula = '9999999999';

-- Limpiar el insert fallido de arriba
DELETE FROM user_gym_roles WHERE gym_id IS NULL;

-- Hacer gym_id nullable en user_gym_roles para super_admin
ALTER TABLE user_gym_roles ALTER COLUMN gym_id DROP NOT NULL;

-- ============================================================
-- FUNCIÓN: actualizar updated_at automáticamente
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers para updated_at
CREATE TRIGGER update_gyms_updated_at BEFORE UPDATE ON gyms FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_membership_types_updated_at BEFORE UPDATE ON membership_types FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_memberships_updated_at BEFORE UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_sessions_updated_at BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_instructors_updated_at BEFORE UPDATE ON instructors FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_schedules_updated_at BEFORE UPDATE ON schedules FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_bookings_updated_at BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_training_plans_updated_at BEFORE UPDATE ON training_plans FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_wods_updated_at BEFORE UPDATE ON wods FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- FUNCIÓN: obtener membresía activa de un usuario en un gym
-- ============================================================
CREATE OR REPLACE FUNCTION get_active_membership(p_user_id UUID, p_gym_id UUID)
RETURNS TABLE(
    membership_id UUID,
    membership_type_name VARCHAR,
    start_date DATE,
    end_date DATE,
    days_remaining INT,
    auto_renew BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        m.id,
        mt.name,
        m.start_date,
        m.end_date,
        (m.end_date - CURRENT_DATE)::INT,
        m.auto_renew
    FROM memberships m
    JOIN membership_types mt ON m.membership_type_id = mt.id
    WHERE m.user_id = p_user_id 
      AND m.gym_id = p_gym_id
      AND m.status = 'active'
      AND m.end_date >= CURRENT_DATE
    ORDER BY m.end_date DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- FUNCIÓN: expirar membresías vencidas (para cron job)
-- ============================================================
CREATE OR REPLACE FUNCTION expire_memberships()
RETURNS void AS $$
BEGIN
    UPDATE memberships 
    SET status = 'expired', updated_at = NOW()
    WHERE status = 'active' 
      AND end_date < CURRENT_DATE;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- FUNCIÓN: generar instancias de clase para una fecha
-- ============================================================
CREATE OR REPLACE FUNCTION generate_class_instances_for_date(p_gym_id UUID, p_date DATE)
RETURNS INT AS $$
DECLARE
    v_day_of_week INT;
    v_count INT := 0;
    v_schedule RECORD;
BEGIN
    v_day_of_week := EXTRACT(DOW FROM p_date)::INT;
    
    FOR v_schedule IN
        SELECT * FROM schedules 
        WHERE gym_id = p_gym_id 
          AND day_of_week = v_day_of_week
          AND is_active = TRUE
    LOOP
        INSERT INTO class_instances (
            gym_id, schedule_id, session_id, instructor_id,
            class_date, start_time, end_time, max_capacity
        )
        SELECT 
            v_schedule.gym_id,
            v_schedule.id,
            v_schedule.session_id,
            v_schedule.instructor_id,
            p_date,
            v_schedule.start_time,
            v_schedule.end_time,
            s.max_capacity
        FROM sessions s WHERE s.id = v_schedule.session_id
        ON CONFLICT (schedule_id, class_date) DO NOTHING;
        
        v_count := v_count + 1;
    END LOOP;
    
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;
