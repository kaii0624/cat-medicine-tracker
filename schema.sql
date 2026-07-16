CREATE TABLE IF NOT EXISTS dose_records (
  date_key TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('morning', 'evening')),
  timestamp TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (date_key, period)
);

CREATE INDEX IF NOT EXISTS idx_dose_records_timestamp
  ON dose_records (timestamp DESC);
