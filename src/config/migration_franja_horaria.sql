-- ============================================================
-- MIGRACIÓN: Restricción de horarios por plan de membresía
-- ============================================================
-- Permite planes tipo "Promo Matutina" que solo agendan dentro de una franja.
-- Se usa una franja (y no una lista de horarios marcados) para que los
-- horarios nuevos queden incluidos automáticamente, sin tener que acordarse
-- de marcarlos en cada plan.
--
-- booking_start_time NULL = plan sin restricción (agenda a cualquier hora).
-- booking_days NULL o vacío = todos los días.

ALTER TABLE membership_types ADD COLUMN IF NOT EXISTS booking_start_time TIME;
ALTER TABLE membership_types ADD COLUMN IF NOT EXISTS booking_end_time TIME;
-- Días permitidos con la misma convención que schedules.day_of_week
-- (0 = domingo ... 6 = sábado)
ALTER TABLE membership_types ADD COLUMN IF NOT EXISTS booking_days INTEGER[];
