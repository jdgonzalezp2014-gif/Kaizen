import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
console.log((await sql`SELECT email FROM members WHERE role = 'ops' LIMIT 1`)[0].email);
