-- Migration 007: plans, prices, entitlements, access codes and store purchases.
-- Prices are data set by an administrator per region; none are seeded,
-- because pricing is still to be decided after market testing.

CREATE TABLE plans (
  code          text PRIMARY KEY,
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('free', 'pass')),
  duration_days integer CHECK (duration_days > 0),
  active        boolean NOT NULL DEFAULT true,
  sort          smallint NOT NULL DEFAULT 0,
  CHECK ((kind = 'free') = (duration_days IS NULL))
);
INSERT INTO plans (code, name, kind, duration_days, sort) VALUES
  ('free', 'Free', 'free', NULL, 0),
  ('pass30', '30-day pass', 'pass', 30, 1),
  ('pass90', '90-day pass', 'pass', 90, 2);

CREATE TABLE plan_prices (
  plan_code        text NOT NULL REFERENCES plans(code),
  region           text NOT NULL CHECK (region IN ('EG', 'GULF', 'INTL')),
  currency         char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor     integer NOT NULL CHECK (amount_minor >= 0),
  store_product_id text UNIQUE,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_code, region)
);

CREATE TABLE entitlements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_code    text NOT NULL REFERENCES plans(code),
  source       text NOT NULL CHECK (source IN ('access_code', 'admin_grant', 'store_apple', 'store_google', 'web')),
  external_ref text,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  granted_by   uuid REFERENCES users(id),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  -- One entitlement per store transaction or access code, however often it is sent.
  UNIQUE (source, external_ref)
);
CREATE INDEX entitlements_user_idx ON entitlements (user_id, ends_at DESC);

CREATE TABLE access_codes (
  code_hash   text PRIMARY KEY,
  plan_code   text NOT NULL REFERENCES plans(code),
  days        integer NOT NULL CHECK (days BETWEEN 1 AND 365),
  batch_label text NOT NULL,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  redeemed_by uuid REFERENCES users(id),
  redeemed_at timestamptz
);
CREATE INDEX access_codes_batch_idx ON access_codes (batch_label);

-- The access a user has at a given time. Passes stack: a new one starts when
-- the current one ends.
CREATE FUNCTION user_access(p_user uuid, p_now timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'entitled', e.id IS NOT NULL,
    'planCode', coalesce(e.plan_code, 'free'),
    'endsAt', (SELECT max(ends_at) FROM entitlements WHERE user_id = p_user AND ends_at > p_now),
    'practiceUsedToday', (SELECT count(*) FROM practice_answers
                          WHERE user_id = p_user AND answered_at >= date_trunc('day', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (SELECT * FROM entitlements WHERE user_id = p_user AND starts_at <= p_now AND ends_at > p_now
                     ORDER BY ends_at DESC LIMIT 1) e ON true;
$$;

-- Grants a pass. Returns false when this source and reference were already granted.
CREATE FUNCTION grant_entitlement(p_user uuid, p_plan text, p_source text, p_ref text, p_days integer,
                                  p_now timestamptz, p_actor uuid, p_note text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  start_at timestamptz;
  e_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM plans WHERE code = p_plan AND kind = 'pass') THEN RAISE EXCEPTION 'E_UNKNOWN_PLAN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user AND status = 'active') THEN RAISE EXCEPTION 'E_NOT_FOUND'; END IF;
  PERFORM 1 FROM users WHERE id = p_user FOR UPDATE;
  SELECT greatest(p_now, coalesce(max(ends_at), p_now)) INTO start_at FROM entitlements WHERE user_id = p_user;
  INSERT INTO entitlements (user_id, plan_code, source, external_ref, starts_at, ends_at, granted_by, note)
  VALUES (p_user, p_plan, p_source, p_ref, start_at, start_at + make_interval(days => p_days), p_actor, p_note)
  ON CONFLICT (source, external_ref) DO NOTHING
  RETURNING id INTO e_id;
  IF e_id IS NULL THEN RETURN false; END IF;
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, after)
  VALUES (coalesce(p_actor, p_user), 'access.grant', 'entitlement', e_id::text,
          jsonb_build_object('user', p_user, 'plan', p_plan, 'source', p_source, 'days', p_days));
  RETURN true;
END $$;

CREATE FUNCTION create_access_codes(p_actor uuid, p_plan text, p_days integer, p_hashes jsonb, p_label text, p_expires timestamptz)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM plans WHERE code = p_plan AND kind = 'pass') THEN RAISE EXCEPTION 'E_UNKNOWN_PLAN'; END IF;
  INSERT INTO access_codes (code_hash, plan_code, days, batch_label, created_by, expires_at)
  SELECT h, p_plan, p_days, p_label, p_actor, p_expires FROM jsonb_array_elements_text(p_hashes) h;
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, after)
  VALUES (p_actor, 'access.codes_created', 'access_code_batch', p_label,
          jsonb_build_object('plan', p_plan, 'days', p_days, 'count', n));
  RETURN n;
END $$;

-- Redeems a code once. The lock makes two simultaneous redemptions of one code impossible.
CREATE FUNCTION redeem_access_code(p_user uuid, p_hash text, p_now timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  c access_codes%ROWTYPE;
BEGIN
  SELECT * INTO c FROM access_codes WHERE code_hash = p_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'E_CODE_INVALID'; END IF;
  IF c.redeemed_by IS NOT NULL THEN RAISE EXCEPTION 'E_CODE_USED'; END IF;
  IF c.expires_at IS NOT NULL AND c.expires_at <= p_now THEN RAISE EXCEPTION 'E_CODE_EXPIRED'; END IF;
  UPDATE access_codes SET redeemed_by = p_user, redeemed_at = p_now WHERE code_hash = p_hash;
  PERFORM grant_entitlement(p_user, c.plan_code, 'access_code', p_hash, c.days, p_now, NULL, c.batch_label);
  RETURN user_access(p_user, p_now);
END $$;

CREATE FUNCTION plans_json(p_region text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'code', p.code, 'name', p.name, 'kind', p.kind, 'durationDays', p.duration_days,
           'price', CASE WHEN pp.plan_code IS NULL THEN NULL
                         ELSE jsonb_build_object('currency', pp.currency, 'amountMinor', pp.amount_minor,
                                                 'storeProductId', pp.store_product_id) END) ORDER BY p.sort), '[]'::jsonb)
  FROM plans p LEFT JOIN plan_prices pp ON pp.plan_code = p.code AND pp.region = p_region
  WHERE p.active;
$$;

CREATE FUNCTION admin_plans_json() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'code', p.code, 'name', p.name, 'kind', p.kind, 'durationDays', p.duration_days, 'active', p.active,
           'prices', coalesce((SELECT jsonb_agg(jsonb_build_object('region', x.region, 'currency', x.currency,
                                 'amountMinor', x.amount_minor, 'storeProductId', x.store_product_id) ORDER BY x.region)
                               FROM plan_prices x WHERE x.plan_code = p.code), '[]'::jsonb)) ORDER BY p.sort), '[]'::jsonb)
  FROM plans p;
$$;

CREATE FUNCTION set_plan_price(p_actor uuid, p_plan text, p_region text, p_currency text, p_amount integer, p_product text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM plans WHERE code = p_plan AND kind = 'pass') THEN RAISE EXCEPTION 'E_UNKNOWN_PLAN'; END IF;
  INSERT INTO plan_prices (plan_code, region, currency, amount_minor, store_product_id)
  VALUES (p_plan, p_region, p_currency, p_amount, p_product)
  ON CONFLICT (plan_code, region) DO UPDATE
  SET currency = EXCLUDED.currency, amount_minor = EXCLUDED.amount_minor,
      store_product_id = EXCLUDED.store_product_id, updated_at = now();
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, after)
  VALUES (p_actor, 'plan.price', 'plan', p_plan,
          jsonb_build_object('region', p_region, 'currency', p_currency, 'amountMinor', p_amount, 'storeProductId', p_product));
END $$;

CREATE FUNCTION plan_for_product(p_product text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('planCode', p.code, 'days', p.duration_days)
  FROM plan_prices pp JOIN plans p ON p.code = pp.plan_code
  WHERE pp.store_product_id = p_product AND p.active;
$$;
