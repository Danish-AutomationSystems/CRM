// Temporary: seeds synthetic cases to measure how dashboard cost scales with
// row count. Every row is prefixed LOADTEST- so cleanup is exact.
const postgres = require('postgres');

const sql = postgres(
  'postgresql://postgres.cympxjsqetzivwxwbhob:CRMAUTOMATION2026@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require',
  { ssl: 'require', prepare: false, max: 1, connect_timeout: 20 }
);

const STAGES = ['Opportunity', 'Lead', 'Quoted'];
const target = Number(process.argv[2] || 0);
const cleanup = process.argv[2] === 'clean';

(async () => {
  try {
    await sql`set statement_timeout = '120s'`;

    if (cleanup) {
      const del = await sql`delete from public.cases where case_id like 'LOADTEST-%'`;
      console.log('deleted seeded rows:', del.count);
      const n = await sql`select count(*)::int n from public.cases`;
      console.log('cases remaining:', n[0].n);
      return;
    }

    const customers = await sql`select customer_id from public.customers`;
    const ids = customers.map((c) => c.customer_id);
    const existing = await sql`select count(*)::int n from public.cases where case_id like 'LOADTEST-%'`;
    const have = existing[0].n;
    const need = target - have;

    if (need <= 0) {
      console.log(`already at ${have} seeded rows; nothing to do`);
      return;
    }

    const rows = Array.from({ length: need }, (_, i) => {
      const seq = have + i + 1;
      return {
        case_id: `LOADTEST-${String(seq).padStart(6, '0')}`,
        customer_id: ids[seq % ids.length],
        title: `Load test case ${seq}`,
        details: 'Synthetic row for capacity measurement.',
        source: 'Direct',
        stage: STAGES[seq % STAGES.length],
        won_categories: [],
        outcome_note: '',
        created_by: 'danish@automationsystems.org',
        priority: 'Medium',
        version: 1
      };
    });

    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await sql`insert into public.cases ${sql(rows.slice(i, i + CHUNK))}`;
      process.stdout.write(`\rinserted ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
    }
    console.log();

    const n = await sql`select count(*)::int n from public.cases`;
    console.log('total cases now:', n[0].n);
  } catch (e) {
    console.log('ERR', e.message);
  } finally {
    await sql.end();
  }
})();
