/**
 * Points the app's DB client at TEST_DATABASE_URL (a separate database that
 * the suites wipe and reseed). Import this FIRST in any integration test.
 */
import "../../scripts/load-env";

export const testDbUrl = process.env.TEST_DATABASE_URL;
if (testDbUrl) process.env.DATABASE_URL = testDbUrl;
export const hasTestDb = Boolean(testDbUrl);
