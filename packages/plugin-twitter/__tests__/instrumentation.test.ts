import type { IAgentRuntime, UUID } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TwitterPostClient } from '../src/post';
import type { MediaData } from '../src/types';

// Mock the core modules
vi.mock('@elizaos/core', async () => {
  const actual = await vi.importActual<typeof import('@elizaos/core')>('@elizaos/core');
  return {
    ...actual,
    logger: {
      log: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    },
    createUniqueUuid: vi.fn(() => 'mocked-uuid'),
  };
});

describe('Twitter Plugin Instrumentation', () => {
  // Mock dependencies
  const mockClient = {
    profile: {
      id: 'test-id',
      username: 'test-username',
      screenName: 'Test User',
    },
    requestQueue: {
      add: vi.fn((callback) => callback()),
    },
    twitterClient: {
      sendTweet: vi.fn(),
      sendNoteTweet: vi.fn(),
    },
    cacheTweet: vi.fn(),
  };

  const mockRuntime = {
    agentId: 'test-agent-id' as UUID,
    getSetting: vi.fn((key) => {
      if (key === 'TWITTER_USERNAME') return 'test-username';
      if (key === 'TWITTER_DRY_RUN') return false;
      return null;
    }),
    setSetting: vi.fn(),
    setCache: vi.fn(),
    ensureRoomExists: vi.fn(),
    ensureParticipantInRoom: vi.fn(),
    createMemory: vi.fn(),
    emitEvent: vi.fn(),
  } as unknown as IAgentRuntime;

  const mockState = {
    TWITTER_USERNAME: 'test-username',
  };

  // Create mock room ID as UUID
  const mockRoomId = '123e4567-e89b-12d3-a456-426614174000' as UUID;

  beforeEach(() => {
    // Clear all mocks before each test
    vi.clearAllMocks();

    // Mock Twitter client response
    mockClient.twitterClient.sendTweet.mockResolvedValue({
      json: async () => ({
        data: {
          create_tweet: {
            tweet_results: {
              result: {
                rest_id: 'test-tweet-id',
                legacy: {
                  full_text: 'Test tweet content',
                  conversation_id_str: 'test-convo-id',
                  created_at: new Date().toISOString(),
                  in_reply_to_status_id_str: null,
                },
              },
            },
          },
        },
      }),
    });
  });

  it('createTweetObject method should have instrumentation', () => {
    // Create the TwitterPostClient instance
    const postClient = new TwitterPostClient(mockClient as any, mockRuntime, mockState);

    // Prepare test data
    const tweetResult = {
      rest_id: 'test-tweet-id',
      legacy: {
        full_text: 'Test tweet content',
        conversation_id_str: 'test-convo-id',
        created_at: new Date().toISOString(),
        in_reply_to_status_id_str: null,
      },
    };

    // Call the method
    postClient.createTweetObject(tweetResult, mockClient, 'test-username');

    // Verify instrumentation
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'twitter_create_tweet_object',
        tweetId: 'test-tweet-id',
      })
    );
  });

  it('sendStandardTweet method should have instrumentation', async () => {
    // Create the TwitterPostClient instance
    const postClient = new TwitterPostClient(mockClient as any, mockRuntime, mockState);

    // Call the method
    await postClient.sendStandardTweet(mockClient as any, 'Test tweet content');

    // Verify instrumentation
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'twitter_send_tweet',
        contentLength: 'Test tweet content'.length,
        isReply: false,
      })
    );
  });

  it('processAndCacheTweet method should have instrumentation', async () => {
    // Create the TwitterPostClient instance
    const postClient = new TwitterPostClient(mockClient as any, mockRuntime, mockState);

    // Prepare test data
    const tweet = {
      id: 'test-tweet-id',
      text: 'Test tweet content',
      permanentUrl: 'https://twitter.com/test-username/status/test-tweet-id',
      timestamp: Date.now(),
    };

    // Call the method
    await postClient.processAndCacheTweet(
      mockRuntime,
      mockClient as any,
      tweet as any,
      mockRoomId,
      'Test tweet content'
    );

    // Verify instrumentation
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'twitter_process_tweet',
        tweetId: 'test-tweet-id',
        url: 'https://twitter.com/test-username/status/test-tweet-id',
      })
    );
  });

  it('postTweet method should have instrumentation', async () => {
    // Create the TwitterPostClient instance
    const postClient = new TwitterPostClient(mockClient as any, mockRuntime, mockState);

    // Call the method
    await postClient.postTweet(
      mockRuntime,
      mockClient as any,
      'Test tweet content',
      mockRoomId,
      'Raw test tweet content',
      'test-username'
    );

    // Verify instrumentation for generated content
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'twitter_generated_content',
        content: 'Raw test tweet content',
      })
    );

    // Verify event emission for tweet posting
    expect(mockRuntime.emitEvent).toHaveBeenCalled();
  });
});
