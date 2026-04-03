/**
 * Chat Schema Re-exports
 *
 * Re-exports Zod schemas from @nextgenchat/types for route validation.
 * Single source of truth is packages/types — never redefine here.
 */

export {
  CreateWorkspaceSchema,
  CreateChannelSchema,
  SendMessageSchema,
  EditMessageSchema,
  MessagePaginationSchema,
  AddReactionSchema,
  ChannelType,
  SenderType,
  ContentType,
  type CreateWorkspaceInput,
  type CreateChannelInput,
  type SendMessageInput,
  type EditMessageInput,
  type MessagePaginationInput,
  type AddReactionInput,
} from '@nextgenchat/types';
