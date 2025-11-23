import { runQuery, getQuery, allQuery } from '../database/connection';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { getRedisService } from './redis';

export interface UserProfile {
  id: string;
  slack_id: string;
  display_name: string;
  personality_traits: {
    humor_style?: string[];
    communication_style?: string;
    interests?: string[];
    quirks?: string[];
  };
  speech_patterns: {
    common_phrases?: string[];
    emoji_usage?: number; // 0-1 scale
    capitalization_style?: 'lowercase' | 'normal' | 'emphasis';
    avg_message_length?: number;
  };
  activity_patterns: {
    active_hours?: number[]; // Hours of day (0-23)
    channel_preferences?: { [channelId: string]: number }; // Activity frequency per channel
    messages_today?: number;
    last_active?: string;
  };
  relationship_summary: string;
  last_seen: Date;
  created_at: Date;
  updated_at: Date;
}

/**
 * Get or create user profile
 */
export async function ensureUserExists(slackId: string, displayName?: string): Promise<UserProfile> {
  try {
    // Try cache first
    try {
      const redis = getRedisService();
      const cached = await redis.getCachedUserProfile(slackId);
      if (cached) {
        logger.debug('User profile retrieved from cache', { slackId });
        return cached;
      }
    } catch (error) {
      // Redis not available, continue to database
    }

    // Check database
    const existing = await getQuery(
      'SELECT * FROM users WHERE slack_id = ?',
      [slackId]
    );

    if (existing) {
      const profile = dbRowToUserProfile(existing);

      // Update cache
      try {
        const redis = getRedisService();
        await redis.cacheUserProfile(slackId, profile, 3600); // 1 hour TTL
      } catch (error) {
        // Redis not available
      }

      return profile;
    }

    // Create new user
    const userId = uuidv4();
    const now = new Date().toISOString();

    await runQuery(`
      INSERT INTO users (
        id, slack_id, display_name, personality_traits,
        speech_patterns, activity_patterns, relationship_summary,
        last_seen, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      userId,
      slackId,
      displayName || slackId,
      JSON.stringify({}),
      JSON.stringify({}),
      JSON.stringify({}),
      'New member',
      now,
      now,
      now
    ]);

    logger.info('Created new user profile', { slackId, userId });

    return {
      id: userId,
      slack_id: slackId,
      display_name: displayName || slackId,
      personality_traits: {},
      speech_patterns: {},
      activity_patterns: {},
      relationship_summary: 'New member',
      last_seen: new Date(now),
      created_at: new Date(now),
      updated_at: new Date(now)
    };
  } catch (error) {
    logger.error('Failed to ensure user exists', error);
    throw error;
  }
}

/**
 * Update user's last seen timestamp
 */
export async function updateUserActivity(slackId: string, channelId?: string): Promise<void> {
  try {
    await runQuery(
      'UPDATE users SET last_seen = datetime("now"), updated_at = datetime("now") WHERE slack_id = ?',
      [slackId]
    );

    // Invalidate cache
    try {
      const redis = getRedisService();
      await redis.invalidateCache(`user:${slackId}:*`);
    } catch (error) {
      // Redis not available
    }

    logger.debug('Updated user activity', { slackId, channelId });
  } catch (error) {
    logger.error('Failed to update user activity', error);
  }
}

/**
 * Update user personality traits based on observed behavior
 */
export async function updateUserPersonality(
  slackId: string,
  traits: Partial<UserProfile['personality_traits']>
): Promise<void> {
  try {
    const user = await ensureUserExists(slackId);

    const updatedTraits = {
      ...user.personality_traits,
      ...traits
    };

    await runQuery(
      'UPDATE users SET personality_traits = ?, updated_at = datetime("now") WHERE slack_id = ?',
      [JSON.stringify(updatedTraits), slackId]
    );

    // Invalidate cache
    try {
      const redis = getRedisService();
      await redis.invalidateCache(`user:${slackId}:*`);
    } catch (error) {
      // Redis not available
    }

    logger.info('Updated user personality', { slackId, traits: Object.keys(traits) });
  } catch (error) {
    logger.error('Failed to update user personality', error);
  }
}

/**
 * Update user speech patterns
 */
export async function updateUserSpeechPatterns(
  slackId: string,
  patterns: Partial<UserProfile['speech_patterns']>
): Promise<void> {
  try {
    const user = await ensureUserExists(slackId);

    const updatedPatterns = {
      ...user.speech_patterns,
      ...patterns
    };

    await runQuery(
      'UPDATE users SET speech_patterns = ?, updated_at = datetime("now") WHERE slack_id = ?',
      [JSON.stringify(updatedPatterns), slackId]
    );

    // Invalidate cache
    try {
      const redis = getRedisService();
      await redis.invalidateCache(`user:${slackId}:*`);
    } catch (error) {
      // Redis not available
    }

    logger.debug('Updated user speech patterns', { slackId });
  } catch (error) {
    logger.error('Failed to update user speech patterns', error);
  }
}

/**
 * Get all users (for admin/stats purposes)
 */
export async function getAllUsers(): Promise<UserProfile[]> {
  try {
    const users = await allQuery('SELECT * FROM users ORDER BY last_seen DESC');
    return users.map(dbRowToUserProfile);
  } catch (error) {
    logger.error('Failed to get all users', error);
    return [];
  }
}

/**
 * Delete user and all associated data (privacy compliance)
 */
export async function deleteUserData(slackId: string): Promise<void> {
  try {
    // Delete user (cascade will handle relationships)
    await runQuery('DELETE FROM users WHERE slack_id = ?', [slackId]);

    // Delete memories about this user
    await runQuery('DELETE FROM memories WHERE user_id = ?', [slackId]);

    // Invalidate cache
    try {
      const redis = getRedisService();
      await redis.invalidateCache(`user:${slackId}:*`);
    } catch (error) {
      // Redis not available
    }

    logger.info('Deleted all user data', { slackId });
  } catch (error) {
    logger.error('Failed to delete user data', error);
    throw error;
  }
}

// Helper function to convert database row to UserProfile
function dbRowToUserProfile(row: any): UserProfile {
  return {
    id: row.id,
    slack_id: row.slack_id,
    display_name: row.display_name,
    personality_traits: JSON.parse(row.personality_traits || '{}'),
    speech_patterns: JSON.parse(row.speech_patterns || '{}'),
    activity_patterns: JSON.parse(row.activity_patterns || '{}'),
    relationship_summary: row.relationship_summary,
    last_seen: new Date(row.last_seen),
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at)
  };
}
