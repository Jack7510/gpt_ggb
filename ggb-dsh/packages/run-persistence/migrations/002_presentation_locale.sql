-- Browser-selected run presentation language. Existing durable runs stay English.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS presentation_locale TEXT NOT NULL DEFAULT 'en'
  CHECK (presentation_locale IN ('zh-CN', 'en'));
