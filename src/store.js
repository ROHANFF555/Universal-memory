const table = 'universal_memory.memories';
const fields = 'memory_id, content, category, source, created_at, updated_at, version';
export class Problem extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function store(db) {
  async function query(sql, args) {
    try { return (await db.query(sql, args)).rows; }
    catch (e) {
      if (e.code === '23505' && e.constraint === 'memory_dedup') throw new Problem(409, 'A matching memory already exists');
      throw e;
    }
  }
  return {
    async save({content, category}, source) {
      const [row] = await query(`insert into ${table} (content,category,source) values ($1,$2,$3) returning ${fields}`, [content,category,source]);
      return row;
    },
    async get({memory_id}) {
      const [row] = await query(`select ${fields} from ${table} where memory_id=$1 and deleted_at is null`, [memory_id]);
      if (!row) throw new Problem(404, 'Memory not found');
      return row;
    },
    list({q = '', category, limit, offset}) {
      return query(`select ${fields} from ${table} where deleted_at is null and
        strpos(lower(content), lower($1)) > 0 and ($2::text is null or category=$2)
        order by created_at desc, memory_id desc limit $3 offset $4`, [q,category ?? null,limit,offset]);
    },
    async change({memory_id, version, content, category}, remove = false) {
      const [row] = await query(`update ${table} set version=version+1, updated_at=now(),
        content=coalesce($3,content), category=coalesce($4,category),
        deleted_at=case when $5 then now() else null end
        where memory_id=$1 and version=$2 and deleted_at is null returning ${fields}`,
        [memory_id,version,content ?? null,category ?? null,remove]);
      if (!row) {
        await this.get({memory_id});
        throw new Problem(409, 'Version conflict; read the latest memory before retrying');
      }
      return row;
    }
  };
}
