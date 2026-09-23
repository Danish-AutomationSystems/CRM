// Temporary: seeds customers, handlers and cases at realistic volume to measure
// how the dashboard scales on BOTH dimensions. Everything is prefixed LOADTEST
// so cleanup is exact. `node scripts/_seed_scale.js clean` removes it all.
const postgres = require('postgres');

const sql = postgres(
  'postgresql://postgres.cympxjsqetzivwxwbhob:CRMAUTOMATION2026@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require',
  { ssl: 'require', prepare: false, max: 1, connect_timeout: 20 }
);

const USERS = [
  'danish@automationsystems.org',
  'ajayneb@automationsystems.org',
  'testing@automationsystems.org',
  'himanshuneb@automationsystems.org'
];
const STAGES = ['Opportunity', 'Lead', 'Quoted'];
const TAGS = ['Punjab', 'Chandigarh', 'NCR', 'Geo'];

const mode = process.argv[2];
const customerTarget = Number(process.argv[3] || 10000);
const caseTarget = Number(process.argv[4] || 50000);

async function chunked(rows, size, insert) {
  for (let i = 0; i < rows.length; i += size) {
    await insert(rows.slice(i, i + size));
    process.stdout.write(`\r  ${Math.min(i + size, rows.length)}/${rows.length}`);
  }
  console.log();
}

(async () => {
  try {
    await sql`set statement_timeout = '300s'`;

    if (mode === 'clean') {
      const c = await sql`delete from public.cases where case_id like 'LOADTEST-%'`;
      const h = await sql`delete from public.handlers where customer_id like 'LOADTEST-%'`;
      const cu = await sql`delete from public.customers where customer_id like 'LOADTEST-%'`;
      console.log('deleted cases:', c.count, 'handlers:', h.count, 'customers:', cu.count);
      const counts = await sql`
        select (select count(*)::int from public.cases) cases,
               (select count(*)::int from public.customers) customers,
               (select count(*)::int from public.handlers) handlers`;
      console.log('remaining:', JSON.stringify(counts[0]));
      return;
    }

    const now = new Date();

    console.log(`seeding ${customerTarget} customers...`);
    const customers = Array.from({ length: customerTarget }, (_, i) => {
      const seq = i + 1;
      return {
        customer_id: `LOADTEST-C${String(seq).padStart(6, '0')}`,
        name: `Load Test Company ${seq}`,
        tags: [TAGS[seq % TAGS.length]],
        type: '',
        priority: '',
        area: '',
        address: '',
        gstin: '',
        website: '',
        notes: '',
        sei: [],
        remarks: '',
        status: 'Active',
        created_by: USERS[seq % USERS.length],
        created_at: now,
        updated_at: now,
        version: 1
      };
    });
    await chunked(customers, 500, (batch) => sql`insert into public.customers ${sql(batch)}`);

    console.log('seeding handlers (one per customer, round-robin across users)...');
    const handlers = customers.map((c, i) => ({
      customer_id: c.customer_id,
      user_email: USERS[i % USERS.length],
      assigned_by: USERS[0],
      assigned_at: now
    }));
    await chunked(handlers, 500, (batch) => sql`insert into public.handlers ${sql(batch)}`);

    console.log(`seeding ${caseTarget} cases spread across those customers...`);
    const cases = Array.from({ length: caseTarget }, (_, i) => {
      const seq = i + 1;
      const stage = STAGES[seq % STAGES.length];
      return {
        case_id: `LOADTEST-${String(seq).padStart(7, '0')}`,
        customer_id: customers[seq % customers.length].customer_id,
        title: `Load test case ${seq}`,
        details: 'Synthetic row for capacity measurement.',
        source: 'Direct',
        stage,
        won_categories: '',
        outcome_note: '',
        // cases_quoted_unassigned_check: a Quoted case holds no assignee.
        assignee: stage === 'Quoted' ? null : USERS[seq % USERS.length],
        created_by: USERS[seq % USERS.length],
        priority: 'Medium',
        created_at: now,
        updated_at: now,
        version: 1
      };
    });
    await chunked(cases, 500, (batch) => sql`insert into public.cases ${sql(batch)}`);

    const counts = await sql`
      select (select count(*)::int from public.cases) cases,
             (select count(*)::int from public.customers) customers,
             (select count(*)::int from public.handlers) handlers`;
    console.log('TOTALS:', JSON.stringify(counts[0]));
  } catch (e) {
    console.log('ERR', e.message);
  } finally {
    await sql.end();
  }
})();
