--
-- PostgreSQL database dump
--

\restrict On1tHgjegxucz4oBduBEKYPkhYgTLJQJ8xIsZqr1cNgzGxhFwy55rE3YnrEAkoP

-- Dumped from database version 18.4 (Debian 18.4-1.pgdg13+1)
-- Dumped by pg_dump version 18.4 (Ubuntu 18.4-1.pgdg22.04+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_stat_statements; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;


--
-- Name: EXTENSION pg_stat_statements; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_stat_statements IS 'track planning and execution statistics of all SQL statements executed';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: expire_memberships(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.expire_memberships() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE memberships 
    SET status = 'expired', updated_at = NOW()
    WHERE status = 'active' 
      AND end_date < CURRENT_DATE;
END;
$$;


--
-- Name: expire_payment_intents(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.expire_payment_intents() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE payment_intents
    SET status = 'expired', updated_at = NOW()
    WHERE status = 'pending'
      AND created_at < NOW() - INTERVAL '15 minutes';
END;
$$;


--
-- Name: generate_class_instances_for_date(uuid, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_class_instances_for_date(p_gym_id uuid, p_date date) RETURNS integer
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: get_active_membership(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_active_membership(p_user_id uuid, p_gym_id uuid) RETURNS TABLE(membership_id uuid, membership_type_name character varying, start_date date, end_date date, days_remaining integer, auto_renew boolean)
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: attendance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attendance (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    gym_id uuid NOT NULL,
    user_id uuid NOT NULL,
    membership_id uuid,
    booking_id uuid,
    check_in_time timestamp with time zone DEFAULT now(),
    method character varying(20) DEFAULT 'qr'::character varying,
    validated_by uuid,
    notes text,
    CONSTRAINT attendance_method_check CHECK (((method)::text = ANY ((ARRAY['qr'::character varying, 'manual'::character varying, 'cedula'::character varying])::text[])))
);


--
-- Name: bookings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bookings (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    gym_id uuid NOT NULL,
    user_id uuid NOT NULL,
    class_instance_id uuid NOT NULL,
    status character varying(20) DEFAULT 'confirmed'::character varying,
    booked_by uuid,
    booked_by_role character varying(30),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT bookings_status_check CHECK (((status)::text = ANY ((ARRAY['confirmed'::character varying, 'cancelled'::character varying, 'attended'::character varying, 'no_show'::character varying])::text[])))
);


--
-- Name: class_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.class_instances (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    gym_id uuid NOT NULL,
    schedule_id uuid NOT NULL,
    session_id uuid NOT NULL,
    instructor_id uuid,
    class_date date NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    max_capacity integer NOT NULL,
    status character varying(20) DEFAULT 'scheduled'::character varying,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT class_instances_status_check CHECK (((status)::text = ANY ((ARRAY['scheduled'::character varying, 'completed'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: gym_subscription_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gym_subscription_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    gym_id uuid NOT NULL,
    amount numeric(8,2) NOT NULL,
    period_start date,
    period_end date,
    paid_at timestamp with time zone DEFAULT now(),
    notes text,
    registered_by uuid,
    months_covered integer DEFAULT 1
);


--
-- Name: gyms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gyms (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    slug character varying(50) NOT NULL,
    name character varying(100) NOT NULL,
    logo_url text,
    email character varying(150),
    phone character varying(20),
    address text,
    primary_color character varying(7) DEFAULT '#E85D04'::character varying,
    secondary_color character varying(7) DEFAULT '#000000'::character varying,
    theme character varying(50) DEFAULT 'classic_red'::character varying,
    booking_advance_days integer DEFAULT 7,
    is_active boolean DEFAULT true,
    payphone_enabled boolean DEFAULT false,
    payphone_store_id character varying(100),
    payphone_client_id character varying(100),
    payphone_token text,
    payphone_client_secret text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    payphone_coding_password character varying(500),
    timezone character varying(50) DEFAULT 'America/Guayaquil'::character varying,
    saas_plan_id uuid,
    saas_price numeric(8,2),
    saas_max_users integer,
    saas_status character varying(20) DEFAULT 'active'::character varying,
    saas_start_date date,
    saas_next_payment date,
    saas_grace_days integer DEFAULT 5,
    saas_billing_months integer DEFAULT 1
);


--
-- Name: instructors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instructors (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    gym_id uuid NOT NULL,
    user_id uuid,
    name character varying(150) NOT NULL,
    photo_url text,
    specialization character varying(200),
    phone character varying(20),
    bio text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    is_head_coach boolean DEFAULT false
);


--
-- Name: membership_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.membership_types (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    gym_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    duration_value integer DEFAULT 1 NOT NULL,
    duration_unit character varying(10) DEFAULT 'months'::character varying NOT NULL,
    price numeric(10,2) DEFAULT 0 NOT NULL,
    sessions_per_week integer,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    is_public boolean DEFAULT true,
    recurring_discount numeric(5,2) DEFAULT 0,
    CONSTRAINT membership_types_duration_unit_check CHECK (((duration_unit)::text = ANY ((ARRAY['days'::character varying, 'weeks'::character varying, 'months'::character varying, 'years'::character varying])::text[])))
);


--
-- Name: memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memberships (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    gym_id uuid NOT NULL,
    membership_type_id uuid NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying,
    auto_renew boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    recurring_failed_attempts integer DEFAULT 0,
    last_charge_attempt date,
    CONSTRAINT memberships_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'expired'::character varying, 'cancelled'::character varying, 'pending'::character varying])::text[])))
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    gym_id uuid,
    title character varying(200) NOT NULL,
    message text NOT NULL,
    type character varying(50) DEFAULT 'info'::character varying,
    is_read boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT notifications_type_check CHECK (((type)::text = ANY ((ARRAY['info'::character varying, 'warning'::character varying, 'success'::character varying, 'payment'::character varying, 'membership'::character varying])::text[])))
);


--
-- Name: payment_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_intents (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    client_transaction_id character varying(50) NOT NULL,
    user_id uuid NOT NULL,
    gym_id uuid NOT NULL,
    membership_type_id uuid NOT NULL,
    amount numeric(10,2) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying,
    payphone_transaction_id character varying(100),
    payphone_response jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT payment_intents_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'completed'::character varying, 'failed'::character varying, 'expired'::character varying])::text[])))
);


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    gym_id uuid NOT NULL,
    user_id uuid NOT NULL,
    membership_id uuid,
    membership_type_id uuid,
    amount numeric(10,2) NOT NULL,
    method character varying(30) NOT NULL,
    status character varying(20) DEFAULT 'pagado'::character varying,
    notes text,
    registered_by uuid,
    payphone_transaction_id character varying(100),
    payphone_response jsonb,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT payments_method_check CHECK (((method)::text = ANY ((ARRAY['efectivo'::character varying, 'transferencia'::character varying, 'tarjeta'::character varying, 'payphone'::character varying, 'cortesia'::character varying, 'beca'::character varying])::text[]))),
    CONSTRAINT payments_status_check CHECK (((status)::text = ANY ((ARRAY['pagado'::character varying, 'pendiente'::character varying, 'fallido'::character varying, 'anulado'::character varying])::text[])))
);


--
-- Name: receptionists_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receptionists_audit (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    gym_id uuid NOT NULL,
    receptionist_id uuid NOT NULL,
    action character varying(100) NOT NULL,
    target_user_id uuid,
    class_instance_id uuid,
    details jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: saas_billing_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saas_billing_periods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(30) NOT NULL,
    months integer NOT NULL,
    discount_percent numeric(5,2) DEFAULT 0,
    label character varying(60),
    is_active boolean DEFAULT true,
    sort_order integer DEFAULT 0
);


--
-- Name: saas_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saas_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(50) NOT NULL,
    max_users integer,
    price numeric(8,2) NOT NULL,
    is_active boolean DEFAULT true,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedules (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    gym_id uuid NOT NULL,
    session_id uuid NOT NULL,
    instructor_id uuid,
    day_of_week integer NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT schedules_day_of_week_check CHECK (((day_of_week >= 0) AND (day_of_week <= 6)))
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    gym_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    max_capacity integer DEFAULT 20 NOT NULL,
    duration_minutes integer DEFAULT 60 NOT NULL,
    difficulty character varying(20) DEFAULT 'beginner'::character varying,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT sessions_difficulty_check CHECK (((difficulty)::text = ANY ((ARRAY['beginner'::character varying, 'intermediate'::character varying, 'advanced'::character varying])::text[])))
);


--
-- Name: system_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_config (
    key character varying(100) NOT NULL,
    value text,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: themes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.themes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    slug character varying(50) NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    preview_image_url text,
    primary_color character varying(7) NOT NULL,
    secondary_color character varying(7) NOT NULL,
    background_color character varying(7) NOT NULL,
    surface_color character varying(7) NOT NULL,
    text_color character varying(7) NOT NULL,
    accent_color character varying(7),
    font_family character varying(100),
    border_radius character varying(20) DEFAULT '8px'::character varying,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: training_plan_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.training_plan_assignments (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    training_plan_id uuid NOT NULL,
    user_id uuid NOT NULL,
    gym_id uuid NOT NULL,
    assigned_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone
);


--
-- Name: training_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.training_plans (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    gym_id uuid NOT NULL,
    instructor_id uuid NOT NULL,
    name character varying(200) NOT NULL,
    description text,
    content jsonb,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_gym_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_gym_roles (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    gym_id uuid,
    role character varying(30) NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT user_gym_roles_role_check CHECK (((role)::text = ANY ((ARRAY['super_admin'::character varying, 'admin'::character varying, 'recepcionista'::character varying, 'instructor'::character varying, 'user'::character varying])::text[])))
);


--
-- Name: user_prs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_prs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    gym_id uuid,
    exercise character varying(100) NOT NULL,
    weight numeric(6,2) NOT NULL,
    unit character varying(3) DEFAULT 'lb'::character varying,
    updated_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    cedula character varying(20) NOT NULL,
    name character varying(150) NOT NULL,
    email character varying(150),
    phone character varying(20),
    birth_date date,
    emergency_contact_name character varying(150),
    emergency_contact_phone character varying(20),
    password_hash text NOT NULL,
    is_active boolean DEFAULT true,
    qr_code character varying(100) DEFAULT (public.uuid_generate_v4())::text,
    payphone_token text,
    payphone_token_date timestamp with time zone,
    payphone_consent_signed boolean DEFAULT false,
    payphone_consent_date timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    is_super_admin boolean DEFAULT false,
    consent_ip character varying(45),
    consent_date timestamp with time zone,
    consent_version character varying(20),
    lost_recurring_discount boolean DEFAULT false,
    consent_signature_url text
);


--
-- Name: wods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wods (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    gym_id uuid NOT NULL,
    instructor_id uuid,
    title character varying(200),
    description text NOT NULL,
    wod_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    warmup text,
    workout text,
    cooldown text,
    notes text,
    difficulty character varying(20) DEFAULT 'rx'::character varying,
    created_by uuid
);


--
-- Name: attendance attendance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance
    ADD CONSTRAINT attendance_pkey PRIMARY KEY (id);


--
-- Name: bookings bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);


--
-- Name: bookings bookings_user_id_class_instance_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_user_id_class_instance_id_key UNIQUE (user_id, class_instance_id);


--
-- Name: class_instances class_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_instances
    ADD CONSTRAINT class_instances_pkey PRIMARY KEY (id);


--
-- Name: class_instances class_instances_schedule_id_class_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_instances
    ADD CONSTRAINT class_instances_schedule_id_class_date_key UNIQUE (schedule_id, class_date);


--
-- Name: gym_subscription_payments gym_subscription_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gym_subscription_payments
    ADD CONSTRAINT gym_subscription_payments_pkey PRIMARY KEY (id);


--
-- Name: gyms gyms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gyms
    ADD CONSTRAINT gyms_pkey PRIMARY KEY (id);


--
-- Name: gyms gyms_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gyms
    ADD CONSTRAINT gyms_slug_key UNIQUE (slug);


--
-- Name: instructors instructors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructors
    ADD CONSTRAINT instructors_pkey PRIMARY KEY (id);


--
-- Name: membership_types membership_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership_types
    ADD CONSTRAINT membership_types_pkey PRIMARY KEY (id);


--
-- Name: memberships memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: payment_intents payment_intents_client_transaction_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_intents
    ADD CONSTRAINT payment_intents_client_transaction_id_key UNIQUE (client_transaction_id);


--
-- Name: payment_intents payment_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_intents
    ADD CONSTRAINT payment_intents_pkey PRIMARY KEY (id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: receptionists_audit receptionists_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receptionists_audit
    ADD CONSTRAINT receptionists_audit_pkey PRIMARY KEY (id);


--
-- Name: saas_billing_periods saas_billing_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saas_billing_periods
    ADD CONSTRAINT saas_billing_periods_pkey PRIMARY KEY (id);


--
-- Name: saas_plans saas_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saas_plans
    ADD CONSTRAINT saas_plans_pkey PRIMARY KEY (id);


--
-- Name: schedules schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: system_config system_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_config
    ADD CONSTRAINT system_config_pkey PRIMARY KEY (key);


--
-- Name: themes themes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.themes
    ADD CONSTRAINT themes_pkey PRIMARY KEY (id);


--
-- Name: themes themes_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.themes
    ADD CONSTRAINT themes_slug_key UNIQUE (slug);


--
-- Name: training_plan_assignments training_plan_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plan_assignments
    ADD CONSTRAINT training_plan_assignments_pkey PRIMARY KEY (id);


--
-- Name: training_plan_assignments training_plan_assignments_training_plan_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plan_assignments
    ADD CONSTRAINT training_plan_assignments_training_plan_id_user_id_key UNIQUE (training_plan_id, user_id);


--
-- Name: training_plans training_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plans
    ADD CONSTRAINT training_plans_pkey PRIMARY KEY (id);


--
-- Name: user_gym_roles user_gym_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_gym_roles
    ADD CONSTRAINT user_gym_roles_pkey PRIMARY KEY (id);


--
-- Name: user_gym_roles user_gym_roles_user_id_gym_id_role_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_gym_roles
    ADD CONSTRAINT user_gym_roles_user_id_gym_id_role_key UNIQUE (user_id, gym_id, role);


--
-- Name: user_prs user_prs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_prs
    ADD CONSTRAINT user_prs_pkey PRIMARY KEY (id);


--
-- Name: user_prs user_prs_user_id_gym_id_exercise_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_prs
    ADD CONSTRAINT user_prs_user_id_gym_id_exercise_key UNIQUE (user_id, gym_id, exercise);


--
-- Name: users users_cedula_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_cedula_key UNIQUE (cedula);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_qr_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_qr_code_key UNIQUE (qr_code);


--
-- Name: wods wods_gym_id_wod_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wods
    ADD CONSTRAINT wods_gym_id_wod_date_key UNIQUE (gym_id, wod_date);


--
-- Name: wods wods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wods
    ADD CONSTRAINT wods_pkey PRIMARY KEY (id);


--
-- Name: idx_attendance_check_in_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attendance_check_in_time ON public.attendance USING btree (check_in_time);


--
-- Name: idx_attendance_gym_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attendance_gym_id ON public.attendance USING btree (gym_id);


--
-- Name: idx_attendance_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attendance_user_id ON public.attendance USING btree (user_id);


--
-- Name: idx_bookings_class_instance_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_class_instance_id ON public.bookings USING btree (class_instance_id);


--
-- Name: idx_bookings_gym_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_gym_status ON public.bookings USING btree (gym_id, status);


--
-- Name: idx_bookings_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_user_id ON public.bookings USING btree (user_id);


--
-- Name: idx_class_instances_gym_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_class_instances_gym_date ON public.class_instances USING btree (gym_id, class_date);


--
-- Name: idx_gym_sub_payments_gym_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gym_sub_payments_gym_id ON public.gym_subscription_payments USING btree (gym_id);


--
-- Name: idx_gyms_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gyms_slug ON public.gyms USING btree (slug);


--
-- Name: idx_memberships_end_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memberships_end_date ON public.memberships USING btree (end_date);


--
-- Name: idx_memberships_gym_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memberships_gym_id ON public.memberships USING btree (gym_id);


--
-- Name: idx_memberships_gym_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memberships_gym_status ON public.memberships USING btree (gym_id, status);


--
-- Name: idx_memberships_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memberships_status ON public.memberships USING btree (status);


--
-- Name: idx_memberships_user_gym; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memberships_user_gym ON public.memberships USING btree (user_id, gym_id);


--
-- Name: idx_notifications_gym_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_gym_id ON public.notifications USING btree (gym_id);


--
-- Name: idx_notifications_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user_id ON public.notifications USING btree (user_id, is_read);


--
-- Name: idx_payment_intents_client_tx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_intents_client_tx ON public.payment_intents USING btree (client_transaction_id);


--
-- Name: idx_payment_intents_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_intents_user_id ON public.payment_intents USING btree (user_id);


--
-- Name: idx_payments_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_created_at ON public.payments USING btree (created_at);


--
-- Name: idx_payments_gym_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_gym_id ON public.payments USING btree (gym_id);


--
-- Name: idx_payments_gym_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_gym_status ON public.payments USING btree (gym_id, status);


--
-- Name: idx_payments_membership_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_membership_id ON public.payments USING btree (membership_id);


--
-- Name: idx_payments_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_status ON public.payments USING btree (status);


--
-- Name: idx_payments_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_user_id ON public.payments USING btree (user_id);


--
-- Name: idx_schedules_gym_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_gym_day ON public.schedules USING btree (gym_id, day_of_week);


--
-- Name: idx_user_gym_roles_gym_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_gym_roles_gym_id ON public.user_gym_roles USING btree (gym_id);


--
-- Name: idx_user_gym_roles_gym_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_gym_roles_gym_role ON public.user_gym_roles USING btree (gym_id, role) WHERE (is_active = true);


--
-- Name: idx_user_gym_roles_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_gym_roles_user_id ON public.user_gym_roles USING btree (user_id);


--
-- Name: idx_users_cedula; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_cedula ON public.users USING btree (cedula);


--
-- Name: bookings update_bookings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_bookings_updated_at BEFORE UPDATE ON public.bookings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: gyms update_gyms_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_gyms_updated_at BEFORE UPDATE ON public.gyms FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: instructors update_instructors_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_instructors_updated_at BEFORE UPDATE ON public.instructors FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: membership_types update_membership_types_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_membership_types_updated_at BEFORE UPDATE ON public.membership_types FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: memberships update_memberships_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_memberships_updated_at BEFORE UPDATE ON public.memberships FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: schedules update_schedules_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_schedules_updated_at BEFORE UPDATE ON public.schedules FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: sessions update_sessions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_sessions_updated_at BEFORE UPDATE ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: training_plans update_training_plans_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_training_plans_updated_at BEFORE UPDATE ON public.training_plans FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: users update_users_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: wods update_wods_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_wods_updated_at BEFORE UPDATE ON public.wods FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: attendance attendance_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance
    ADD CONSTRAINT attendance_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id);


--
-- Name: attendance attendance_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance
    ADD CONSTRAINT attendance_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id) ON DELETE CASCADE;


--
-- Name: attendance attendance_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance
    ADD CONSTRAINT attendance_membership_id_fkey FOREIGN KEY (membership_id) REFERENCES public.memberships(id);


--
-- Name: attendance attendance_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance
    ADD CONSTRAINT attendance_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: attendance attendance_validated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance
    ADD CONSTRAINT attendance_validated_by_fkey FOREIGN KEY (validated_by) REFERENCES public.users(id);


--
-- Name: bookings bookings_booked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_booked_by_fkey FOREIGN KEY (booked_by) REFERENCES public.users(id);


--
-- Name: bookings bookings_class_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_class_instance_id_fkey FOREIGN KEY (class_instance_id) REFERENCES public.class_instances(id) ON DELETE CASCADE;


--
-- Name: bookings bookings_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id) ON DELETE CASCADE;


--
-- Name: bookings bookings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: class_instances class_instances_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_instances
    ADD CONSTRAINT class_instances_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id) ON DELETE CASCADE;


--
-- Name: class_instances class_instances_instructor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_instances
    ADD CONSTRAINT class_instances_instructor_id_fkey FOREIGN KEY (instructor_id) REFERENCES public.instructors(id);


--
-- Name: class_instances class_instances_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_instances
    ADD CONSTRAINT class_instances_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES public.schedules(id) ON DELETE CASCADE;


--
-- Name: class_instances class_instances_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_instances
    ADD CONSTRAINT class_instances_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id);


--
-- Name: gym_subscription_payments gym_subscription_payments_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gym_subscription_payments
    ADD CONSTRAINT gym_subscription_payments_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id) ON DELETE CASCADE;


--
-- Name: gyms gyms_saas_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gyms
    ADD CONSTRAINT gyms_saas_plan_id_fkey FOREIGN KEY (saas_plan_id) REFERENCES public.saas_plans(id);


--
-- Name: instructors instructors_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructors
    ADD CONSTRAINT instructors_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id) ON DELETE CASCADE;


--
-- Name: instructors instructors_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructors
    ADD CONSTRAINT instructors_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: membership_types membership_types_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership_types
    ADD CONSTRAINT membership_types_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id) ON DELETE CASCADE;


--
-- Name: memberships memberships_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id) ON DELETE CASCADE;


--
-- Name: memberships memberships_membership_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_membership_type_id_fkey FOREIGN KEY (membership_type_id) REFERENCES public.membership_types(id);


--
-- Name: memberships memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id);


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: payment_intents payment_intents_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_intents
    ADD CONSTRAINT payment_intents_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id) ON DELETE CASCADE;


--
-- Name: payment_intents payment_intents_membership_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_intents
    ADD CONSTRAINT payment_intents_membership_type_id_fkey FOREIGN KEY (membership_type_id) REFERENCES public.membership_types(id);


--
-- Name: payment_intents payment_intents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_intents
    ADD CONSTRAINT payment_intents_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: payments payments_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id) ON DELETE CASCADE;


--
-- Name: payments payments_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_membership_id_fkey FOREIGN KEY (membership_id) REFERENCES public.memberships(id);


--
-- Name: payments payments_membership_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_membership_type_id_fkey FOREIGN KEY (membership_type_id) REFERENCES public.membership_types(id);


--
-- Name: payments payments_registered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_registered_by_fkey FOREIGN KEY (registered_by) REFERENCES public.users(id);


--
-- Name: payments payments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: receptionists_audit receptionists_audit_class_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receptionists_audit
    ADD CONSTRAINT receptionists_audit_class_instance_id_fkey FOREIGN KEY (class_instance_id) REFERENCES public.class_instances(id);


--
-- Name: receptionists_audit receptionists_audit_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receptionists_audit
    ADD CONSTRAINT receptionists_audit_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id) ON DELETE CASCADE;


--
-- Name: receptionists_audit receptionists_audit_receptionist_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receptionists_audit
    ADD CONSTRAINT receptionists_audit_receptionist_id_fkey FOREIGN KEY (receptionist_id) REFERENCES public.users(id);


--
-- Name: receptionists_audit receptionists_audit_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receptionists_audit
    ADD CONSTRAINT receptionists_audit_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.users(id);


--
-- Name: schedules schedules_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id) ON DELETE CASCADE;


--
-- Name: schedules schedules_instructor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_instructor_id_fkey FOREIGN KEY (instructor_id) REFERENCES public.instructors(id);


--
-- Name: schedules schedules_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id) ON DELETE CASCADE;


--
-- Name: training_plan_assignments training_plan_assignments_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plan_assignments
    ADD CONSTRAINT training_plan_assignments_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id);


--
-- Name: training_plan_assignments training_plan_assignments_training_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plan_assignments
    ADD CONSTRAINT training_plan_assignments_training_plan_id_fkey FOREIGN KEY (training_plan_id) REFERENCES public.training_plans(id) ON DELETE CASCADE;


--
-- Name: training_plan_assignments training_plan_assignments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plan_assignments
    ADD CONSTRAINT training_plan_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: training_plans training_plans_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plans
    ADD CONSTRAINT training_plans_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id) ON DELETE CASCADE;


--
-- Name: training_plans training_plans_instructor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plans
    ADD CONSTRAINT training_plans_instructor_id_fkey FOREIGN KEY (instructor_id) REFERENCES public.instructors(id);


--
-- Name: user_gym_roles user_gym_roles_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_gym_roles
    ADD CONSTRAINT user_gym_roles_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id) ON DELETE CASCADE;


--
-- Name: user_gym_roles user_gym_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_gym_roles
    ADD CONSTRAINT user_gym_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_prs user_prs_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_prs
    ADD CONSTRAINT user_prs_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id) ON DELETE CASCADE;


--
-- Name: user_prs user_prs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_prs
    ADD CONSTRAINT user_prs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: wods wods_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wods
    ADD CONSTRAINT wods_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: wods wods_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wods
    ADD CONSTRAINT wods_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id) ON DELETE CASCADE;


--
-- Name: wods wods_instructor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wods
    ADD CONSTRAINT wods_instructor_id_fkey FOREIGN KEY (instructor_id) REFERENCES public.instructors(id);


--
-- PostgreSQL database dump complete
--

\unrestrict On1tHgjegxucz4oBduBEKYPkhYgTLJQJ8xIsZqr1cNgzGxhFwy55rE3YnrEAkoP

