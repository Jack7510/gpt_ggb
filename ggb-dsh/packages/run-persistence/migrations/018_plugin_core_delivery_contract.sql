-- Fix the delivery contract when a run is accepted; receipt runs cannot downgrade.
ALTER TABLE plugin_core_runs ADD COLUMN IF NOT EXISTS delivery_contract TEXT
  NOT NULL DEFAULT 'legacy' CHECK (delivery_contract IN ('legacy', 'receipt-v1'));
