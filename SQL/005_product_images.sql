-- Product photos are external URLs; no upload/storage service is added.
BEGIN;

ALTER TABLE product
  ADD COLUMN IF NOT EXISTS image_url TEXT
  CONSTRAINT product_image_url_scheme CHECK (image_url IS NULL OR image_url ~ '^https?://');

COMMIT;
