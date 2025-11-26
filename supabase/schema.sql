-- pup.ai Supabase Schema
-- Run this in your Supabase SQL editor

-- Enable pgvector extension
create extension if not exists vector;

-- Users table - track Slack users
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  slack_id text unique not null,
  display_name text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- User facts - memories/facts about users with vector embeddings
create table if not exists user_facts (
  id uuid primary key default gen_random_uuid(),
  user_slack_id text not null references users(slack_id) on delete cascade,
  fact text not null,
  embedding vector(1536),
  source_channel text,
  created_at timestamptz default now()
);

-- Create index for fast vector similarity search
create index if not exists user_facts_embedding_idx
  on user_facts using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Index for looking up facts by user
create index if not exists user_facts_user_idx on user_facts(user_slack_id);

-- Function to search similar facts using cosine similarity
create or replace function search_user_facts(
  query_embedding vector(1536),
  match_threshold float default 0.7,
  match_count int default 5,
  target_user_slack_id text default null
)
returns table (
  id uuid,
  user_slack_id text,
  fact text,
  similarity float,
  created_at timestamptz
)
language plpgsql
as $$
begin
  return query
  select
    uf.id,
    uf.user_slack_id,
    uf.fact,
    1 - (uf.embedding <=> query_embedding) as similarity,
    uf.created_at
  from user_facts uf
  where
    (target_user_slack_id is null or uf.user_slack_id = target_user_slack_id)
    and 1 - (uf.embedding <=> query_embedding) > match_threshold
  order by uf.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- Function to update updated_at timestamp
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Trigger for users table
drop trigger if exists users_updated_at on users;
create trigger users_updated_at
  before update on users
  for each row
  execute function update_updated_at();

-- Row Level Security (optional but recommended)
alter table users enable row level security;
alter table user_facts enable row level security;

-- Allow service role full access
create policy "Service role has full access to users"
  on users for all
  using (true)
  with check (true);

create policy "Service role has full access to user_facts"
  on user_facts for all
  using (true)
  with check (true);
