-- One manually provisioned owner, including inactive accounts. Refuse ambiguous
-- legacy databases rather than deleting accounts or choosing an arbitrary owner.
CREATE UNIQUE INDEX uq_app_users_single_owner ON app_users ((TRUE));

-- Global login attempt budget survives restart and cannot be bypassed by
-- changing login/IP. A fresh budget starts only after the UTC DB deadline.
CREATE TABLE auth_login_budget (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  window_started_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 0)
);
