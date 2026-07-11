/**
 * One-time, manually-run bootstrap for the very first Admin account. NOT a seeder: it is never
 * invoked by app startup, migrations, or tests -- only by an operator running
 * `npm run create-admin -- --email=... --fullName=... --password=...` once against a fresh
 * database, to resolve the chicken-and-egg problem of "an Admin is needed to create users, but
 * there is no public registration and no seeded users." Every subsequent user (including
 * additional Admins) is created through the real Admin UI/API this script has no other role in.
 *
 * Usage:
 *   npm run create-admin -- --email=admin@example.com --fullName="Jane Admin" --password=Str0ngPass!
 * (password is optional -- a random temp password is generated and printed if omitted)
 */
import 'dotenv/config';
import { pool } from '../src/db/pool';
import { hashPassword, generateTempPassword, validatePasswordPolicy } from '../src/lib/password';

function parseArgs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const email = args.email;
  const fullName = args.fullName;
  if (!email || !fullName) {
    // eslint-disable-next-line no-console
    console.error(
      'Usage: npm run create-admin -- --email=admin@example.com --fullName="Jane Admin" [--password=...]',
    );
    process.exitCode = 1;
    return;
  }

  const [existingRows] = await pool.query('SELECT user_id FROM app_user WHERE email = ?', [email]);
  if ((existingRows as unknown[]).length > 0) {
    // eslint-disable-next-line no-console
    console.error(`A user with email ${email} already exists.`);
    process.exitCode = 1;
    return;
  }

  const [roleRows] = await pool.query("SELECT role_id FROM roles WHERE role_name = 'ADMIN'");
  const adminRoleId = (roleRows as { role_id: number }[])[0]?.role_id;
  if (!adminRoleId) {
    // eslint-disable-next-line no-console
    console.error('No ADMIN role found -- has migration 0009_auth_identity.sql been applied?');
    process.exitCode = 1;
    return;
  }

  const password = args.password ?? generateTempPassword();
  const policyError = validatePasswordPolicy(password);
  if (policyError) {
    // eslint-disable-next-line no-console
    console.error(policyError);
    process.exitCode = 1;
    return;
  }
  const passwordHash = await hashPassword(password);

  const [result] = await pool.query(
    `INSERT INTO app_user
       (email, display_name, company_scope, is_active, password_hash, status,
        must_change_password, role_id)
     VALUES (?, ?, 'ALL', TRUE, ?, 'PENDING_PASSWORD_CHANGE', TRUE, ?)`,
    [email, fullName, passwordHash, adminRoleId],
  );
  const userId = (result as { insertId: number }).insertId;
  await pool.query('INSERT INTO user_role (user_id, role_code) VALUES (?, ?)', [userId, 'BI00_EXECUTIVE']);

  // eslint-disable-next-line no-console
  console.log(`Admin user created: ${email}`);
  if (!args.password) {
    // eslint-disable-next-line no-console
    console.log(`Temporary password: ${password}`);
  }
  // eslint-disable-next-line no-console
  console.log('must_change_password is set -- this account will be forced to set a new password on first login.');
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
