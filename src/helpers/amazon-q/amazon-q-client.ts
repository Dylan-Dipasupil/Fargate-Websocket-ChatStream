import { SlackEventsEnv } from '@functions/slack-event-handler';
import { SlackInteractionsEnv } from '@functions/slack-interaction-handler';
import { makeLogger } from '@src/logging';
import { v4 as uuid } from 'uuid';
import {
  AttachmentInput,
  ChatCommand,
  ChatCommandOutput,
  MessageUsefulness,
  MessageUsefulnessReason,
  PutFeedbackCommand,
  PutFeedbackCommandInput,
  PutFeedbackCommandOutput,
  QBusinessClient
} from '@aws-sdk/client-qbusiness';
import { Credentials } from 'aws-sdk';

const logger = makeLogger('amazon-q-client');

const amazonQClientBySlackUserId: { [key: string]: QBusinessClient } = {};

export const getClient = (
  env: SlackEventsEnv,
  slackUserId: string,
  iamSessionCreds: Credentials
) => {
  logger.debug(`Initiating AmazonQ client with region ${env.AMAZON_Q_REGION}`);
  // if (amazonQClientBySlackUserId[slackUserId]) {
  //   return amazonQClientBySlackUserId[slackUserId];
  // }

  const newClient = new QBusinessClient({
    credentials: iamSessionCreds,
    region: env.AMAZON_Q_REGION
  });

  amazonQClientBySlackUserId[slackUserId] = newClient;

  return newClient;
};

export const callClient = async (
  message: string,
  attachments: AttachmentInput[],
  env: SlackEventsEnv,
  iamSessionCreds: Credentials,
  userID: string,
  context?: {
    conversationId: string;
    parentMessageId: string;
  },
): Promise<ChatCommandOutput> => {
  const input = {
    applicationId: env.AMAZON_Q_APP_ID,
    clientToken: uuid(),
    ... context,
    inputStream: (async function* () {
      yield { textEvent: { userMessage: message } };
      for (const attachment of attachments) {
        yield { attachmentEvent: { attachment } };
      }
      yield { endOfInputEvent: {} };
    })(),
  };

  logger.debug(`callClient input ${JSON.stringify(input)}`);
  return await getClient(env, userID, iamSessionCreds).send(new ChatCommand(input));
  
};

export const submitFeedbackRequest = async (
  slackUserId: string,
  env: SlackInteractionsEnv,
  iamSessionCreds: Credentials,
  context: {
    conversationId: string;
    messageId: string;
  },
  usefulness: MessageUsefulness,
  reason: MessageUsefulnessReason,
  submittedAt: string
): Promise<PutFeedbackCommandOutput> => {
  const input: PutFeedbackCommandInput = {
    applicationId: env.AMAZON_Q_APP_ID,
    ...context,
    messageUsefulness: {
      usefulness: usefulness,
      reason: reason,
      // Slack ts format E.g. 1702282895.883219
      submittedAt: new Date(Number(submittedAt) * 1000)
    }
  };

  logger.debug(`putFeedbackRequest input ${JSON.stringify(input)}`);
  const response = await getClient(env, slackUserId, iamSessionCreds).send(
    new PutFeedbackCommand(input)
  );
  logger.debug(`putFeedbackRequest output ${JSON.stringify(response)}`);

  return response;
};
