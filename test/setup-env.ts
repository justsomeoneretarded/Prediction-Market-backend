process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/tinbit_test?schema=public';
process.env.DEMO_MODE = 'true';
process.env.SIGNUP_BONUS = '10000';
process.env.ADMIN_REQUIRE_2FA = 'false';
process.env.FOOTBALL_PROVIDER = 'mock';
