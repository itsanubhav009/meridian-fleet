// Vitest loads this before any test file. Vitest sets NODE_ENV=test itself.
process.env.JWT_SECRET = "test-secret-key-that-is-definitely-long-enough-32";
process.env.JWT_EXPIRES_IN = "1h";
process.env.DATABASE_URL = "pglite://memory";
// Pin the fare rules so assertions do not depend on a developer's .env.local.
process.env.FARE_BASE_CENTS = "4000";
process.env.FARE_PER_KM_CENTS = "1450";
process.env.FARE_MINIMUM_CENTS = "6000";
