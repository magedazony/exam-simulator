-- Migration 014: Notifications, exam heartbeat, referral codes, coupons
-- Sprint 5 — candidate portal completions

-- ---------------------------------------------------------------- Notifications inbox
CREATE TABLE IF NOT EXISTS notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          text NOT NULL,          -- 'streak_at_risk' | 'plan_ready' | 'exam_result' | 'hint_quota' | 'general'
  title         text NOT NULL,
  title_ar      text,
  body          text,
  body_ar       text,
  action_url    text,                   -- deep-link, e.g. '/app/study-plan'
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;

-- ---------------------------------------------------------------- Exam heartbeat columns
ALTER TABLE exam_attempts
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS time_remaining_ms  int;

-- ---------------------------------------------------------------- Referral codes
CREATE TABLE IF NOT EXISTS referral_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  code          text NOT NULL UNIQUE,
  uses_count    int  NOT NULL DEFAULT 0,
  credits_earned int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Track who used whose code
CREATE TABLE IF NOT EXISTS referral_uses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id    uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  used_at        timestamptz NOT NULL DEFAULT now(),
  credit_granted boolean NOT NULL DEFAULT false
);

-- ---------------------------------------------------------------- Coupons
CREATE TABLE IF NOT EXISTS coupons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  description   text,
  discount_pct  int  NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  active        boolean NOT NULL DEFAULT true,
  max_uses      int  NOT NULL DEFAULT 0,  -- 0 = unlimited
  uses_count    int  NOT NULL DEFAULT 0,
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coupon_applications (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coupon_id  uuid NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, coupon_id)
);

-- ---------------------------------------------------------------- Learner profile streak columns (if not already added)
ALTER TABLE learner_profiles
  ADD COLUMN IF NOT EXISTS longest_streak    int  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_activity_date date;

-- ---------------------------------------------------------------- Helper: send notification to a user
CREATE OR REPLACE FUNCTION notify_user(
  p_user    uuid,
  p_type    text,
  p_title   text,
  p_title_ar text,
  p_body    text DEFAULT NULL,
  p_body_ar text DEFAULT NULL,
  p_action  text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO notifications (user_id, type, title, title_ar, body, body_ar, action_url)
  VALUES (p_user, p_type, p_title, p_title_ar, p_body, p_body_ar, p_action);
END;
$$;

-- ---------------------------------------------------------------- Update streak when study activity recorded
-- Called by refresh_learner_profile; also updates longest_streak.
CREATE OR REPLACE FUNCTION update_streak(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_today        date := current_date;
  v_last         date;
  v_streak       int;
  v_longest      int;
BEGIN
  SELECT streak_days, longest_streak, last_activity_date
    INTO v_streak, v_longest, v_last
  FROM learner_profiles
  WHERE user_id = p_user;

  IF NOT FOUND THEN RETURN; END IF;

  IF v_last IS NULL OR v_last < v_today - 1 THEN
    -- Gap > 1 day: reset streak
    v_streak := 1;
  ELSIF v_last = v_today THEN
    -- Already updated today
    RETURN;
  ELSE
    -- Consecutive day
    v_streak := v_streak + 1;
  END IF;

  v_longest := GREATEST(v_longest, v_streak);

  UPDATE learner_profiles
  SET streak_days = v_streak,
      longest_streak = v_longest,
      last_activity_date = v_today
  WHERE user_id = p_user;

  -- Notify if streak is a milestone
  IF v_streak IN (3, 7, 14, 30, 60, 100) THEN
    PERFORM notify_user(
      p_user,
      'streak_milestone',
      v_streak || '-day streak! 🔥',
      'سلسلة ' || v_streak || ' يوم! 🔥',
      'You''ve studied ' || v_streak || ' days in a row. Keep going!',
      'درست ' || v_streak || ' يوم متتالي. واصل!'
    );
  END IF;
END;
$$;

COMMENT ON TABLE notifications IS 'In-app notification inbox per user';
COMMENT ON TABLE referral_codes IS 'One referral code per user; used to track invitations';
COMMENT ON TABLE coupons IS 'Discount coupons for plan purchases';
