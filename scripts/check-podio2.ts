import { Pool } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

(async () => {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: false,
  });
  try {
    // Podio items typically store the address in 'title'. Just check 'title' col on each table.
    const tables = await pool.query<{ table_name: string }>(`
      SELECT t.table_name FROM information_schema.tables t
      JOIN information_schema.columns c
        ON c.table_schema=t.table_schema AND c.table_name=t.table_name
      WHERE t.table_schema='podio' AND c.column_name='title'
      ORDER BY t.table_name
    `);

    const targets = [
      { acct: '11000160703', addr: '1025 N CAREY',  fragment: 'carey' },
      { acct: '11000172980', addr: '2791 1/2 THE ALAMEDA', fragment: 'alameda' },
      { acct: '11000183218', addr: '609 N ELLWOOD', fragment: 'ellwood' },
      { acct: '11000429166', addr: '30-34 SOUTH ST', fragment: 'south st' },
      { acct: '11000457336', addr: '32 SOUTH ST',   fragment: '32 south' },
    ];

    console.log('Searching podio.*.title for each missing water address...\n');
    for (const t of targets) {
      console.log(`──  ${t.acct}  "${t.addr}"`);
      let foundAny = false;
      for (const tbl of tables.rows) {
        const res = await pool.query<{ title: string }>(
          `SELECT title FROM podio."${tbl.table_name}" WHERE title ILIKE $1 LIMIT 3`,
          [`%${t.fragment}%`]
        ).catch(() => ({ rows: [] }));
        if (res.rows.length > 0) {
          foundAny = true;
          for (const r of res.rows) {
            console.log(`    podio.${tbl.table_name}: "${(r.title || '').slice(0, 80)}"`);
          }
        }
      }
      if (!foundAny) console.log('    (no hits in any podio.*.title)');
      console.log();
    }
  } finally {
    await pool.end();
  }
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
