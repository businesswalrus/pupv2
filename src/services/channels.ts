import { runQuery, getQuery } from '../database/connection';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { getRedisService } from './redis';
import OpenAI from 'openai';

export interface ChannelVibe {
  id: string;
  channel_id: string;
  channel_name: string;
  vibe_description: string;
  typical_topics: string[];
  formality_level: number; // 0-1, casual to formal
  humor_tolerance: number; // 0-1
  response_frequency: number; // 0-1, how often to respond organically
  custom_rules: {
    response_threshold?: number;
    max_messages_per_hour?: number;
    banned_topics?: string[];
    preferred_style?: string;
  };
  updated_at: Date;
}

const DEFAULT_VIBE: Omit<ChannelVibe, 'id' | 'channel_id' | 'channel_name' | 'updated_at'> = {
  vibe_description: 'casual and friendly',
  typical_topics: [],
  formality_level: 0.3,
  humor_tolerance: 0.8,
  response_frequency: 0.5,
  custom_rules: {}
};

/**
 * Get or create channel vibe
 */
export async function getChannelVibe(channelId: string, channelName?: string): Promise<ChannelVibe> {
  try {
    // Try cache first
    try {
      const redis = getRedisService();
      const cached = await redis.getCachedChannelVibe(channelId);
      if (cached) {
        logger.debug('Channel vibe retrieved from cache', { channelId });
        return cached;
      }
    } catch (error) {
      // Redis not available, continue to database
    }

    // Check database
    const existing = await getQuery(
      'SELECT * FROM channel_vibes WHERE channel_id = ?',
      [channelId]
    );

    if (existing) {
      const vibe = dbRowToChannelVibe(existing);

      // Update cache
      try {
        const redis = getRedisService();
        await redis.cacheChannelVibe(channelId, vibe, 3600); // 1 hour TTL
      } catch (error) {
        // Redis not available
      }

      return vibe;
    }

    // Create new channel vibe with defaults
    const vibeId = uuidv4();
    const now = new Date().toISOString();

    await runQuery(`
      INSERT INTO channel_vibes (
        id, channel_id, channel_name, vibe_description,
        typical_topics, formality_level, humor_tolerance,
        response_frequency, custom_rules, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      vibeId,
      channelId,
      channelName || channelId,
      DEFAULT_VIBE.vibe_description,
      JSON.stringify(DEFAULT_VIBE.typical_topics),
      DEFAULT_VIBE.formality_level,
      DEFAULT_VIBE.humor_tolerance,
      DEFAULT_VIBE.response_frequency,
      JSON.stringify(DEFAULT_VIBE.custom_rules),
      now
    ]);

    logger.info('Created new channel vibe with defaults', { channelId, vibeId });

    return {
      id: vibeId,
      channel_id: channelId,
      channel_name: channelName || channelId,
      ...DEFAULT_VIBE,
      updated_at: new Date(now)
    };
  } catch (error) {
    logger.error('Failed to get channel vibe', error);
    // Return default vibe as fallback
    return {
      id: 'default',
      channel_id: channelId,
      channel_name: channelName || channelId,
      ...DEFAULT_VIBE,
      updated_at: new Date()
    };
  }
}

/**
 * Analyze and update channel vibe based on recent messages
 * This should be called periodically (e.g., every 50 messages or daily)
 */
export async function analyzeAndUpdateChannelVibe(
  channelId: string,
  recentMessages: Array<{ text: string; user: string; timestamp: string }>
): Promise<void> {
  try {
    if (recentMessages.length < 10) {
      logger.debug('Not enough messages to analyze channel vibe', { channelId, count: recentMessages.length });
      return;
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Build prompt for AI to analyze channel vibe
    const messageTexts = recentMessages.slice(-50).map(m => m.text).join('\n---\n');

    const systemPrompt = `Analyze these Slack messages to determine the channel's vibe and culture.
Return JSON with:
- vibe_description: Brief description (e.g., "professional and focused", "casual banter", "technical discussions")
- typical_topics: Array of common topics discussed (max 5)
- formality_level: 0-1 (0 = very casual/memes, 1 = very formal/business)
- humor_tolerance: 0-1 (0 = serious only, 1 = jokes welcome)
- response_frequency: 0-1 (suggested bot activity level based on message volume and culture)

Be concise and accurate.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Channel messages:\n\n${messageTexts}` }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 300
    });

    const analysis = JSON.parse(response.choices[0]?.message?.content || '{}');

    // Update database
    await runQuery(`
      UPDATE channel_vibes
      SET
        vibe_description = ?,
        typical_topics = ?,
        formality_level = ?,
        humor_tolerance = ?,
        response_frequency = ?,
        updated_at = datetime('now')
      WHERE channel_id = ?
    `, [
      analysis.vibe_description || DEFAULT_VIBE.vibe_description,
      JSON.stringify(analysis.typical_topics || []),
      analysis.formality_level ?? DEFAULT_VIBE.formality_level,
      analysis.humor_tolerance ?? DEFAULT_VIBE.humor_tolerance,
      analysis.response_frequency ?? DEFAULT_VIBE.response_frequency,
      channelId
    ]);

    // Invalidate cache
    try {
      const redis = getRedisService();
      await redis.invalidateCache(`channel:${channelId}:vibe`);
    } catch (error) {
      // Redis not available
    }

    logger.info('Updated channel vibe', {
      channelId,
      vibe: analysis.vibe_description,
      formality: analysis.formality_level,
      humor: analysis.humor_tolerance
    });
  } catch (error) {
    logger.error('Failed to analyze channel vibe', error);
  }
}

/**
 * Manually update channel vibe settings
 */
export async function updateChannelVibe(
  channelId: string,
  updates: Partial<Omit<ChannelVibe, 'id' | 'channel_id' | 'updated_at'>>
): Promise<void> {
  try {
    // Ensure channel exists
    await getChannelVibe(channelId);

    // Build update query dynamically
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.vibe_description !== undefined) {
      fields.push('vibe_description = ?');
      values.push(updates.vibe_description);
    }
    if (updates.typical_topics !== undefined) {
      fields.push('typical_topics = ?');
      values.push(JSON.stringify(updates.typical_topics));
    }
    if (updates.formality_level !== undefined) {
      fields.push('formality_level = ?');
      values.push(updates.formality_level);
    }
    if (updates.humor_tolerance !== undefined) {
      fields.push('humor_tolerance = ?');
      values.push(updates.humor_tolerance);
    }
    if (updates.response_frequency !== undefined) {
      fields.push('response_frequency = ?');
      values.push(updates.response_frequency);
    }
    if (updates.custom_rules !== undefined) {
      fields.push('custom_rules = ?');
      values.push(JSON.stringify(updates.custom_rules));
    }

    if (fields.length === 0) return;

    fields.push('updated_at = datetime("now")');
    values.push(channelId);

    await runQuery(
      `UPDATE channel_vibes SET ${fields.join(', ')} WHERE channel_id = ?`,
      values
    );

    // Invalidate cache
    try {
      const redis = getRedisService();
      await redis.invalidateCache(`channel:${channelId}:vibe`);
    } catch (error) {
      // Redis not available
    }

    logger.info('Manually updated channel vibe', { channelId, fields: Object.keys(updates) });
  } catch (error) {
    logger.error('Failed to update channel vibe', error);
  }
}

// Helper function to convert database row to ChannelVibe
function dbRowToChannelVibe(row: any): ChannelVibe {
  return {
    id: row.id,
    channel_id: row.channel_id,
    channel_name: row.channel_name,
    vibe_description: row.vibe_description,
    typical_topics: JSON.parse(row.typical_topics || '[]'),
    formality_level: row.formality_level,
    humor_tolerance: row.humor_tolerance,
    response_frequency: row.response_frequency,
    custom_rules: JSON.parse(row.custom_rules || '{}'),
    updated_at: new Date(row.updated_at)
  };
}
