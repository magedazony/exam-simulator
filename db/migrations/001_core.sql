-- PMP Exam Simulator: core PostgreSQL schema (MVP scope).
-- Covers identity, blueprint, content, review, exams and audit.
-- Commerce, study plans and AI tables are added in their own migrations.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- identity
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            citext NOT NULL UNIQUE,
  password_hash    text NOT NULL,
  display_name     text,
  country_code     char(2),
  language         text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ar')),
  exam_target_date date,
  weekly_study_hours smallint CHECK (weekly_study_hours BETWEEN 0 AND 100),
  email_verified_at timestamptz,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id   smallint PRIMARY KEY,
  code text NOT NULL UNIQUE
);
INSERT INTO roles (id, code) VALUES
  (1, 'student'), (2, 'content_author'), (3, 'content_reviewer'), (4, 'administrator');

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id smallint NOT NULL REFERENCES roles(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,
  device_label       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- --------------------------------------------------------------- blueprint
CREATE TABLE exam_blueprints (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL,
  version          integer NOT NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  effective_from   date NOT NULL,
  total_questions  integer NOT NULL CHECK (total_questions > 0),
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  min_per_task     integer NOT NULL DEFAULT 1 CHECK (min_per_task >= 0),
  domain_tolerance_questions integer NOT NULL DEFAULT 1 CHECK (domain_tolerance_questions >= 0),
  partial_credit   boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);
-- Only one active version per blueprint code.
CREATE UNIQUE INDEX exam_blueprints_one_active ON exam_blueprints (code) WHERE status = 'active';

CREATE TABLE domains (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_id uuid NOT NULL REFERENCES exam_blueprints(id) ON DELETE CASCADE,
  code         text NOT NULL,
  name         text NOT NULL,
  weight_pct   numeric(5,2) NOT NULL CHECK (weight_pct > 0 AND weight_pct <= 100),
  ordinal      smallint NOT NULL,
  UNIQUE (blueprint_id, code),
  UNIQUE (blueprint_id, ordinal)
);

CREATE TABLE tasks (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id uuid NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  code      text NOT NULL,
  name      text NOT NULL,
  ordinal   smallint NOT NULL,
  UNIQUE (domain_id, code),
  UNIQUE (domain_id, ordinal)
);

CREATE TABLE approaches       (code text PRIMARY KEY, name text NOT NULL);
CREATE TABLE difficulty_levels (code text PRIMARY KEY, name text NOT NULL, ordinal smallint NOT NULL UNIQUE);
CREATE TABLE question_types   (code text PRIMARY KEY, name text NOT NULL, enabled boolean NOT NULL DEFAULT true);
INSERT INTO approaches VALUES ('predictive', 'Predictive'), ('agile', 'Adaptive / agile'), ('hybrid', 'Hybrid');
INSERT INTO difficulty_levels VALUES ('easy', 'Easy', 1), ('medium', 'Medium', 2), ('hard', 'Hard', 3);
INSERT INTO question_types VALUES ('single', 'Multiple choice, single response', true),
                                  ('multiple', 'Multiple response', true);

CREATE TABLE blueprint_mix_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_id  uuid NOT NULL REFERENCES exam_blueprints(id) ON DELETE CASCADE,
  dimension     text NOT NULL CHECK (dimension IN ('approach', 'difficulty', 'type', 'graphic')),
  keys          text[] NOT NULL CHECK (cardinality(keys) > 0),
  target_pct    numeric(5,2) NOT NULL CHECK (target_pct BETWEEN 0 AND 100),
  tolerance_pct numeric(5,2) NOT NULL CHECK (tolerance_pct >= 0),
  source        text NOT NULL CHECK (source IN ('official', 'house'))
);

CREATE TABLE blueprint_sections (
  blueprint_id        uuid NOT NULL REFERENCES exam_blueprints(id) ON DELETE CASCADE,
  ordinal             smallint NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('case', 'independent')),
  question_count      integer NOT NULL CHECK (question_count > 0),
  break_after_minutes integer NOT NULL DEFAULT 0 CHECK (break_after_minutes >= 0),
  PRIMARY KEY (blueprint_id, ordinal)
);

-- ----------------------------------------------------------------- content
CREATE TABLE case_studies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_code text NOT NULL UNIQUE,
  title       text NOT NULL,
  scenario    text NOT NULL,
  language    text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ar')),
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'withdrawn')),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE questions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_code        text NOT NULL UNIQUE,
  current_version_id uuid,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'withdrawn', 'archived')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE question_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id    uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  version_no     integer NOT NULL CHECK (version_no > 0),
  task_id        uuid NOT NULL REFERENCES tasks(id),
  approach_code  text NOT NULL REFERENCES approaches(code),
  difficulty_code text NOT NULL REFERENCES difficulty_levels(code),
  type_code      text NOT NULL REFERENCES question_types(code),
  is_graphic     boolean NOT NULL DEFAULT false,
  case_study_id  uuid REFERENCES case_studies(id),
  case_ordinal   smallint,
  language       text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ar')),
  stem           text NOT NULL,
  body           jsonb NOT NULL DEFAULT '{}'::jsonb,
  workflow_state text NOT NULL DEFAULT 'draft'
                 CHECK (workflow_state IN ('draft', 'submitted', 'expert_review', 'language_qa',
                                           'approved', 'published', 'withdrawn')),
  ai_assisted    boolean NOT NULL DEFAULT false,
  originality_declared_at timestamptz,
  author_id      uuid NOT NULL REFERENCES users(id),
  published_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (question_id, version_no),
  CHECK ((case_study_id IS NULL) = (case_ordinal IS NULL)),
  CHECK (workflow_state <> 'published' OR published_at IS NOT NULL)
);
ALTER TABLE questions
  ADD CONSTRAINT questions_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES question_versions(id) DEFERRABLE INITIALLY DEFERRED;

-- Selection index used by the exam generator.
CREATE INDEX question_versions_selection_idx
  ON question_versions (task_id, approach_code, difficulty_code, type_code)
  WHERE workflow_state = 'published';
CREATE INDEX question_versions_workflow_idx ON question_versions (workflow_state, author_id);

CREATE TABLE options (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_version_id uuid NOT NULL REFERENCES question_versions(id) ON DELETE CASCADE,
  ordinal             smallint NOT NULL,
  text                text NOT NULL,
  is_correct          boolean NOT NULL,
  rationale           text,
  UNIQUE (question_version_id, ordinal)
);

CREATE TABLE explanations (
  question_version_id uuid NOT NULL REFERENCES question_versions(id) ON DELETE CASCADE,
  language            text NOT NULL CHECK (language IN ('en', 'ar')),
  why_correct         text NOT NULL,
  mindset             text,
  key_concept         text,
  learning_objective  text,
  PRIMARY KEY (question_version_id, language)
);

CREATE TABLE content_references (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  section     text,
  source_type text NOT NULL CHECK (source_type IN ('official_pmi', 'original', 'third_party'))
);
CREATE TABLE question_references (
  question_version_id uuid NOT NULL REFERENCES question_versions(id) ON DELETE CASCADE,
  reference_id        uuid NOT NULL REFERENCES content_references(id),
  PRIMARY KEY (question_version_id, reference_id)
);

CREATE TABLE reviews (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_version_id uuid NOT NULL REFERENCES question_versions(id) ON DELETE CASCADE,
  reviewer_id         uuid NOT NULL REFERENCES users(id),
  gate                text NOT NULL CHECK (gate IN ('expert_review', 'language_qa')),
  decision            text NOT NULL CHECK (decision IN ('approved', 'returned')),
  checklist           jsonb NOT NULL,
  comment             text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (decision <> 'returned' OR comment IS NOT NULL)
);
CREATE INDEX reviews_version_idx ON reviews (question_version_id);

-- A reviewer may never review their own work.
CREATE FUNCTION reviews_block_self_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM question_versions v
             WHERE v.id = NEW.question_version_id AND v.author_id = NEW.reviewer_id) THEN
    RAISE EXCEPTION 'authors cannot review their own question versions';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reviews_no_self_review BEFORE INSERT OR UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION reviews_block_self_review();

-- Published versions are immutable; only withdrawal is allowed.
CREATE FUNCTION question_versions_freeze_published() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.workflow_state = 'published' THEN
    IF NEW.workflow_state = 'withdrawn'
       AND (to_jsonb(NEW) - 'workflow_state') = (to_jsonb(OLD) - 'workflow_state') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'published question versions are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER question_versions_immutable BEFORE UPDATE ON question_versions
  FOR EACH ROW EXECUTE FUNCTION question_versions_freeze_published();

-- A version can be published only with a valid answer key.
CREATE FUNCTION question_versions_require_key() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  total integer;
  correct integer;
BEGIN
  IF NEW.workflow_state = 'published' AND OLD.workflow_state <> 'published' THEN
    SELECT count(*), count(*) FILTER (WHERE is_correct) INTO total, correct
    FROM options WHERE question_version_id = NEW.id;
    IF total < 2
       OR (NEW.type_code = 'single' AND correct <> 1)
       OR (NEW.type_code = 'multiple' AND (correct < 2 OR correct >= total)) THEN
      RAISE EXCEPTION 'question version % has no valid answer key', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER question_versions_key_check BEFORE UPDATE ON question_versions
  FOR EACH ROW EXECUTE FUNCTION question_versions_require_key();

-- ------------------------------------------------------------------- exams
CREATE TABLE exam_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blueprint_id  uuid NOT NULL REFERENCES exam_blueprints(id),
  seed          bigint NOT NULL,
  state         text NOT NULL DEFAULT 'in_progress'
                CHECK (state IN ('in_progress', 'on_break', 'submitted', 'expired')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  deadline_at   timestamptz NOT NULL,
  submitted_at  timestamptz,
  score_percent numeric(5,2),
  result        jsonb,
  CHECK (deadline_at > started_at)
);
-- One active mock per candidate.
CREATE UNIQUE INDEX exam_attempts_one_active
  ON exam_attempts (user_id) WHERE state IN ('in_progress', 'on_break');
CREATE INDEX exam_attempts_user_idx ON exam_attempts (user_id, started_at DESC);

CREATE TABLE attempt_sections (
  attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
  ordinal    smallint NOT NULL,
  state      text NOT NULL DEFAULT 'locked' CHECK (state IN ('locked', 'open', 'closed')),
  opened_at  timestamptz,
  closed_at  timestamptz,
  PRIMARY KEY (attempt_id, ordinal)
);

CREATE TABLE attempt_questions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id          uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
  ordinal             integer NOT NULL CHECK (ordinal > 0),
  section_ordinal     smallint NOT NULL,
  question_id         uuid NOT NULL REFERENCES questions(id),
  question_version_id uuid NOT NULL REFERENCES question_versions(id),
  flagged             boolean NOT NULL DEFAULT false,
  UNIQUE (attempt_id, ordinal),
  UNIQUE (attempt_id, question_id),
  FOREIGN KEY (attempt_id, section_ordinal) REFERENCES attempt_sections(attempt_id, ordinal)
);

CREATE TABLE answers (
  attempt_question_id uuid PRIMARY KEY REFERENCES attempt_questions(id) ON DELETE CASCADE,
  response            jsonb NOT NULL,
  is_correct          boolean,
  points              numeric(4,3),
  time_spent_ms       integer NOT NULL DEFAULT 0 CHECK (time_spent_ms >= 0),
  answered_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE practice_answers (
  id                  bigint GENERATED ALWAYS AS IDENTITY,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_version_id uuid NOT NULL REFERENCES question_versions(id),
  response            jsonb NOT NULL,
  is_correct          boolean NOT NULL,
  time_spent_ms       integer NOT NULL DEFAULT 0 CHECK (time_spent_ms >= 0),
  answered_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, answered_at)
) PARTITION BY RANGE (answered_at);
CREATE TABLE practice_answers_default PARTITION OF practice_answers DEFAULT;
CREATE INDEX practice_answers_user_idx ON practice_answers (user_id, answered_at DESC);

-- ------------------------------------------------------------------- audit
CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    uuid REFERENCES users(id),
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  before      jsonb,
  after       jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, at DESC);

-- Audit rows are append-only.
CREATE FUNCTION audit_logs_block_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END $$;
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_change();
