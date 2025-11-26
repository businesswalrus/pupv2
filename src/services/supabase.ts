import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';

export interface User {
  id: string;
  slack_id: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserFact {
  id: string;
  user_slack_id: string;
  fact: string;
  embedding?: number[];
  source_channel: string | null;
  created_at: string;
}

export interface SearchResult {
  id: string;
  user_slack_id: string;
  fact: string;
  similarity: number;
  created_at: string;
}

let supabase: SupabaseClient | null = null;

export function initializeSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
  }

  supabase = createClient(url, key);
  logger.info('Supabase client initialized');
  return supabase;
}

export function getSupabase(): SupabaseClient {
  if (!supabase) {
    throw new Error('Supabase not initialized. Call initializeSupabase() first.');
  }
  return supabase;
}

// Ensure user exists in database
export async function ensureUser(slackId: string, displayName?: string): Promise<User> {
  const client = getSupabase();

  // Try to get existing user
  const { data: existing } = await client
    .from('users')
    .select('*')
    .eq('slack_id', slackId)
    .single();

  if (existing) {
    // Update display name if provided and different
    if (displayName && displayName !== existing.display_name) {
      await client
        .from('users')
        .update({ display_name: displayName })
        .eq('slack_id', slackId);
    }
    return existing as User;
  }

  // Create new user
  const { data: newUser, error } = await client
    .from('users')
    .insert({ slack_id: slackId, display_name: displayName })
    .select()
    .single();

  if (error) {
    logger.error('Failed to create user', { slackId, error });
    throw error;
  }

  logger.info('Created new user', { slackId, displayName });
  return newUser as User;
}

// Store a fact about a user with embedding
export async function storeFact(
  userSlackId: string,
  fact: string,
  embedding: number[],
  sourceChannel?: string
): Promise<UserFact> {
  const client = getSupabase();

  const { data, error } = await client
    .from('user_facts')
    .insert({
      user_slack_id: userSlackId,
      fact,
      embedding,
      source_channel: sourceChannel,
    })
    .select()
    .single();

  if (error) {
    logger.error('Failed to store fact', { userSlackId, error });
    throw error;
  }

  logger.debug('Stored fact', { userSlackId, fact: fact.substring(0, 50) });
  return data as UserFact;
}

// Search for relevant facts using vector similarity
export async function searchFacts(
  queryEmbedding: number[],
  options: {
    userSlackId?: string;
    threshold?: number;
    limit?: number;
  } = {}
): Promise<SearchResult[]> {
  const client = getSupabase();
  const { userSlackId, threshold = 0.6, limit = 5 } = options;

  const { data, error } = await client.rpc('search_user_facts', {
    query_embedding: queryEmbedding,
    match_threshold: threshold,
    match_count: limit,
    target_user_slack_id: userSlackId || null,
  });

  if (error) {
    logger.error('Failed to search facts', { error });
    return [];
  }

  return (data || []) as SearchResult[];
}

// Get all facts for a specific user
export async function getUserFacts(userSlackId: string, limit = 20): Promise<UserFact[]> {
  const client = getSupabase();

  const { data, error } = await client
    .from('user_facts')
    .select('*')
    .eq('user_slack_id', userSlackId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('Failed to get user facts', { userSlackId, error });
    return [];
  }

  return (data || []) as UserFact[];
}

// Delete all data for a user (privacy/GDPR)
export async function deleteUserData(slackId: string): Promise<void> {
  const client = getSupabase();

  // Facts are deleted via cascade when user is deleted
  const { error } = await client
    .from('users')
    .delete()
    .eq('slack_id', slackId);

  if (error) {
    logger.error('Failed to delete user data', { slackId, error });
    throw error;
  }

  logger.info('Deleted all user data', { slackId });
}

// Get stats for health check
export async function getStats(): Promise<{ users: number; facts: number }> {
  const client = getSupabase();

  const [usersResult, factsResult] = await Promise.all([
    client.from('users').select('*', { count: 'exact', head: true }),
    client.from('user_facts').select('*', { count: 'exact', head: true }),
  ]);

  return {
    users: usersResult.count || 0,
    facts: factsResult.count || 0,
  };
}
