import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
const allowedDomain = process.env.CRM_ALLOWED_DOMAIN ?? 'automationsystems.org';
const email = (process.argv[2] ?? process.env.CRM_ADMIN_EMAIL ?? '').trim().toLowerCase();
const name = (process.argv[3] ?? process.env.CRM_ADMIN_NAME ?? 'Administrator').trim();

if (!databaseUrl) {
  console.error('DATABASE_URL is required to seed an admin user.');
  process.exit(1);
}

if (!email) {
  console.error('Usage: node scripts/seed-admin.mjs admin@automationsystems.org "Admin Name"');
  process.exit(1);
}

if (!email.endsWith(`@${allowedDomain}`)) {
  console.error(`Admin email must belong to ${allowedDomain}.`);
  process.exit(1);
}

if (!name) {
  console.error('Admin name cannot be blank.');
  process.exit(1);
}

const sql = postgres(databaseUrl, { prepare: false });

try {
  await sql`
    insert into public.users(email, name, role, allowed_tags, active, added_by)
    values (${email}, ${name}, 'L6', array['*'], true, 'seed-admin')
    on conflict (email) do update
    set
      name = excluded.name,
      role = 'L6',
      allowed_tags = array['*'],
      active = true,
      updated_at = now()
  `;

  console.log(`Seeded L6 admin ${email}`);
} finally {
  await sql.end();
}
