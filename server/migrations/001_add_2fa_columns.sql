-- Migration: Add 2FA columns to users table
-- Run this migration against your MySQL database

-- Add totp_secret column to store the Base32 encoded TOTP secret
-- Nullable because 2FA is optional
ALTER TABLE users
ADD COLUMN totp_secret VARCHAR(64) NULL AFTER password;

-- Add totp_enabled column to track whether 2FA is enabled for the user
-- Defaults to FALSE since 2FA is optional
ALTER TABLE users
ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT FALSE AFTER totp_secret;

-- Optional: Add an index on totp_enabled for queries filtering by 2FA status
-- CREATE INDEX idx_users_totp_enabled ON users(totp_enabled);
