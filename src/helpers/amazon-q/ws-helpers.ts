import { WebClient } from '@slack/web-api';
import { getMarkdownBlock } from '../slack/slack-helpers';
import { chatDependencies } from '../chat';
import { SlackEventsEnv } from '@src/functions/ws-app-handler';
import { FailedAttachmentEvent, TextOutputEvent, SourceAttribution } from '@aws-sdk/client-qbusiness';
import { hasTable, convertHN, getTablePrefix,parseTable, getTable } from '@helpers/amazon-q/amazon-q-helpers';
import { createButton } from '@src/helpers/slack/slack-helpers';
import { Block } from '@slack/web-api';
import {
    Credentials,
  } from 'aws-sdk';

  import { QBusinessClient } from '@aws-sdk/client-qbusiness';

export enum SLACK_ACTION {
    VIEW_SOURCES,
    FEEDBACK_DOWN,
    FEEDBACK_UP,
    SIGN_IN
  }

import {
    openModal,
    createModal,
    getSlackSecret,
    getMarkdownBlocks,
    validateSlackRequest,
  } from '@src/helpers/slack/slack-helpers';
export const ERROR_MSG = '*_Processing error_*';

// Function to post an initial processing message to Slack
export const postProcessingMessage = async (wsApp: WebClient , event: any) => {
  return await wsApp.chat.postMessage({
    channel: event.channel,
    text: `Processing...`,
    blocks: [getMarkdownBlock(`Processing...`)],
    thread_ts: event.thread_ts ?? undefined,
  });
};

// Function to update Slack message
export const updateSlackMessage = async (wsApp: WebClient, channel: string, ts: string, text: string, blocks?: any[]) => {
  return await wsApp.chat.update({
    channel: channel,
    ts: ts,
    text: text,
    blocks: blocks,
  });
};

// Function to handle error message
export const handleErrorMessage = async (wsApp: WebClient, channel: string, ts: string, errorMsg: string) => {
  const errMsgWithDetails = `${ERROR_MSG}\n_${errorMsg}_`;
  const blocks = [getMarkdownBlock(errMsgWithDetails)];
  await updateSlackMessage(wsApp, channel, ts, errMsgWithDetails, blocks);
};

// Function to handle failed attachments
export const handleFailedAttachment = (failedAttachment?: FailedAttachmentEvent) => {
  if (!failedAttachment || failedAttachment.attachment === undefined) {
    return '';
  }

  const name = failedAttachment.attachment.name;
  const error = failedAttachment.attachment.error;
  const errorMessage = error?.errorMessage || 'Unknown error';

  console.debug(`Failed attachment: File ${name} - ${errorMessage}`);

  return `*_Failed attachment:_*\n \u2022 ${name}: ${errorMessage}`;
};

// Function to calculate response time
export const calculateResponseTime = (startTime: Date, endTime: Date) => {
  return Math.abs(endTime.getTime() - startTime.getTime()) / 1000;
};

// Expire function
const expireAt = (env: SlackEventsEnv) => {
  const contextTTL = Number(env.CONTEXT_DAYS_TO_LIVE) * 24 * 60 * 60 * 1000; // milliseconds
  return Math.floor((Date.now() + contextTTL) / 1000); // Unix time (seconds);
};

// Function to save channel metadata
export const saveChannelMetadata = async (channel: string, conversationId: string, systemMessageId: string, env: SlackEventsEnv) => {
  await chatDependencies.putItem({
    TableName: env.CACHE_TABLE_NAME,
    Item: {
      channel,
      conversationId,
      systemMessageId,
      latestTs: Date.now(),
      expireAt: expireAt(env),
    },
  });
};

// Function to save message metadata
export const saveMessageMetadata = async (textEvent: TextOutputEvent, sourceAttributions: SourceAttribution[], env: SlackEventsEnv) => {
  await chatDependencies.putItem({
    TableName: env.MESSAGE_METADATA_TABLE_NAME,
    Item: {
      messageId: textEvent.systemMessageId,
      conversationId: textEvent.conversationId,
      sourceAttributions: sourceAttributions,
      systemMessageId: textEvent.systemMessageId,
      userMessageId: textEvent.userMessageId,
      ts: Date.now(),
      expireAt: expireAt(env),
    },
  });
};

// Function to get message metadata
export const getMessageMetadata = async (systemMessageId: string, env: SlackEventsEnv) => {
  return (
    await chatDependencies.getItem({
      TableName: env.MESSAGE_METADATA_TABLE_NAME,
      Key: {
        messageId: systemMessageId,
      },
    })
  ).Item;
};

// Function to get channel metadata
export const getChannelMetadata = async (channel: string, env: SlackEventsEnv) => {
  return (
    await chatDependencies.getItem({
      TableName: env.CACHE_TABLE_NAME,
      Key: {
        channel: channel,
      },
    })
  ).Item;
};

// Function to delete channel metadata
export const deleteChannelMetadata = async (channel: string, env: SlackEventsEnv) => {
  await chatDependencies.deleteItem({
    TableName: env.CACHE_TABLE_NAME,
    Key: {
      channel,
    },
  });
};

// Function to convert response content to Slack blocks
export const testGetResponseAsBlocks = (content: string, MessageId: string, sourceAttributions?: SourceAttribution[]) => {
  if (!content) {
    return [];
  }

  const res = []
  res.push(...(!hasTable(content)
    ? getMarkdownBlocks(convertHN(content))
    : getMarkdownBlocks(
        `${convertHN(getTablePrefix(content))}\n\n${parseTable(getTable(content))}`
      )))

  if (sourceAttributions) {
     res.push(...[createButton('View source(s)', MessageId ?? '')])
  }

  return res
}

export const getFeedbackBlocks = (textEvent: TextOutputEvent): Block[] => {
    if (!textEvent) {
      return [];
    }
    console.log('GET FEEDBACK BLOCKS')
    console.log(JSON.stringify(textEvent))
  
    return [
      {
        type: 'actions',
        block_id: `feedback-${textEvent.conversationId}-${textEvent.systemMessageId}`,
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              emoji: true,
              text: ':thumbsup:',
            },
            style: 'primary',
            action_id: SLACK_ACTION[SLACK_ACTION.FEEDBACK_UP],
            value: textEvent.systemMessageId,
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              emoji: true,
              text: ':thumbsdown:',
            },
            style: 'danger',
            action_id: SLACK_ACTION[SLACK_ACTION.FEEDBACK_DOWN],
            value: textEvent.systemMessageId,
          },
        ],
      } as Block,
    ];
  };

  export const getClient = (env: SlackEventsEnv, iamSessionCreds: Credentials) => {
   
      return new QBusinessClient({
        credentials: iamSessionCreds,
        region: env.AMAZON_Q_REGION
      });
    }