-- Sidecar data: only what Retail Express does not hold. No price, SKU, stock,
-- payment, customer or status data (CLAUDE.md data model; status is a future phase).
CREATE SCHEMA IF NOT EXISTS {{sidecar}};

CREATE TABLE {{sidecar}}.staff (
  staff_id      SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  password_hash TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sidecar order: groups lines; every RE order identifier seen is an alias.
CREATE TABLE {{sidecar}}.orders (
  order_ref    SERIAL PRIMARY KEY,
  version      INTEGER NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE {{sidecar}}.order_aliases (
  alias      TEXT PRIMARY KEY,
  order_ref  INTEGER NOT NULL REFERENCES {{sidecar}}.orders (order_ref),
  first_seen TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE {{sidecar}}.wearers (
  wearer_id SERIAL PRIMARY KEY,
  order_ref INTEGER NOT NULL REFERENCES {{sidecar}}.orders (order_ref),
  name      TEXT NOT NULL,
  name_key  TEXT NOT NULL,
  UNIQUE (order_ref, name_key)
);

-- One row per RE line, keyed by OrderItemId alone (a GUID unique across RE).
CREATE TABLE {{sidecar}}.order_links (
  order_item_id        TEXT PRIMARY KEY,
  order_ref            INTEGER NOT NULL REFERENCES {{sidecar}}.orders (order_ref),
  wearer_id            INTEGER REFERENCES {{sidecar}}.wearers (wearer_id),
  parent_order_item_id TEXT,
  note                 TEXT CHECK (note IS NULL OR char_length(note) <= 1000),
  updated_by           INTEGER REFERENCES {{sidecar}}.staff (staff_id),
  updated_at           TIMESTAMPTZ
);
CREATE INDEX order_links_order ON {{sidecar}}.order_links (order_ref);

CREATE TABLE {{sidecar}}.link_audit (
  audit_id      SERIAL PRIMARY KEY,
  order_ref     INTEGER NOT NULL REFERENCES {{sidecar}}.orders (order_ref),
  order_item_id TEXT NOT NULL,
  field         TEXT NOT NULL,
  old_value     TEXT,
  new_value     TEXT,
  staff_id      INTEGER NOT NULL REFERENCES {{sidecar}}.staff (staff_id),
  at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX link_audit_order ON {{sidecar}}.link_audit (order_ref, audit_id);

-- Page health reports from the extension: check results only, no customer data.
CREATE TABLE {{sidecar}}.health_reports (
  id          SERIAL PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ext_version TEXT NOT NULL,
  path        TEXT NOT NULL,
  checks      JSONB NOT NULL
);
