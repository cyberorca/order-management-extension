-- Mock Retail Express POS (demo only, ENABLE_MOCK). Separate schema so a reset
-- never touches sidecar data.
CREATE SCHEMA IF NOT EXISTS {{mock}};

CREATE TABLE {{mock}}.rex_orders (
  order_id     TEXT PRIMARY KEY,
  session_guid TEXT UNIQUE,
  status       TEXT NOT NULL,
  order_total  NUMERIC(12, 2) NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE {{mock}}.rex_order_items (
  seq           SERIAL,
  order_item_id TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES {{mock}}.rex_orders (order_id),
  product_id    INTEGER NOT NULL,
  description   TEXT NOT NULL,
  size          TEXT,
  colour        TEXT,
  plu           TEXT,
  qty           INTEGER NOT NULL,
  unit_price    NUMERIC(12, 2) NOT NULL
);
