begin;
create schema if not exists universal_memory;
revoke all on schema universal_memory from public;
create table universal_memory.memories (
  memory_id uuid primary key default gen_random_uuid(),
  content text not null,
  category text not null,
  source text not null check (source in ('ChatGPT', 'Claude', 'Arena')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  deleted_at timestamptz
);
create function universal_memory.content_digest(value text) returns bytea
language sql immutable strict set search_path = pg_catalog
return sha256(convert_to(value, 'UTF8'));
create unique index memory_dedup on universal_memory.memories (category, universal_memory.content_digest(content)) where deleted_at is null;
create table universal_memory.history (
  memory_id uuid not null references universal_memory.memories,
  version integer not null,
  snapshot jsonb not null,
  primary key (memory_id, version)
);
create function universal_memory.record_revision() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  insert into universal_memory.history values (new.memory_id, new.version, to_jsonb(new));
  return new;
end;
$$;
create trigger memory_revision after insert or update on universal_memory.memories
for each row execute function universal_memory.record_revision();
commit;
