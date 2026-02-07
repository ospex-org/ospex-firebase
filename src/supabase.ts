/**
 * Supabase Client for ospex-fdb
 *
 * Singleton client for writing odds history data to Supabase.
 * Uses the same credentials pattern as ospex-agent-server.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

let supabaseClient: SupabaseClient | null = null;

/**
 * Get the Supabase client instance (singleton).
 * Uses service role key for full database access.
 */
export function getSupabaseClient(): SupabaseClient {
  if (supabaseClient) {
    return supabaseClient;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      'Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env'
    );
  }

  supabaseClient = createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  console.log('[Supabase] Client initialized');
  return supabaseClient;
}

/**
 * Test the Supabase connection.
 * @returns true if connection is successful
 */
export async function testSupabaseConnection(): Promise<boolean> {
  try {
    const client = getSupabaseClient();
    const { error } = await client.from('odds_history').select('count').limit(1);

    if (error) {
      // Table might not exist yet, that's okay
      if (error.code === '42P01') {
        console.warn('[Supabase] odds_history table not yet created. Run migration first.');
        return true; // Connection works, just no table
      }
      throw error;
    }

    console.log('[Supabase] Connection test successful');
    return true;
  } catch (error) {
    console.error('[Supabase] Connection test failed:', error);
    return false;
  }
}
