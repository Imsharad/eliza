import {
  ChannelType,
  type Content,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type UUID,
  createUniqueUuid,
  logger,
  parseBooleanFromText,
  truncateToCompleteSentence,
} from '@elizaos/core';
import type { ClientBase } from './base';
import type { Tweet } from './client/index';
import type { MediaData } from './types';
import { TwitterEventTypes } from './types';
/**
 * Class representing a Twitter post client for generating and posting tweets.
 */
export class TwitterPostClient {
  client: ClientBase;
  runtime: IAgentRuntime;
  twitterUsername: string;
  private isDryRun: boolean;
  private state: any;

  /**
   * Constructor for initializing a new Twitter client with the provided client, runtime, and state
   * @param {ClientBase} client - The client used for interacting with Twitter API
   * @param {IAgentRuntime} runtime - The runtime environment for the agent
   * @param {any} state - The state object containing configuration settings
   */
  constructor(client: ClientBase, runtime: IAgentRuntime, state: any) {
    this.client = client;
    this.state = state;
    this.runtime = runtime;
    this.twitterUsername =
      state?.TWITTER_USERNAME || (this.runtime.getSetting('TWITTER_USERNAME') as string);
    this.isDryRun =
      this.state?.TWITTER_DRY_RUN ||
      (this.runtime.getSetting('TWITTER_DRY_RUN') as unknown as boolean);

    // Log configuration on initialization
    logger.log('Twitter Client Configuration:');
    logger.log(`- Username: ${this.twitterUsername}`);
    logger.log(`- Dry Run Mode: ${this.isDryRun ? 'Enabled' : 'Disabled'}`);

    this.state.isTwitterEnabled = parseBooleanFromText(
      String(
        this.state?.TWITTER_ENABLE_POST_GENERATION ||
          this.runtime.getSetting('TWITTER_ENABLE_POST_GENERATION') ||
          ''
      )
    );

    logger.log(`- Auto-post: ${this.state.isTwitterEnabled ? 'enabled' : 'disabled'}`);

    logger.log(
      `- Post Interval: ${this.state?.TWITTER_POST_INTERVAL_MIN || this.runtime.getSetting('TWITTER_POST_INTERVAL_MIN')}-${this.state?.TWITTER_POST_INTERVAL_MAX || this.runtime.getSetting('TWITTER_POST_INTERVAL_MAX')} minutes`
    );
    logger.log(
      `- Post Immediately: ${
        this.state?.TWITTER_POST_IMMEDIATELY || this.runtime.getSetting('TWITTER_POST_IMMEDIATELY')
          ? 'enabled'
          : 'disabled'
      }`
    );

    if (this.isDryRun) {
      logger.log('Twitter client initialized in dry run mode - no actual tweets should be posted');
    }
  }

  /**
   * Starts the Twitter post client, setting up a loop to periodically generate new tweets.
   */
  async start() {
    logger.log('Starting Twitter post client...');
    const tweetGeneration = this.state.isTwitterEnabled;
    if (tweetGeneration === false) {
      logger.log('Tweet generation is disabled');
      return;
    }

    const generateNewTweetLoop = async () => {
      // Defaults to 30 minutes
      const interval =
        (this.state?.TWITTER_POST_INTERVAL ||
          (this.runtime.getSetting('TWITTER_POST_INTERVAL') as unknown as number) ||
          30) *
        60 *
        1000;

      this.generateNewTweet();
      setTimeout(generateNewTweetLoop, interval);
    };

    // Start the loop after a 1 minute delay to allow other services to initialize
    setTimeout(generateNewTweetLoop, 60 * 1000);
    if (this.runtime.getSetting('TWITTER_POST_IMMEDIATELY')) {
      // await 1 second
      await new Promise((resolve) => setTimeout(resolve, 1000));
      this.generateNewTweet();
    }
  }

  /**
   * Creates a Tweet object based on the tweet result, client information, and Twitter username.
   *
   * @param {any} tweetResult - The result object from the Twitter API representing a tweet.
   * @param {any} client - The client object containing profile information.
   * @param {string} twitterUsername - The Twitter username of the user.
   * @returns {Tweet} A Tweet object with specific properties extracted from the tweet result and client information.
   */
  createTweetObject(tweetResult: any, client: any, twitterUsername: string): Tweet {
    const tweet = {
      id: tweetResult.rest_id,
      name: client.profile.screenName,
      username: client.profile.username,
      text: tweetResult.legacy.full_text,
      conversationId: tweetResult.legacy.conversation_id_str,
      createdAt: tweetResult.legacy.created_at,
      timestamp: new Date(tweetResult.legacy.created_at).getTime(),
      userId: client.profile.id,
      inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
      permanentUrl: `https://twitter.com/${twitterUsername}/status/${tweetResult.rest_id}`,
      hashtags: [],
      mentions: [],
      photos: [],
      thread: [],
      urls: [],
      videos: [],
    } as Tweet;

    // Log only the most valuable tweet object data
    logger.info({
      action: 'twitter_create_tweet_object',
      tweetId: tweet.id,
      userId: tweet.userId,
      username: tweet.username,
      url: tweet.permanentUrl,
    });

    return tweet;
  }

  /**
   * Processes and caches a tweet.
   *
   * @param {IAgentRuntime} runtime - The agent runtime.
   * @param {ClientBase} client - The client object.
   * @param {Tweet} tweet - The tweet to be processed and cached.
   * @param {UUID} roomId - The ID of the room where the tweet will be stored.
   * @param {string} rawTweetContent - The raw content of the tweet.
   */
  async processAndCacheTweet(
    runtime: IAgentRuntime,
    client: ClientBase,
    tweet: Tweet,
    roomId: UUID,
    rawTweetContent: string
  ) {
    // Cache the last post details
    await runtime.setCache<any>(`twitter/${client.profile.username}/lastPost`, {
      id: tweet.id,
      timestamp: Date.now(),
    });

    // Cache the tweet
    await client.cacheTweet(tweet);

    // Log tweet processing with focused information
    logger.info({
      action: 'twitter_process_tweet',
      tweetId: tweet.id,
      url: tweet.permanentUrl,
      roomId,
    });

    // Ensure the room and participant exist
    await runtime.ensureRoomExists({
      id: roomId,
      name: 'Twitter Feed',
      source: 'twitter',
      type: ChannelType.FEED,
    });
    await runtime.ensureParticipantInRoom(runtime.agentId, roomId);

    // Create a memory for the tweet
    await runtime.createMemory(
      {
        id: createUniqueUuid(this.runtime, tweet.id),
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        content: {
          text: rawTweetContent.trim(),
          url: tweet.permanentUrl,
          source: 'twitter',
        },
        roomId,
        createdAt: tweet.timestamp,
      },
      'messages'
    );
  }

  /**
   * Handles sending a note tweet with optional media data.
   *
   * @param {ClientBase} client - The client object used for sending the note tweet.
   * @param {string} content - The content of the note tweet.
   * @param {string} [tweetId] - Optional Tweet ID to reply to.
   * @param {MediaData[]} [mediaData] - Optional media data to attach to the note tweet.
   * @returns {Promise<Object>} - The result of the note tweet operation.
   * @throws {Error} - If the note tweet operation fails.
   */
  async handleNoteTweet(
    client: ClientBase,
    content: string,
    tweetId?: string,
    mediaData?: MediaData[]
  ) {
    try {
      const noteTweetResult = await client.requestQueue.add(
        async () => await client.twitterClient.sendNoteTweet(content, tweetId, mediaData)
      );

      if (noteTweetResult.errors && noteTweetResult.errors.length > 0) {
        // Note Tweet failed due to authorization. Falling back to standard Tweet.
        const truncateContent = truncateToCompleteSentence(content, 280 - 1);
        return await this.sendStandardTweet(client, truncateContent, tweetId);
      }
      return noteTweetResult.data.notetweet_create.tweet_results.result;
    } catch (error) {
      throw new Error(`Note Tweet failed: ${error}`);
    }
  }

  /**
   * Asynchronously sends a standard tweet using the provided Twitter client.
   *
   * @param {ClientBase} client - The client used to make the request.
   * @param {string} content - The content of the tweet.
   * @param {string} [tweetId] - Optional tweet ID to reply to.
   * @param {MediaData[]} [mediaData] - Optional array of media data to attach to the tweet.
   * @returns {Promise<string>} The result of sending the tweet.
   */
  async sendStandardTweet(
    client: ClientBase,
    content: string,
    tweetId?: string,
    mediaData?: MediaData[]
  ) {
    try {
      // Log the action being taken (sending a tweet)
      logger.info({
        action: 'twitter_send_tweet',
        contentLength: content.length,
        isReply: !!tweetId,
        hasMedia: !!(mediaData && mediaData.length > 0),
      });

      const standardTweetResult = await client.requestQueue.add(
        async () => await client.twitterClient.sendTweet(content, tweetId, mediaData)
      );
      const body = await standardTweetResult.json();
      if (!body?.data?.create_tweet?.tweet_results?.result) {
        logger.error('Error sending tweet; Bad response:', body);
        return;
      }
      return body.data.create_tweet.tweet_results.result;
    } catch (error) {
      logger.error('Error sending standard Tweet:', error);
      throw error;
    }
  }

  /**
   * Asynchronously posts a tweet to Twitter, replacing any existing instrumentation with a more focused approach.
   *
   * @param {IAgentRuntime} runtime - The runtime environment.
   * @param {ClientBase} client - The Twitter client instance.
   * @param {string} tweetTextForPosting - The formatted text for the tweet.
   * @param {UUID} roomId - The room ID for caching.
   * @param {string} rawTweetContent - The raw content of the tweet.
   * @param {string} twitterUsername - The Twitter username.
   * @param {MediaData[]} [mediaData] - Optional media data to include in the tweet.
   * @returns {Promise<Tweet>} The posted tweet.
   */
  async postTweet(
    runtime: IAgentRuntime,
    client: ClientBase,
    tweetTextForPosting: string,
    roomId: UUID,
    rawTweetContent: string,
    twitterUsername: string,
    mediaData?: MediaData[]
  ) {
    try {
      // Log the LLM-generated tweet content (one of the three key points Monil mentioned)
      logger.info({
        action: 'twitter_generated_content',
        content: rawTweetContent,
        formattedLength: tweetTextForPosting.length,
        hasMedia: !!(mediaData && mediaData.length > 0),
      });

      let tweetResult;
      try {
        if (tweetTextForPosting.length > 280) {
          // If tweet is > 280 chars, try a note tweet first
          tweetResult = await this.handleNoteTweet(
            client,
            tweetTextForPosting,
            undefined,
            mediaData
          );
        } else {
          // Otherwise do a standard tweet
          tweetResult = await this.sendStandardTweet(
            client,
            tweetTextForPosting,
            undefined,
            mediaData
          );
        }
      } catch (e) {
        logger.error('Error posting tweet:', e);
        throw e;
      }

      const tweet = this.createTweetObject(tweetResult, client, twitterUsername);

      // Process and cache the tweet
      await this.processAndCacheTweet(runtime, client, tweet, roomId, rawTweetContent);

      // Emit tweet-posted event (the action taken - another key point Monil mentioned)
      runtime.emitEvent(TwitterEventTypes.POST_SENT, {
        runtime,
        message: { content: { text: tweetTextForPosting } },
        tweetResult,
      });

      return tweet;
    } catch (error) {
      logger.error('Error in postTweet:', error);
      throw error;
    }
  }

  /**
   * Formats raw tweet text to ensure it meets Twitter requirements.
   *
   * @param {string} rawText - The raw text to prepare for Twitter
   * @returns {string} - The properly formatted tweet text
   */
  private prepareTweetText(rawText: string): string {
    if (!rawText) return '';

    // Ensure text is trimmed
    let tweetText = rawText.trim();

    // Truncate if necessary to Twitter's character limit
    if (tweetText.length > 280) {
      tweetText = truncateToCompleteSentence(tweetText, 280);
    }

    return tweetText;
  }

  /**
   * Generates and posts a new tweet using the character's voice.
   */
  async generateNewTweet() {
    try {
      // Check if we are in dry run mode
      if (this.isDryRun) {
        logger.info({
          action: 'twitter_dry_run',
          message: 'Tweet generation skipped - dry run mode enabled',
        });
        return;
      }

      // Ensure we have client profile data
      if (!this.client.profile) {
        logger.info({
          action: 'twitter_generate_tweet',
          status: 'skipped',
          reason: 'missing_profile',
        });
        return;
      }

      logger.info({
        action: 'twitter_generate_tweet',
        status: 'started',
      });

      // Prepare the timelineRoom ID based on the Twitter user ID
      const timelineRoomId = createUniqueUuid(
        this.runtime,
        `${this.client.profile.id}-home`
      ) as UUID;

      // Use random tweet generation capability
      const callback: HandlerCallback = async (content: Content) => {
        try {
          // Skip empty posts
          if (!content.text || content.text.trim() === '') {
            logger.info({
              action: 'twitter_generate_tweet',
              status: 'skipped',
              reason: 'empty_content',
            });
            return [];
          }

          // Get text content
          const rawTweetContent = content.text.trim();
          // Format tweet text - ensure it meets requirements and isn't empty
          const tweetTextForPosting = this.prepareTweetText(rawTweetContent);

          if (!tweetTextForPosting || tweetTextForPosting.trim() === '') {
            logger.info({
              action: 'twitter_generate_tweet',
              status: 'skipped',
              reason: 'empty_formatted_content',
            });
            return [];
          }

          // Extract media from content if available
          const mediaData: MediaData[] = [];
          if (content.mediaData && Array.isArray(content.mediaData)) {
            for (const media of content.mediaData) {
              if (media && media.data) {
                mediaData.push({
                  data: media.data,
                  mediaType: 'image', // Default to image type
                });
              }
            }
          }

          // Post the tweet
          await this.postTweet(
            this.runtime,
            this.client,
            tweetTextForPosting,
            timelineRoomId,
            rawTweetContent,
            this.twitterUsername,
            mediaData
          );

          return [];
        } catch (error) {
          logger.error({
            action: 'twitter_generate_tweet',
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        }
      };

      // Generate the post using the runtime
      const subject = `Generate a tweet for ${this.twitterUsername}`;
      const prompt = 'Generate a new tweet from the perspective of the character';

      // Use emitEvent to generate content via the standard flow
      this.runtime.emitEvent(EventType.POST_GENERATED, {
        runtime: this.runtime,
        callback,
        source: 'twitter',
        subject,
        context: prompt,
      });
    } catch (error) {
      logger.error({
        action: 'twitter_generate_tweet',
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Posts content to Twitter
   * @param {string} text The tweet text to post
   * @param {MediaData[]} mediaData Optional media to attach to the tweet
   * @returns {Promise<any>} The result from the Twitter API
   */
  private async postToTwitter(text: string, mediaData: MediaData[] = []): Promise<any> {
    try {
      // Check if this tweet is a duplicate of the last one
      const lastPost = await this.runtime.getCache<any>(
        `twitter/${this.client.profile?.username}/lastPost`
      );
      if (lastPost) {
        // Fetch the last tweet to compare content
        const lastTweet = await this.client.getTweet(lastPost.id);
        if (lastTweet && lastTweet.text === text) {
          logger.warn('Tweet is a duplicate of the last post. Skipping to avoid duplicate.');
          return null;
        }
      }

      // Handle media uploads if needed
      const mediaIds: string[] = [];

      if (mediaData && mediaData.length > 0) {
        for (const media of mediaData) {
          try {
            // TODO: Media upload will need to be updated to use the new API
            // For now, just log a warning that media upload is not supported
            logger.warn('Media upload not currently supported with the modern Twitter API');
          } catch (error) {
            logger.error('Error uploading media:', error);
          }
        }
      }

      // Use the modern sendTweet method instead of the old post method
      const result = await this.client.requestQueue.add(() =>
        this.client.twitterClient.sendTweet(text.substring(0, 280))
      );

      // Handle response based on the new API format
      const body = await result.json();
      if (!body?.data?.create_tweet?.tweet_results?.result) {
        logger.error('Error sending tweet; Bad response:', body);
        return null;
      }

      return body.data.create_tweet.tweet_results.result;
    } catch (error) {
      logger.error('Error posting to Twitter:', error);
      throw error;
    }
  }

  async stop() {
    // Implement stop functionality if needed
  }
}
