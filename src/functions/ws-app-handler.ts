// Standard library imports
import { Credentials } from 'aws-sdk';

// Third-party library imports
import { Block, UsersInfoResponse, ChatPostMessageResponse } from '@slack/web-api';
import {
  App,
  LogLevel,
  GenericMessageEvent,
  BlockAction,
  SlackActionMiddlewareArgs,
  SlackCommandMiddlewareArgs,
  SlackEventMiddlewareArgs,
} from '@slack/bolt';
import { FailedAttachmentEvent, MetadataEvent, TextOutputEvent, SourceAttribution, AttachmentInput } from '@aws-sdk/client-qbusiness';

// Local application imports
import { getOrThrowIfEmpty, isEmpty } from '@src/utils';
import { chat, getResponseAsBlocks, getSignInBlocks } from '@helpers/amazon-q/amazon-q-helpers';
import { getFeedbackBlocks } from '@src/helpers/amazon-q/ws-helpers';
import {
  openModal,
  createModal,
  getSlackSecret,
  getMarkdownBlock,
  getMarkdownBlocks,
  validateSlackRequest,
  SLACK_ACTION,
  getSlackClient,
} from '@src/helpers/slack/slack-helpers';
import {
  SessionManagerEnv,
  getSessionCreds,
  startSession,
} from '@helpers/idc/session-helpers';
import {
  chatDependencies,
  deleteChannelMetadata,
  getChannelKey,
  getChannelMetadata,
  saveChannelMetadata,
  saveMessageMetadata,
  getMessageMetadata,
} from '@helpers/chat';
import { SlackInteractionsEnv } from './slack-interaction-handler';

export const ERROR_MSG = '*_Processing error_*';


let initialTimestamp: number;
let messageTimestamp: string;

const dependencies = {
  ...chatDependencies,
  validateSlackRequest,
  getSessionCreds,
  startSession,
};

export const updateSlackMessageTest = async (
  env: SlackInteractionsEnv | SlackEventsEnv,
  postMessageResponse: ChatPostMessageResponse,
  text: string | undefined,
  blocks?: Block[]
) => {
  if (isEmpty(postMessageResponse.channel) || isEmpty(postMessageResponse.ts)) {
    return;
  }
  initialTimestamp = Date.now()

  const response = await (
    await getSlackClient(env)
  ).chat.update({
    channel: postMessageResponse.channel,
    ts: postMessageResponse.ts,
    blocks,
    text
  });
  messageTimestamp = response.ts ?? ''

};

const processSlackEventsEnv = (env: NodeJS.ProcessEnv) => ({
  REGION: getOrThrowIfEmpty(env.AWS_REGION ?? env.AWS_DEFAULT_REGION),
  SLACK_SECRET_NAME: getOrThrowIfEmpty(env.SLACK_SECRET_NAME),
  AMAZON_Q_APP_ID: getOrThrowIfEmpty(env.AMAZON_Q_APP_ID),
  AMAZON_Q_REGION: getOrThrowIfEmpty(env.AMAZON_Q_REGION),
  CONTEXT_DAYS_TO_LIVE: getOrThrowIfEmpty(env.CONTEXT_DAYS_TO_LIVE),
  CACHE_TABLE_NAME: getOrThrowIfEmpty(env.CACHE_TABLE_NAME),
  MESSAGE_METADATA_TABLE_NAME: getOrThrowIfEmpty(env.MESSAGE_METADATA_TABLE_NAME),
  OIDC_STATE_TABLE_NAME: getOrThrowIfEmpty(env.OIDC_STATE_TABLE_NAME),
  IAM_SESSION_TABLE_NAME: getOrThrowIfEmpty(env.IAM_SESSION_CREDENTIALS_TABLE_NAME),
  OIDC_IDP_NAME: getOrThrowIfEmpty(env.OIDC_IDP_NAME),
  OIDC_ISSUER_URL: getOrThrowIfEmpty(env.OIDC_ISSUER_URL),
  OIDC_CLIENT_ID: getOrThrowIfEmpty(env.OIDC_CLIENT_ID),
  OIDC_CLIENT_SECRET_NAME: getOrThrowIfEmpty(env.OIDC_CLIENT_SECRET_NAME),
  OIDC_REDIRECT_URL: getOrThrowIfEmpty(env.OIDC_REDIRECT_URL),
  KMS_KEY_ARN: getOrThrowIfEmpty(env.KEY_ARN),
  Q_USER_API_ROLE_ARN: getOrThrowIfEmpty(env.Q_USER_API_ROLE_ARN),
  GATEWAY_IDC_APP_ARN: getOrThrowIfEmpty(env.GATEWAY_IDC_APP_ARN),
});

export type SlackEventsEnv = ReturnType<typeof processSlackEventsEnv>;

const MAX_FILE_ATTACHMENTS = 5;
const SUPPORTED_FILE_TYPES = [
  'text', 'html', 'xml', 'markdown', 'csv', 'json', 'xls', 'xlsx', 'ppt', 'pptx', 'doc', 'docx', 'rtf', 'pdf',
];

// Function to attach files
const attachFiles = async (
  slackEventsEnv: SlackEventsEnv,
  files: any[],
): Promise<AttachmentInput[]> => {
  const newAttachments: AttachmentInput[] = [];
  for (const f of files) {
    if (
      !isEmpty(f.filetype) &&
      SUPPORTED_FILE_TYPES.includes(f.filetype) &&
      !isEmpty(f.url_private_download) &&
      !isEmpty(f.name)
    ) {
      newAttachments.push({
        name: f.name,
        data: await chatDependencies.retrieveAttachment(slackEventsEnv, f.url_private_download),
      });
    } else {
      console.debug(
        `Ignoring file attachment with unsupported filetype '${f.filetype}' - not one of '${SUPPORTED_FILE_TYPES}'`,
      );
    }
  }
  return newAttachments;
};


const FEEDBACK_MESSAGE = 'Open Slack to provide feedback';

const handleMessage = async (
  { message, say, body }: SlackEventMiddlewareArgs<'message'> | SlackEventMiddlewareArgs<'app_mention'>,
  slackEventsEnv: SlackEventsEnv, wsApp: App
) => {
  const event = body.event as GenericMessageEvent;

  if (!event || event.subtype === 'bot_message' || !event.user) {
    console.debug('Ignoring bot message or message with no user');
    return;
  }

  const sessionManagerEnv: SessionManagerEnv = {
    oidcStateTableName: slackEventsEnv.OIDC_STATE_TABLE_NAME,
    iamSessionCredentialsTableName: slackEventsEnv.IAM_SESSION_TABLE_NAME,
    oidcIdPName: slackEventsEnv.OIDC_IDP_NAME,
    oidcClientId: slackEventsEnv.OIDC_CLIENT_ID,
    oidcClientSecretName: slackEventsEnv.OIDC_CLIENT_SECRET_NAME,
    oidcIssuerUrl: slackEventsEnv.OIDC_ISSUER_URL,
    oidcRedirectUrl: slackEventsEnv.OIDC_REDIRECT_URL,
    kmsKeyArn: slackEventsEnv.KMS_KEY_ARN,
    region: slackEventsEnv.AMAZON_Q_REGION,
    qUserAPIRoleArn: slackEventsEnv.Q_USER_API_ROLE_ARN,
    gatewayIdCAppArn: slackEventsEnv.GATEWAY_IDC_APP_ARN,
  };

  let iamSessionCreds: Credentials;
  try {
    iamSessionCreds = await getSessionCreds(sessionManagerEnv, event.user);
  } catch (error) {
    console.error(`Failed to get session: ${error}`);
    const authorizationURL = await startSession(sessionManagerEnv, event.user);
    const blocks = getSignInBlocks(authorizationURL);
    await wsApp.client.chat.postMessage({
      channel: event.channel,
      user: event.user,
      text: `<@${event.user}>, please sign in through the Amazon Q bot app to continue.`,
      blocks: blocks,
    });
    return;
  }

  const channelKey = getChannelKey(event.type, body.team_id, event.channel, event.event_ts, event.thread_ts);
  const channelMetadata = await getChannelMetadata(channelKey, dependencies, slackEventsEnv);

  const context = {
    conversationId: channelMetadata?.conversationId,
    parentMessageId: channelMetadata?.systemMessageId,
  };

  let attachments: AttachmentInput[] = [];
  const input = [];
  const userInformationCache: Record<string, UsersInfoResponse> = {};
  const stripMentions = (text?: string) => text?.replace(/<@[A-Z0-9]+>/g, '').trim();

  if (isEmpty(userInformationCache[event.user])) {
    userInformationCache[event.user] = await wsApp.client.users.info({ user: event.user });
  }

  if (!isEmpty(event.thread_ts)) {
    const threadHistory = await wsApp.client.conversations.replies({
      channel: event.channel,
      ts: event.thread_ts,
    });

    if (threadHistory.ok && !isEmpty(threadHistory.messages)) {
      const promptConversationHistory = [];

      for (const m of threadHistory.messages.slice(0, -1)) {
        if (isEmpty(m.user) || m.text === FEEDBACK_MESSAGE) continue;

        if (isEmpty(userInformationCache[m.user])) {
          userInformationCache[m.user] = await wsApp.client.users.info({ user: m.user });
        }

        promptConversationHistory.push({
          name: userInformationCache[m.user].user?.real_name,
          message: stripMentions(m.text),
          date: !isEmpty(m.ts) ? new Date(Number(m.ts) * 1000).toISOString() : undefined,
        });

        if (!isEmpty(m.files)) {
          attachments.push(...(await attachFiles(slackEventsEnv, m.files)));
        }
      }

      if (promptConversationHistory.length > 0) {
        context.conversationId = undefined;
        context.parentMessageId = undefined;
        input.push(`Given the following conversation thread history in JSON:\n${JSON.stringify(promptConversationHistory)}`);
      }
    }
  }

  input.push(stripMentions(event.text));
  const prompt = input.join(`\n${'-'.repeat(10)}\n`);

  if (!isEmpty(event.files)) {
    attachments.push(...(await attachFiles(slackEventsEnv, event.files)));
  }

  const chatStartTime = Date.now();
  const [output, slackMessage] = await Promise.all([
    chat(
      prompt,
      attachments,
      dependencies,
      slackEventsEnv,
      iamSessionCreds,
      event.user,
      context
    ),
    dependencies.sendSlackMessage(
      slackEventsEnv,
      body.event.channel,
      `Processing...`,
      [getMarkdownBlock(`Processing...`)],
      body.event.type === 'app_mention' ? body.event.ts : undefined
    )
  ]);
  const chatEndTime = Date.now();
  console.info(`Chatss request time: ${chatEndTime - chatStartTime} ms`);

  const slackUpdateTimes: number[] = [];

  if (output instanceof Error) {
    const errMsgWithDetails = `${ERROR_MSG}\n_${output.message}_`;
    const blocks = [getMarkdownBlock(errMsgWithDetails)];
    const slackUpdateStartTime = Date.now();
    await dependencies.updateSlackMessage(slackEventsEnv, slackMessage, errMsgWithDetails, blocks);
    const slackUpdateEndTime = Date.now();
    slackUpdateTimes.push(slackUpdateEndTime - slackUpdateStartTime);
    console.info(`Slack update time: ${slackUpdateEndTime - slackUpdateStartTime} ms`);
    console.info(`All Slack update times: ${JSON.stringify(slackUpdateTimes)}`);
    return;
  }

  let outputText = '';
  let buffer = '';
  const bufferSize = 25;

  let failedAttachmentEvents: FailedAttachmentEvent[] = [];
  let latestMetadataEvent: MetadataEvent | undefined;
  let latestTextEvent: TextOutputEvent | undefined;

  if (output.outputStream === undefined) {
    console.info('Output stream is undefined');
    return;
  }

  for await (const event of output.outputStream) {
    if (event.textEvent) {
      latestTextEvent = event.textEvent;
      buffer += latestTextEvent.systemMessage;

      if (buffer.length >= bufferSize) {
        outputText += buffer;
        await dependencies.updateSlackMessage(
          slackEventsEnv,
          slackMessage,
          outputText,
          getResponseAsBlocks(outputText, latestTextEvent.systemMessageId ?? '')
        );
        buffer = '';
      }
    } else if (event.failedAttachmentEvent) {
      failedAttachmentEvents?.push(event.failedAttachmentEvent);
    } else if (event.metadataEvent) {
      latestMetadataEvent = event.metadataEvent;
    }
  }

  if (!latestTextEvent || latestTextEvent.systemMessageId === undefined) {
    console.debug('Undefined TextEventMessageID');
    return;
  }

  if (failedAttachmentEvents) {
    const fileErrorMessages = [];
    for (const f of failedAttachmentEvents) {
      if (f.attachment?.status == 'FAILED') {
        console.debug(`Failed attachment: File ${f.attachment.name} - ${f.attachment.error?.errorMessage}`);
        fileErrorMessages.push(` \u2022 ${f.attachment.name}: ${f.attachment.error?.errorMessage}`);
      }
    }
    if (!isEmpty(fileErrorMessages)) {
      outputText = `${outputText}\n\n*_Failed attachments:_*\n${fileErrorMessages.join('\n')}`;
    }
  }

  if (latestMetadataEvent === undefined) {
    console.debug('Missing MetadataEvent');
    return;
  }

  outputText += buffer
  await Promise.all([
    saveChannelMetadata(channelKey, latestMetadataEvent?.conversationId ?? '', latestMetadataEvent?.systemMessageId ?? '', dependencies, slackEventsEnv),
    saveMessageMetadata(latestMetadataEvent, dependencies, slackEventsEnv),
    updateSlackMessageTest(slackEventsEnv, slackMessage, outputText, getResponseAsBlocks(outputText, latestMetadataEvent?.systemMessageId ?? '', latestMetadataEvent?.sourceAttributions || []))
  ]);

  await dependencies.sendSlackMessage(
    slackEventsEnv,
    body.event.channel,
    FEEDBACK_MESSAGE,
    getFeedbackBlocks(latestTextEvent),
    body.event.type === 'app_mention' ? body.event.ts : undefined
  );

  const endTime = Date.now();
  console.info(`Total handler time: ${endTime - chatStartTime} ms`);


};


const handleCommand = async (
  { command, ack }: SlackCommandMiddlewareArgs,
  slackEventsEnv: SlackEventsEnv
) => {
  await ack();
  const sessionManagerEnv: SessionManagerEnv = {
    oidcStateTableName: slackEventsEnv.OIDC_STATE_TABLE_NAME,
    iamSessionCredentialsTableName: slackEventsEnv.IAM_SESSION_TABLE_NAME,
    oidcIdPName: slackEventsEnv.OIDC_IDP_NAME,
    oidcClientId: slackEventsEnv.OIDC_CLIENT_ID,
    oidcClientSecretName: slackEventsEnv.OIDC_CLIENT_SECRET_NAME,
    oidcIssuerUrl: slackEventsEnv.OIDC_ISSUER_URL,
    oidcRedirectUrl: slackEventsEnv.OIDC_REDIRECT_URL,
    kmsKeyArn: slackEventsEnv.KMS_KEY_ARN,
    region: slackEventsEnv.AMAZON_Q_REGION,
    qUserAPIRoleArn: slackEventsEnv.Q_USER_API_ROLE_ARN,
    gatewayIdCAppArn: slackEventsEnv.GATEWAY_IDC_APP_ARN,
  };
  try {
    await dependencies.getSessionCreds(sessionManagerEnv, command.user_id);
  } catch (error) {
    console.error(`Failed to get session: ${error}`);
    const authorizationURL = await dependencies.startSession(sessionManagerEnv, command.user_id);

    await dependencies.sendSlackMessage(
      slackEventsEnv,
      command.user_id,
      `<@${command.user_id}>, please sign in through the Amazon Q bot app to continue.`,
      getSignInBlocks(authorizationURL),
    );
  }
  if (command.command.startsWith('/new_conv')) {
    const channelKey = getChannelKey('message', command.team_id, command.channel_id, 'n/a');
    console.debug(`Slash command: ${command.command} - deleting channel metadata for '${channelKey}'`);
    await deleteChannelMetadata(channelKey, dependencies, slackEventsEnv);
    await dependencies.sendSlackMessage(
      slackEventsEnv,
      command.channel_id,
      `Starting New Conversation`,
      [getMarkdownBlock(`_*Starting New Conversation*_`)],
    );
  } else {
    console.error(`ERROR - unsupported slash command: ${command.command}`);
  }
  console.log('Command parameters')
  console.log(JSON.stringify(command))
};

const handleAction = async (
  { body, ack, say }: SlackActionMiddlewareArgs<BlockAction>,
  slackEventsEnv: SlackEventsEnv, wsApp: App
) => {
  await ack();

  const slackInteractionsEnv = processSlackEventsEnv(process.env);
  const payload = body;

  if (payload === undefined || payload.channel === undefined || payload.message === undefined || payload.actions === undefined) {
    console.warn(`Missing required parameter for response in ${JSON.stringify(payload)}, ignoring action`);
    return;
  }

  console.debug(`Received block action interactions: ${JSON.stringify(payload.actions)}`);
  const action = payload.actions[0];
  const id = action.action_id;

  if (id === SLACK_ACTION[SLACK_ACTION.SIGN_IN]) {
    console.debug(`Signing in...`);
    await chatDependencies.updateSlackMessage(
      slackInteractionsEnv,
      { channel: payload.channel.id, ts: payload.message.ts, ok: true },
      `Signing in through your browser...`,
      getMarkdownBlocks(`_Signing in through your browser..._`),
    );
  }

  if ('value' in action && typeof action.value === 'string') {
    const messageMetadata = await getMessageMetadata(action.value, chatDependencies, slackInteractionsEnv);
    if (messageMetadata === undefined) {
      return;
    }

    if (
      id === SLACK_ACTION[SLACK_ACTION.VIEW_SOURCES] &&
      messageMetadata?.sourceAttributions && !isEmpty(messageMetadata.sourceAttributions)
    ) {
      const modal = createModal('Source(s)', messageMetadata.sourceAttributions as SourceAttribution[]);
      await openModal(slackInteractionsEnv, payload.trigger_id, payload.channel.id, modal);
    } else if (
      id === SLACK_ACTION[SLACK_ACTION.FEEDBACK_UP] ||
      id === SLACK_ACTION[SLACK_ACTION.FEEDBACK_DOWN]
    ) {
      console.debug(`Received feedback ${id} for ${JSON.stringify(messageMetadata)}`);

      let iamSessionCreds: Credentials;
      const sessionManagerEnv: SessionManagerEnv = {
        oidcStateTableName: slackInteractionsEnv.OIDC_STATE_TABLE_NAME,
        iamSessionCredentialsTableName: slackInteractionsEnv.IAM_SESSION_TABLE_NAME,
        oidcIdPName: slackInteractionsEnv.OIDC_IDP_NAME,
        oidcClientId: slackInteractionsEnv.OIDC_CLIENT_ID,
        oidcClientSecretName: slackInteractionsEnv.OIDC_CLIENT_SECRET_NAME,
        oidcIssuerUrl: slackInteractionsEnv.OIDC_ISSUER_URL,
        oidcRedirectUrl: slackInteractionsEnv.OIDC_REDIRECT_URL,
        kmsKeyArn: slackInteractionsEnv.KMS_KEY_ARN,
        region: slackInteractionsEnv.AMAZON_Q_REGION,
        qUserAPIRoleArn: slackInteractionsEnv.Q_USER_API_ROLE_ARN,
        gatewayIdCAppArn: slackInteractionsEnv.GATEWAY_IDC_APP_ARN,
      };

      try {
        iamSessionCreds = await getSessionCreds(sessionManagerEnv, payload.user.id);
      } catch (error) {
        console.error(`Failed to get session: ${error}`);

        const authorizationURL = await startSession(sessionManagerEnv, payload.user.id);
        await chatDependencies.sendSlackMessage(
          slackInteractionsEnv,
          payload.user.id,
          `<@${payload.user.id}>, please sign in through the Amazon Q bot app to continue.`,
          getSignInBlocks(authorizationURL),
        );
        return;
      }

     await chatDependencies.submitFeedbackRequest(
        body.user.id,
        slackInteractionsEnv,
        iamSessionCreds,
        {
          conversationId: messageMetadata.conversationId ?? '',
          messageId: messageMetadata.systemMessageId ?? '',
        },
        id === SLACK_ACTION[SLACK_ACTION.FEEDBACK_UP] ? 'USEFUL' : 'NOT_USEFUL',
        id === SLACK_ACTION[SLACK_ACTION.FEEDBACK_UP] ? 'HELPFUL' : 'NOT_HELPFUL',
        payload.message.ts,
      );

      console.info(`Received feedback ${id} for ${JSON.stringify(messageMetadata)}`);

      const updatedBlocks: (Block)[] = [];
      for (const block of payload.message.blocks) {
        if (block.block_id && block.block_id.startsWith('feedback-')) {
          updatedBlocks.push(...getMarkdownBlocks(`_Thanks for your feedback_`));
        } else {
          updatedBlocks.push(block);
        }
      }
      if(payload.message.text === undefined) {
        console.log('Payload message undefined')
        return;
      }
      await dependencies.updateSlackMessage(
        slackInteractionsEnv,
        { channel: payload.channel.id, ts: payload.message.ts, ok: true },
        `Thanks for your feedback`,
        getMarkdownBlocks(`_Thanks for your feedback_`)
      );
    }
  }
  console.log('Payload Parameters')
  console.log(JSON.stringify(payload))
  console.log('Test')
};


export const handler = async () => {
  try {
    const slackEventsEnv = processSlackEventsEnv(process.env);
    const secret = await getSlackSecret(slackEventsEnv);
    const wsApp = new App({
      token: secret.SlackBotUserOAuthToken,
      signingSecret: secret.SlackSigningSecret,
      socketMode: true,
      appToken: secret.SlackAppToken,
      logLevel: LogLevel.DEBUG,
    });
    await wsApp.start();

    wsApp.event('message', async (args: SlackEventMiddlewareArgs<'message'>) => {
      const event = args.body.event;
      if (event.subtype === 'message_changed' && event.message && event.message.ts === messageTimestamp) {
        const time = Date.now()
        const test = JSON.stringify(event)
        const test1 = JSON.parse(test)
        const renderTime = Number(initialTimestamp) - Number(test1.message.edited.ts) * 1000

        console.log(`TestTest: ${JSON.stringify(test1.message.edited)}, ${initialTimestamp}`)
        console.log(`Message update took ${renderTime} milliseconds to render on the client`);
        console.log(`Event Structure: ${JSON.stringify(event)}`)
      } else {
        console.log('Event does not contain the expected structure or is not related to the tracked message');
      }
    
      return Promise.resolve();
    });
    

    wsApp.message(async (args: SlackEventMiddlewareArgs<'message'>) => handleMessage(args, slackEventsEnv, wsApp));
    wsApp.event('app_mention', async (args: SlackEventMiddlewareArgs<'app_mention'>) => handleMessage(args, slackEventsEnv, wsApp));
    wsApp.command('/new_conversation', async (args: SlackCommandMiddlewareArgs) => handleCommand(args, slackEventsEnv));
    wsApp.action({ type: 'block_actions' }, async (args: SlackActionMiddlewareArgs<BlockAction>) => handleAction(args, slackEventsEnv, wsApp));
    console.log('Bolt app is running!');
  } catch (error) {
    console.error('Error starting Bolt app:', error);
  }
};

handler();